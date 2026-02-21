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

describe("daemon API — collection management", () => {
  test("PUT /config/collections with add action", async () => {
    let lastUpdate: { action: string; payload: unknown } | null = null;

    const server2 = createDaemonServer({
      port: TEST_PORT + 1,
      getConfig: () => mockConfig,
      getStatus: () => mockStatus,
      fileEvents,
      updateCollections: (action, payload) => {
        lastUpdate = { action, payload };
        return {};
      },
    });

    try {
      const res = await fetch(
        `http://localhost:${TEST_PORT + 1}/config/collections`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "add",
            path: "/tmp/research",
            name: "research",
          }),
        },
      );
      expect(res.status).toBe(200);
      expect(lastUpdate).not.toBeNull();
      expect(
        (lastUpdate as { action: string }).action,
      ).toBe("add");
      expect(
        (lastUpdate as { payload: { name: string } }).payload.name,
      ).toBe("research");
    } finally {
      server2.stop();
    }
  });

  test("PUT /config/collections with remove action", async () => {
    let lastUpdate: { action: string; payload: unknown } | null = null;

    const server2 = createDaemonServer({
      port: TEST_PORT + 2,
      getConfig: () => mockConfig,
      getStatus: () => mockStatus,
      fileEvents,
      updateCollections: (action, payload) => {
        lastUpdate = { action, payload };
        return {};
      },
    });

    try {
      const res = await fetch(
        `http://localhost:${TEST_PORT + 2}/config/collections`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "remove",
            name: "notes",
          }),
        },
      );
      expect(res.status).toBe(200);
      expect(
        (lastUpdate as { action: string }).action,
      ).toBe("remove");
    } finally {
      server2.stop();
    }
  });

  test("PUT /config/collections returns error on failure", async () => {
    const server2 = createDaemonServer({
      port: TEST_PORT + 3,
      getConfig: () => mockConfig,
      getStatus: () => mockStatus,
      fileEvents,
      updateCollections: () => {
        return { error: "Collection path already exists" };
      },
    });

    try {
      const res = await fetch(
        `http://localhost:${TEST_PORT + 3}/config/collections`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "add",
            path: "/tmp/notes",
            name: "notes",
          }),
        },
      );
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe("Collection path already exists");
    } finally {
      server2.stop();
    }
  });
});

describe("daemon API — proxy", () => {
  let mockRemote: ReturnType<typeof Bun.serve>;
  let proxyServer: ReturnType<typeof createDaemonServer>;
  const REMOTE_PORT = TEST_PORT + 10;
  const PROXY_PORT = TEST_PORT + 11;

  let lastAuthHeader: string | null = null;

  beforeAll(() => {
    mockRemote = Bun.serve({
      port: REMOTE_PORT,
      hostname: "127.0.0.1",
      fetch(req) {
        const url = new URL(req.url);
        lastAuthHeader = req.headers.get("authorization");

        if (url.pathname === "/v1/contributors") {
          return Response.json({
            contributors: [
              {
                username: "alice",
                createdAt: "2026-01-01T00:00:00Z",
              },
            ],
          });
        }

        if (url.pathname === "/health") {
          return Response.json({ status: "ok" });
        }

        if (url.pathname.startsWith("/v1/files/")) {
          return new Response("# Hello\n", {
            headers: { "Content-Type": "text/markdown" },
          });
        }

        return Response.json(
          { error: "Not found" },
          { status: 404 },
        );
      },
    });

    proxyServer = createDaemonServer({
      port: PROXY_PORT,
      getConfig: () => ({
        ...mockConfig,
        server: `http://127.0.0.1:${REMOTE_PORT}`,
      }),
      getStatus: () => mockStatus,
      fileEvents,
    });
  });

  afterAll(() => {
    proxyServer.stop();
    mockRemote.stop();
  });

  test("proxies GET /v1/contributors", async () => {
    const res = await fetch(
      `http://localhost:${PROXY_PORT}/v1/contributors`,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.contributors).toHaveLength(1);
    expect(body.contributors[0].username).toBe("alice");
  });

  test("proxies GET /health", async () => {
    const res = await fetch(
      `http://localhost:${PROXY_PORT}/health`,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ok");
  });

  test("proxies GET /v1/files/:user/*path", async () => {
    const res = await fetch(
      `http://localhost:${PROXY_PORT}/v1/files/alice/notes/test.md`,
    );
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toBe("# Hello\n");
  });

  test("injects auth token from config into proxied requests", async () => {
    await fetch(
      `http://localhost:${PROXY_PORT}/v1/contributors`,
    );
    expect(lastAuthHeader).toBe("Bearer sv_test_token");
  });

  test("returns 502 when remote is unreachable", async () => {
    const deadServer = createDaemonServer({
      port: PROXY_PORT + 1,
      getConfig: () => ({
        ...mockConfig,
        server: "http://127.0.0.1:1",
      }),
      getStatus: () => mockStatus,
      fileEvents,
    });

    try {
      const res = await fetch(
        `http://localhost:${PROXY_PORT + 1}/v1/contributors`,
      );
      expect(res.status).toBe(502);
    } finally {
      deadServer.stop();
    }
  });
});
