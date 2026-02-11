/**
 * Integration tests for Seedvault.
 *
 * Runs the server in-process (Bun.serve + createApp), then exercises
 * the API client, watcher, and syncer pipeline against it.
 *
 * The CLI modules never import server/src/db.ts, so there's no shared
 * singleton conflict — the CLI talks to the server via HTTP only.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, readFileSync } from "fs";
import { mkdir, writeFile, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";

// Server modules — safe to import statically.
import { initDb } from "../server/src/db.js";
import { createApp } from "../server/src/routes.js";

// Client module.
import { createClient, type SeedvaultClient, ApiError } from "../cli/src/client.js";

// Watcher module — doesn't use config.ts, safe to import statically.
import { createWatcher, type FileEvent } from "../cli/src/daemon/watcher.js";
import type { CollectionConfig } from "../cli/src/config.js";

// NOTE: We don't import Syncer here so tests can isolate watcher behavior
// from queue/retry behavior; we handle watcher events directly via the API.

// ---------------------------------------------------------------------------
// Globals set in beforeAll
// ---------------------------------------------------------------------------

let server: ReturnType<typeof Bun.serve>;
let serverDataDir: string;
let client: SeedvaultClient;
let contributorId: string;
const TEST_CONTRIBUTOR_NAME = "test-contributor";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Poll until a file path appears in the contributor's file listing. */
async function waitForFile(
  cl: SeedvaultClient,
  contributorId: string,
  path: string,
  timeoutMs = 5000
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const { files } = await cl.listFiles(contributorId);
    if (files.some((f) => f.path === path)) return;
    await Bun.sleep(100);
  }
  throw new Error(`Timed out waiting for file: ${path}`);
}

/** Poll until a file path disappears from the contributor's file listing. */
async function waitForDelete(
  cl: SeedvaultClient,
  contributorId: string,
  path: string,
  timeoutMs = 5000
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const { files } = await cl.listFiles(contributorId);
      if (!files.some((f) => f.path === path)) return;
    } catch (e) {
      // listFiles can 500 if the directory was cleaned up mid-walk;
      // treat this as "still settling" and keep polling.
      if (e instanceof ApiError && e.status >= 500) continue;
      throw e;
    }
    await Bun.sleep(100);
  }
  throw new Error(`Timed out waiting for delete: ${path}`);
}

/** Create a temp directory and return its path. */
function makeTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** Set up a watcher with a temp directory and sync handler. */
function setupWatcher(collectionName: string, tmpPrefix: string) {
  let watchDir: string;
  let watcher: ReturnType<typeof createWatcher>;
  const pendingSyncs = new Set<Promise<void>>();

  beforeAll(async () => {
    watchDir = makeTempDir(tmpPrefix);
    const collections: CollectionConfig[] = [{ path: watchDir, name: collectionName }];
    const syncHandler = createSyncHandler(client, contributorId);
    watcher = createWatcher(collections, (event) => {
      // Track in-flight sync tasks so teardown can await them and avoid
      // late requests racing against server shutdown.
      let task: Promise<void>;
      task = syncHandler(event).finally(() => {
        pendingSyncs.delete(task);
      });
      pendingSyncs.add(task);
    });
    await new Promise<void>((resolve) => watcher.on("ready", resolve));
  });

  afterAll(async () => {
    if (watcher) await watcher.close();
    await Promise.allSettled(Array.from(pendingSyncs));
    await rm(watchDir, { recursive: true, force: true }).catch(() => {});
  });

  return { get watchDir() { return watchDir; } };
}

/** Best-effort cleanup of QMD collection state used by integration tests. */
async function cleanupQmdCollection(name: string): Promise<void> {
  try {
    const proc = Bun.spawn(["qmd", "collection", "remove", name], {
      stdout: "ignore",
      stderr: "ignore",
    });
    await proc.exited;
  } catch {
    // Ignore cleanup failures (e.g., qmd unavailable).
  }
}

/**
 * Direct sync handler: processes watcher events by calling the API directly.
 * Replaces Syncer+RetryQueue for test isolation.
 */
function createSyncHandler(cl: SeedvaultClient, contributorId: string) {
  return async (event: FileEvent) => {
    if (event.type === "add" || event.type === "change") {
      const content = readFileSync(event.localPath, "utf-8");
      await cl.putFile(contributorId, event.serverPath, content);
    } else if (event.type === "unlink") {
      await cl.deleteFile(contributorId, event.serverPath).catch((e) => {
        // Ignore 404 — file may not have been synced yet
        if (e instanceof ApiError && e.status === 404) return;
        throw e;
      });
    }
  };
}

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

