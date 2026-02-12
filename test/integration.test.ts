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
let username: string;
const TEST_CONTRIBUTOR_NAME = "test-contributor";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Poll until a file path appears in the contributor's file listing. */
async function waitForFile(
  cl: SeedvaultClient,
  username: string,
  path: string,
  timeoutMs = 5000
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const { files } = await cl.listFiles(username);
    if (files.some((f) => f.path === path)) return;
    await Bun.sleep(100);
  }
  throw new Error(`Timed out waiting for file: ${path}`);
}

/** Poll until a file path disappears from the contributor's file listing. */
async function waitForDelete(
  cl: SeedvaultClient,
  username: string,
  path: string,
  timeoutMs = 5000
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const { files } = await cl.listFiles(username);
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
    const syncHandler = createSyncHandler(client, username);
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
function createSyncHandler(cl: SeedvaultClient, username: string) {
  return async (event: FileEvent) => {
    if (event.type === "add" || event.type === "change") {
      const content = readFileSync(event.localPath, "utf-8");
      await cl.putFile(username, event.serverPath, content);
    } else if (event.type === "unlink") {
      await cl.deleteFile(username, event.serverPath).catch((e) => {
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
  username = signup.contributor.username;

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
    expect(username).toBe(TEST_CONTRIBUTOR_NAME);
  });

  test("GET /v1/contributors returns the created contributor", async () => {
    const { contributors } = await client.listContributors();
    expect(contributors.length).toBeGreaterThanOrEqual(1);
    expect(contributors.some((contributor) => contributor.username === username)).toBe(true);
  });

  test("PUT + GET a file roundtrips content", async () => {
    const path = "test/hello.md";
    const content = "# Hello\n\nWorld.\n";

    const putRes = await client.putFile(username, path, content);
    expect(putRes.path).toBe(path);
    expect(putRes.size).toBe(content.length);

    const got = await client.getFile(username, path);
    expect(got).toBe(content);
  });

  test("DELETE removes a file", async () => {
    const path = "test/to-delete.md";
    await client.putFile(username, path, "bye");
    await client.deleteFile(username, path);

    const err = await client.getFile(username, path).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(404);
  });

  test("listFiles returns uploaded files", async () => {
    const { files } = await client.listFiles(username, "test/");
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
    ["emoji", "special/emoji \u{1F680}.md"],
    ["unicode", "special/unicode \u6587\u6863.md"],
  ];

  for (const [caseLabel, path] of cases) {
    test(`roundtrips file with ${caseLabel} in path`, async () => {
      const content = `# ${caseLabel}\n\nContent for ${caseLabel} test.\n`;
      await client.putFile(username, path, content);
      const got = await client.getFile(username, path);
      expect(got).toBe(content);
    });
  }

  test("listFiles includes special-char files", async () => {
    const { files } = await client.listFiles(username, "special/");
    const paths = files.map((f) => f.path);
    expect(paths).toContain("special/with spaces.md");
    expect(paths).toContain("special/colon: test.md");
    expect(paths).toContain("special/brackets [test].md");
    expect(paths).toContain("special/emoji \u{1F680}.md");
    expect(paths).toContain("special/unicode \u6587\u6863.md");
  });

  test("DELETE works with special characters", async () => {
    const path = "special/delete spaces.md";
    await client.putFile(username, path, "temp");
    await client.deleteFile(username, path);

    const err = await client.getFile(username, path).catch((e) => e);
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

    await waitForFile(client, username, `${collectionName}/hello.md`);
    const content = await client.getFile(username, `${collectionName}/hello.md`);
    expect(content).toBe("# Hello from watcher\n");
  });

  test("syncs nested subfolder file", async () => {
    const nested = join(ctx.watchDir, "sub", "folder");
    await mkdir(nested, { recursive: true });
    await writeFile(join(nested, "deep.md"), "# Deep\n");

    await waitForFile(client, username, `${collectionName}/sub/folder/deep.md`);
    const content = await client.getFile(username, `${collectionName}/sub/folder/deep.md`);
    expect(content).toBe("# Deep\n");
  });

  test("detects file modification", async () => {
    await Bun.sleep(100);
    await writeFile(join(ctx.watchDir, "hello.md"), "# Hello updated\n");

    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const content = await client.getFile(username, `${collectionName}/hello.md`);
      if (content === "# Hello updated\n") return;
      await Bun.sleep(100);
    }
    throw new Error("File content did not update in time");
  });

  test("detects file deletion", async () => {
    await rm(join(ctx.watchDir, "hello.md"));

    await waitForDelete(client, username, `${collectionName}/hello.md`);

    const err = await client.getFile(username, `${collectionName}/hello.md`).catch((e) => e);
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
    ["emoji", "emoji \u{1F680}.md", "# Emoji\n"],
    ["unicode", "unicode \u6587\u6863.md", "# Unicode\n"],
  ];

  for (const [desc, filename, content] of specialFiles) {
    test(`syncs file with ${desc} via watcher`, async () => {
      await writeFile(join(ctx.watchDir, filename), content);
      await waitForFile(client, username, `${collectionName}/${filename}`);
      const got = await client.getFile(username, `${collectionName}/${filename}`);
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

    await waitForFile(client, username, `${collectionName}/a/b/c/deep.md`);
    const content = await client.getFile(username, `${collectionName}/a/b/c/deep.md`);
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
      waitForFile(client, username, `${collectionName}/root.md`),
      waitForFile(client, username, `${collectionName}/x/mid.md`),
      waitForFile(client, username, `${collectionName}/x/y/leaf.md`),
    ]);

    const [root, mid, leaf] = await Promise.all([
      client.getFile(username, `${collectionName}/root.md`),
      client.getFile(username, `${collectionName}/x/mid.md`),
      client.getFile(username, `${collectionName}/x/y/leaf.md`),
    ]);

    expect(root).toBe("# Root\n");
    expect(mid).toBe("# Mid\n");
    expect(leaf).toBe("# Leaf\n");
  });
});

// ---------------------------------------------------------------------------
// Shell endpoint
// ---------------------------------------------------------------------------

describe("shell endpoint", () => {
  test("sh('ls') lists contributors", async () => {
    const output = await client.sh("ls");
    expect(output).toContain(username);
  });

  test("sh('cat username/path') reads a file", async () => {
    // "test/hello.md" was uploaded in the API basics tests
    const output = await client.sh(`cat ${username}/test/hello.md`);
    expect(output).toBe("# Hello\n\nWorld.\n");
  });

  test("sh('find') finds files", async () => {
    const output = await client.sh(`find ${username} -name "*.md"`);
    expect(output).toContain("hello.md");
  });

  test("sh('grep') searches across files", async () => {
    const output = await client.sh(`grep -r "Hello" ${username}/test/`);
    expect(output).toContain("hello.md");
  });

  test("rejects non-whitelisted commands", async () => {
    const err = await client.sh("rm -rf /").catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(400);
  });

  test("rejects path traversal", async () => {
    const err = await client.sh("cat ../../../etc/passwd").catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(400);
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
    await waitForFile(client, username, `${collectionName}/doomed.md`);

    await rm(join(ctx.watchDir, "doomed.md"));
    await waitForDelete(client, username, `${collectionName}/doomed.md`);

    const err = await client.getFile(username, `${collectionName}/doomed.md`).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(404);
  });

  test("deleting a directory removes all files within it", async () => {
    const subDir = join(ctx.watchDir, "toRemove");
    await mkdir(subDir, { recursive: true });
    await writeFile(join(subDir, "a.md"), "# A\n");
    await writeFile(join(subDir, "b.md"), "# B\n");

    await waitForFile(client, username, `${collectionName}/toRemove/a.md`);
    await waitForFile(client, username, `${collectionName}/toRemove/b.md`);

    await rm(subDir, { recursive: true });

    await waitForDelete(client, username, `${collectionName}/toRemove/a.md`);
    await waitForDelete(client, username, `${collectionName}/toRemove/b.md`);
  });
});

// ---------------------------------------------------------------------------
// Origin timestamps
// ---------------------------------------------------------------------------

describe("origin timestamps", () => {
  test("PUT returns origin timestamps when headers sent", async () => {
    const ctime = "2024-06-15T10:30:00.000Z";
    const mtime = "2024-07-20T14:45:00.000Z";

    const res = await client.putFile(username, "ts/with-headers.md", "# Timestamped\n", {
      originCtime: ctime,
      originMtime: mtime,
    });

    expect(res.originCtime).toBe(ctime);
    expect(res.originMtime).toBe(mtime);
    expect(res.serverCreatedAt).toBeDefined();
    expect(res.serverModifiedAt).toBeDefined();
  });

  test("PUT without headers uses server fallback", async () => {
    const before = new Date().toISOString();
    const res = await client.putFile(username, "ts/no-headers.md", "# No headers\n");
    const after = new Date().toISOString();

    expect(res.originCtime).toBeDefined();
    expect(res.originMtime).toBeDefined();
    // Fallback timestamps should be approximately now
    expect(res.originCtime! >= before).toBe(true);
    expect(res.originMtime! <= after).toBe(true);
  });

  test("origin_ctime preserved on update, origin_mtime updated", async () => {
    const ctime1 = "2024-01-01T00:00:00.000Z";
    const mtime1 = "2024-01-01T12:00:00.000Z";
    const res1 = await client.putFile(username, "ts/update-test.md", "# V1\n", {
      originCtime: ctime1,
      originMtime: mtime1,
    });

    await Bun.sleep(50); // ensure server_modified_at differs

    const ctime2 = "2024-06-01T00:00:00.000Z";
    const mtime2 = "2024-06-15T09:00:00.000Z";
    const res2 = await client.putFile(username, "ts/update-test.md", "# V2\n", {
      originCtime: ctime2,
      originMtime: mtime2,
    });

    // origin_ctime preserved from first upload
    expect(res2.originCtime).toBe(ctime1);
    // origin_mtime updated to second upload's value
    expect(res2.originMtime).toBe(mtime2);
    // server_created_at preserved
    expect(res2.serverCreatedAt).toBe(res1.serverCreatedAt);
    // server_modified_at advanced
    expect(res2.serverModifiedAt! > res1.serverModifiedAt!).toBe(true);
  });

  test("listFiles returns origin timestamps", async () => {
    const { files } = await client.listFiles(username, "ts/");
    const f = files.find((f) => f.path === "ts/with-headers.md");
    expect(f).toBeDefined();
    expect(f!.originCtime).toBe("2024-06-15T10:30:00.000Z");
    expect(f!.originMtime).toBe("2024-07-20T14:45:00.000Z");
    expect(f!.serverCreatedAt).toBeDefined();
    expect(f!.serverModifiedAt).toBeDefined();
  });

  test("delete removes metadata, re-upload gets fresh ctime", async () => {
    const ctime1 = "2023-01-01T00:00:00.000Z";
    await client.putFile(username, "ts/delete-reup.md", "# First\n", {
      originCtime: ctime1,
      originMtime: "2023-01-01T12:00:00.000Z",
    });

    await client.deleteFile(username, "ts/delete-reup.md");

    const ctime2 = "2025-01-01T00:00:00.000Z";
    const mtime2 = "2025-01-01T12:00:00.000Z";
    const res = await client.putFile(username, "ts/delete-reup.md", "# Second\n", {
      originCtime: ctime2,
      originMtime: mtime2,
    });

    // Fresh ctime — not the old one
    expect(res.originCtime).toBe(ctime2);
    expect(res.originMtime).toBe(mtime2);
  });

  test("millisecond precision preserved", async () => {
    const ctime = "2024-03-15T08:30:45.123Z";
    const mtime = "2024-04-20T16:15:30.456Z";

    const res = await client.putFile(username, "ts/precision.md", "# Precise\n", {
      originCtime: ctime,
      originMtime: mtime,
    });

    expect(res.originCtime).toBe(ctime);
    expect(res.originMtime).toBe(mtime);

    // Verify through listing as well
    const { files } = await client.listFiles(username, "ts/");
    const f = files.find((f) => f.path === "ts/precision.md");
    expect(f!.originCtime).toBe(ctime);
    expect(f!.originMtime).toBe(mtime);
  });

  test("multiple rapid updates preserve original ctime", async () => {
    const originalCtime = "2024-01-01T00:00:00.000Z";
    let lastMtime = "";

    for (let i = 0; i < 5; i++) {
      lastMtime = `2024-0${i + 1}-15T12:00:00.000Z`;
      await client.putFile(username, "ts/rapid.md", `# Version ${i + 1}\n`, {
        originCtime: `2024-0${i + 1}-01T00:00:00.000Z`,
        originMtime: lastMtime,
      });
    }

    const { files } = await client.listFiles(username, "ts/");
    const f = files.find((f) => f.path === "ts/rapid.md");
    expect(f!.originCtime).toBe(originalCtime);
    expect(f!.originMtime).toBe(lastMtime);
  });

  test("files uploaded without headers still have fallback timestamps in listings", async () => {
    const before = new Date().toISOString();
    await client.putFile(username, "ts/legacy.md", "# Legacy client\n");

    const { files } = await client.listFiles(username, "ts/");
    const f = files.find((f) => f.path === "ts/legacy.md");
    expect(f).toBeDefined();
    expect(f!.originCtime).toBeDefined();
    expect(f!.originMtime).toBeDefined();
    expect(f!.serverCreatedAt).toBeDefined();
    expect(f!.serverModifiedAt).toBeDefined();
    // Fallback timestamps should be >= before
    expect(f!.originCtime! >= before).toBe(true);
  });
});
