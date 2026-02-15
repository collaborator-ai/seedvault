import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync } from "fs";
import { rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";

import { SeedvaultClient } from "../src/client.js";
import { SeedvaultError } from "../src/error.js";
import { initDb } from "../../../server/src/db.js";
import { createApp } from "../../../server/src/routes.js";

let server: ReturnType<typeof Bun.serve>;
let baseUrl: string;
let adminToken: string;
let dataDir: string;

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "sdk-test-"));
  initDb(join(dataDir, "seedvault.db"));

  const app = createApp();
  server = Bun.serve({ port: 0, fetch: app.fetch });
  baseUrl = `http://localhost:${server.port}`;

  // Create first user (admin, no invite needed)
  const res = await fetch(`${baseUrl}/v1/signup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "admin" }),
  });
  const data = (await res.json()) as { token: string };
  adminToken = data.token;
});

afterAll(async () => {
  server?.stop(true);
  await rm(dataDir, { recursive: true, force: true }).catch(() => {});
});

describe("SeedvaultClient", () => {
  // --- Auth ---

  test("me() returns authenticated user", async () => {
    const client = new SeedvaultClient({ baseUrl, token: adminToken });
    const me = await client.me();
    expect(me.username).toBe("admin");
    expect(me.createdAt).toBeDefined();
  });

  test("me() throws SeedvaultError without token", async () => {
    const client = new SeedvaultClient({ baseUrl });
    await expect(client.me()).rejects.toThrow(SeedvaultError);
  });

  test("signup() creates a new contributor", async () => {
    const client = new SeedvaultClient({ baseUrl, token: adminToken });

    // Admin creates invite first
    const invite = await client.createInvite();
    expect(invite.invite).toBeDefined();

    // Sign up new user with invite
    const noAuthClient = new SeedvaultClient({ baseUrl });
    const result = await noAuthClient.signup("newuser", invite.invite);
    expect(result.contributor.username).toBe("newuser");
    expect(result.token).toBeDefined();
    expect(result.token.startsWith("sv_")).toBe(true);
  });

  test("health() returns true", async () => {
    const client = new SeedvaultClient({ baseUrl });
    const ok = await client.health();
    expect(ok).toBe(true);
  });

  // --- Contributors ---

  test("listContributors() returns all users", async () => {
    const client = new SeedvaultClient({ baseUrl, token: adminToken });
    const contributors = await client.listContributors();
    expect(contributors.length).toBeGreaterThanOrEqual(1);
    expect(contributors.some((c) => c.username === "admin")).toBe(true);
  });

  // --- Files ---

  test("writeFile() + readFile() round-trip", async () => {
    const client = new SeedvaultClient({ baseUrl, token: adminToken });
    await client.writeFile("admin/test.md", "# Hello");
    const file = await client.readFile("admin/test.md");
    expect(file.content).toBe("# Hello");
    expect(file.path).toBe("admin/test.md");
    expect(file.createdAt).toBeTruthy();
    expect(file.modifiedAt).toBeTruthy();
  });

  test("listFiles() returns written file", async () => {
    const client = new SeedvaultClient({ baseUrl, token: adminToken });
    const files = await client.listFiles("admin/");
    expect(files.length).toBeGreaterThan(0);
    expect(files.some((f) => f.path === "admin/test.md")).toBe(true);
  });

  test("readFile() throws SeedvaultError for missing file", async () => {
    const client = new SeedvaultClient({ baseUrl, token: adminToken });
    await expect(
      client.readFile("admin/nonexistent.md"),
    ).rejects.toThrow(SeedvaultError);
  });

  test("deleteFile() removes file", async () => {
    const client = new SeedvaultClient({ baseUrl, token: adminToken });

    // Write a file to delete
    await client.writeFile("admin/to-delete.md", "bye");
    await client.deleteFile("admin/to-delete.md");

    const files = await client.listFiles("admin/");
    expect(files.some((f) => f.path === "admin/to-delete.md")).toBe(false);
  });

  // --- Search ---

  test("search() finds file content", async () => {
    const client = new SeedvaultClient({ baseUrl, token: adminToken });
    const results = await client.search("Hello");
    expect(results.length).toBeGreaterThan(0);
  });

  // --- Activity ---

  test("getActivity() returns events", async () => {
    const client = new SeedvaultClient({ baseUrl, token: adminToken });
    const events = await client.getActivity();
    expect(events.length).toBeGreaterThan(0);
    expect(events[0]!.contributor).toBe("admin");
  });

  test("getActivity() supports filtering", async () => {
    const client = new SeedvaultClient({ baseUrl, token: adminToken });
    const events = await client.getActivity({
      action: "file_upserted",
      limit: 5,
    });
    for (const e of events) {
      expect(e.action).toBe("file_upserted");
    }
  });
});
