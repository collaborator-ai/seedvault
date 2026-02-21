import { describe, test, expect, beforeAll, afterAll } from "bun:test";

// We test the API server by starting it with a mock sync handle
// and making HTTP requests to it.

import { createDaemonServer } from "../client/src/daemon/api.js";
import { EventBus } from "../client/src/daemon/event-bus.js";
import type { FileEvent } from "../client/src/daemon/watcher.js";
import type { SyncStatus } from "../client/src/api/sync.js";
import type { Config } from "../client/src/config.js";

const TEST_PORT = 19847;

const mockConfig: Config = {
  server: "https://test.seedvault.dev",
  token: "sv_test_token",
  username: "testuser",
  collections: [
    { path: "/tmp/notes", name: "notes" },
  ],
};

const mockStatus: SyncStatus = {
  running: true,
  serverConnected: true,
  collectionsWatched: 1,
  pendingOps: 0,
  watcherAlive: true,
  lastSyncAt: "2026-02-20T23:00:00Z",
  lastReconcileAt: "2026-02-20T22:55:00Z",
};

const fileEvents = new EventBus<FileEvent>();

let server: ReturnType<typeof createDaemonServer>;

beforeAll(() => {
  server = createDaemonServer({
    port: TEST_PORT,
    getConfig: () => mockConfig,
    getStatus: () => mockStatus,
    fileEvents,
  });
});

afterAll(() => {
  server.stop();
});

const base = `http://localhost:${TEST_PORT}`;

describe("daemon API — local endpoints", () => {
  test("GET /status returns sync status", async () => {
    const res = await fetch(`${base}/status`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.running).toBe(true);
    expect(body.serverConnected).toBe(true);
    expect(body.username).toBe("testuser");
    expect(body.collectionsWatched).toBe(1);
  });

  test("GET /config returns config without token", async () => {
    const res = await fetch(`${base}/config`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.server).toBe("https://test.seedvault.dev");
    expect(body.username).toBe("testuser");
    expect(body.collections).toHaveLength(1);
    // Token should be redacted
    expect(body.token).toBeUndefined();
  });

  test("GET /events/local returns SSE stream", async () => {
    const controller = new AbortController();
    const res = await fetch(`${base}/events/local`, {
      signal: controller.signal,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();

    // First read gets the initial connection comment
    const { value: intro } = await reader.read();
    expect(decoder.decode(intro)).toContain(": connected");

    // Emit a file event
    fileEvents.emit({
      type: "add",
      serverPath: "notes/hello.md",
      localPath: "/tmp/notes/hello.md",
    });

    const { value } = await reader.read();
    const text = decoder.decode(value);
    expect(text).toContain("event: file_changed");
    expect(text).toContain('"type":"add"');
    expect(text).toContain("notes/hello.md");

    controller.abort();
  });

  test("unknown local route returns 404", async () => {
    const res = await fetch(`${base}/unknown`);
    expect(res.status).toBe(404);
  });
});