beforeAll(async () => {
  // 1. Set up server data directory and database
  serverDataDir = makeTempDir("sv-test-data-");
  const storageRoot = join(serverDataDir, "files");
  await mkdir(storageRoot, { recursive: true });
  initDb(join(serverDataDir, "seedvault.db"));

  // 2. Create and start the server on a random port
  const app = createApp(storageRoot);
  server = Bun.serve({
    port: 0,
    fetch: app.fetch,
  });

  const baseUrl = `http://127.0.0.1:${server.port}`;

  // 3. Sign up (first user — no invite needed)
  const anonClient = createClient(baseUrl);
  const signup = await anonClient.signup(TEST_CONTRIBUTOR_NAME);
  contributorId = signup.contributor.id;

  // 4. Create authenticated client
  client = createClient(baseUrl, signup.token);
}, 10_000);

afterAll(async () => {
  await cleanupQmdCollection(TEST_CONTRIBUTOR_NAME);
  if (server) server.stop(true);
  await rm(serverDataDir, { recursive: true, force: true }).catch(() => {});
});

// ---------------------------------------------------------------------------
// API basics
// ---------------------------------------------------------------------------

describe("API basics", () => {
  test("signup created a contributor", () => {
    expect(contributorId).toMatch(/^contributor_/);
  });

  test("GET /v1/contributors returns the created contributor", async () => {
    const { contributors } = await client.listContributors();
    expect(contributors.length).toBeGreaterThanOrEqual(1);
    expect(contributors.some((contributor) => contributor.id === contributorId)).toBe(true);
  });

  test("PUT + GET a file roundtrips content", async () => {
    const path = "test/hello.md";
    const content = "# Hello\n\nWorld.\n";

    const putRes = await client.putFile(contributorId, path, content);
    expect(putRes.path).toBe(path);
    expect(putRes.size).toBe(content.length);

    const got = await client.getFile(contributorId, path);
    expect(got).toBe(content);
  });

  test("DELETE removes a file", async () => {
    const path = "test/to-delete.md";
    await client.putFile(contributorId, path, "bye");
    await client.deleteFile(contributorId, path);

    const err = await client.getFile(contributorId, path).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(404);
  });

  test("listFiles returns uploaded files", async () => {
    const { files } = await client.listFiles(contributorId, "test/");
    expect(files.some((f) => f.path === "test/hello.md")).toBe(true);
  });

  test("second signup requires invite", async () => {
    const baseUrl = `http://127.0.0.1:${server.port}`;
    const anon = createClient(baseUrl);
    const err = await anon.signup("second-contributor").catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// API special characters
// ---------------------------------------------------------------------------

describe("API special characters", () => {
  const cases: [string, string][] = [
    ["spaces", "special/with spaces.md"],
    ["colon", "special/colon: test.md"],
    ["brackets", "special/brackets [test].md"],
    ["emoji", "special/emoji 🚀.md"],
    ["unicode", "special/unicode 文档.md"],
  ];

  for (const [caseLabel, path] of cases) {
    test(`roundtrips file with ${caseLabel} in path`, async () => {
      const content = `# ${caseLabel}\n\nContent for ${caseLabel} test.\n`;
      await client.putFile(contributorId, path, content);
      const got = await client.getFile(contributorId, path);
      expect(got).toBe(content);
    });
  }

  test("listFiles includes special-char files", async () => {
    const { files } = await client.listFiles(contributorId, "special/");
    const paths = files.map((f) => f.path);
    expect(paths).toContain("special/with spaces.md");
    expect(paths).toContain("special/colon: test.md");
    expect(paths).toContain("special/brackets [test].md");
    expect(paths).toContain("special/emoji 🚀.md");
    expect(paths).toContain("special/unicode 文档.md");
  });

  test("DELETE works with special characters", async () => {
    const path = "special/delete spaces.md";
    await client.putFile(contributorId, path, "temp");
    await client.deleteFile(contributorId, path);

    const err = await client.getFile(contributorId, path).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Watcher sync
// ---------------------------------------------------------------------------

describe("watcher sync", () => {
  const collectionName = "watch-test";
  const ctx = setupWatcher(collectionName, "sv-test-watch-");

  test("picks up new file", async () => {
    await writeFile(join(ctx.watchDir, "hello.md"), "# Hello from watcher\n");

    await waitForFile(client, contributorId, `${collectionName}/hello.md`);
    const content = await client.getFile(contributorId, `${collectionName}/hello.md`);
    expect(content).toBe("# Hello from watcher\n");
  });

  test("syncs nested subfolder file", async () => {
    const nested = join(ctx.watchDir, "sub", "folder");
    await mkdir(nested, { recursive: true });
    await writeFile(join(nested, "deep.md"), "# Deep\n");

    await waitForFile(client, contributorId, `${collectionName}/sub/folder/deep.md`);
    const content = await client.getFile(contributorId, `${collectionName}/sub/folder/deep.md`);
    expect(content).toBe("# Deep\n");
  });

  test("detects file modification", async () => {
    await Bun.sleep(100);
    await writeFile(join(ctx.watchDir, "hello.md"), "# Hello updated\n");

    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const content = await client.getFile(contributorId, `${collectionName}/hello.md`);
      if (content === "# Hello updated\n") return;
      await Bun.sleep(100);
    }
    throw new Error("File content did not update in time");
  });

  test("detects file deletion", async () => {
    await rm(join(ctx.watchDir, "hello.md"));

    await waitForDelete(client, contributorId, `${collectionName}/hello.md`);

    const err = await client.getFile(contributorId, `${collectionName}/hello.md`).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Watcher special characters
// ---------------------------------------------------------------------------

describe("watcher special characters", () => {
  const collectionName = "special-watch";
  const ctx = setupWatcher(collectionName, "sv-test-special-watch-");

  const specialFiles: [string, string, string][] = [
    ["spaces", "with spaces.md", "# Spaces\n"],
    ["colon", "colon: test.md", "# Colon\n"],
    ["brackets", "brackets [test].md", "# Brackets\n"],
    ["emoji", "emoji 🚀.md", "# Emoji\n"],
    ["unicode", "unicode 文档.md", "# Unicode\n"],
  ];

  for (const [desc, filename, content] of specialFiles) {
    test(`syncs file with ${desc} via watcher`, async () => {
      await writeFile(join(ctx.watchDir, filename), content);
      await waitForFile(client, contributorId, `${collectionName}/${filename}`);
      const got = await client.getFile(contributorId, `${collectionName}/${filename}`);
      expect(got).toBe(content);
    });
  }
});

// ---------------------------------------------------------------------------
// Watcher nested structures
// ---------------------------------------------------------------------------

describe("watcher nested structures", () => {
  const collectionName = "nested-watch";
  const ctx = setupWatcher(collectionName, "sv-test-nested-");

  test("syncs deeply nested file", async () => {
    const deepDir = join(ctx.watchDir, "a", "b", "c");
    await mkdir(deepDir, { recursive: true });
    await writeFile(join(deepDir, "deep.md"), "# Deep\n");

    await waitForFile(client, contributorId, `${collectionName}/a/b/c/deep.md`);
    const content = await client.getFile(contributorId, `${collectionName}/a/b/c/deep.md`);
    expect(content).toBe("# Deep\n");
  });

  test("syncs multiple files at different depths simultaneously", async () => {
    await mkdir(join(ctx.watchDir, "x"), { recursive: true });
    await mkdir(join(ctx.watchDir, "x", "y"), { recursive: true });

    await Promise.all([
      writeFile(join(ctx.watchDir, "root.md"), "# Root\n"),
      writeFile(join(ctx.watchDir, "x", "mid.md"), "# Mid\n"),
      writeFile(join(ctx.watchDir, "x", "y", "leaf.md"), "# Leaf\n"),
    ]);

    await Promise.all([
      waitForFile(client, contributorId, `${collectionName}/root.md`),
      waitForFile(client, contributorId, `${collectionName}/x/mid.md`),
      waitForFile(client, contributorId, `${collectionName}/x/y/leaf.md`),
    ]);

    const [root, mid, leaf] = await Promise.all([
      client.getFile(contributorId, `${collectionName}/root.md`),
      client.getFile(contributorId, `${collectionName}/x/mid.md`),
      client.getFile(contributorId, `${collectionName}/x/y/leaf.md`),
    ]);

    expect(root).toBe("# Root\n");
    expect(mid).toBe("# Mid\n");
    expect(leaf).toBe("# Leaf\n");
  });
});

// ---------------------------------------------------------------------------
// File deletes
// ---------------------------------------------------------------------------

describe("file deletes", () => {
  const collectionName = "delete-watch";
  const ctx = setupWatcher(collectionName, "sv-test-delete-");

  test("deleting a synced file removes it from server", async () => {
    await writeFile(join(ctx.watchDir, "doomed.md"), "# Doomed\n");
    await waitForFile(client, contributorId, `${collectionName}/doomed.md`);

    await rm(join(ctx.watchDir, "doomed.md"));
    await waitForDelete(client, contributorId, `${collectionName}/doomed.md`);

    const err = await client.getFile(contributorId, `${collectionName}/doomed.md`).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(404);
  });

  test("deleting a directory removes all files within it", async () => {
    const subDir = join(ctx.watchDir, "toRemove");
    await mkdir(subDir, { recursive: true });
    await writeFile(join(subDir, "a.md"), "# A\n");
    await writeFile(join(subDir, "b.md"), "# B\n");

    await waitForFile(client, contributorId, `${collectionName}/toRemove/a.md`);
    await waitForFile(client, contributorId, `${collectionName}/toRemove/b.md`);

    await rm(subDir, { recursive: true });

    await waitForDelete(client, contributorId, `${collectionName}/toRemove/a.md`);
    await waitForDelete(client, contributorId, `${collectionName}/toRemove/b.md`);
  });
});
