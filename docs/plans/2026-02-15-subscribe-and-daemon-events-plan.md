# Subscribe & Daemon Events Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add two real-time event APIs to `@seedvault/cli`: `subscribe()` for server SSE events and `subscribeDaemonEvents()` for local daemon file-change events over a Unix domain socket.

**Architecture:** The client gets an async generator that connects to `GET /v1/events` via raw fetch, parses SSE frames, maps server event names, and reconnects with exponential backoff. The daemon gets a Unix socket server that broadcasts NDJSON file events to connected clients, with a consumer async generator exposed as a programmatic API.

**Tech Stack:** TypeScript (ES2022/ESM), Bun runtime, Node `net` module for Unix sockets, native `fetch` for SSE streaming. Test framework: `bun:test`.

**Design doc:** `docs/plans/2026-02-15-subscribe-and-daemon-events-design.md`

---

### Task 1: Add SSE types and `subscribe()` to `SeedvaultClient`

**Files:**
- Modify: `cli/src/client.ts:1-261`
- Test: `test/subscribe.test.ts`

**Step 1: Write the failing test**

Create `test/subscribe.test.ts`:

```typescript
import { describe, test, expect, afterEach } from "bun:test";
import { createClient } from "../cli/src/client.js";

describe("subscribe()", () => {
  let server: ReturnType<typeof Bun.serve> | null = null;

  afterEach(() => {
    if (server) {
      server.stop(true);
      server = null;
    }
  });

  test("yields VaultEvent for file_updated SSE events", async () => {
    server = Bun.serve({
      port: 0,
      fetch(req) {
        if (new URL(req.url).pathname !== "/v1/events") {
          return new Response("not found", { status: 404 });
        }
        const body = [
          "event: connected\ndata: {}\n\n",
          'event: file_updated\ndata: {"id":"evt-1","contributor":"alice","path":"notes/a.md","size":42,"modifiedAt":"2026-02-15T10:00:00Z"}\n\n',
          'event: file_deleted\ndata: {"id":"evt-2","contributor":"bob","path":"notes/b.md"}\n\n',
        ].join("");
        return new Response(body, {
          headers: { "Content-Type": "text/event-stream" },
        });
      },
    });

    const client = createClient(
      `http://localhost:${server.port}`,
      "test-token",
    );
    const events = [];

    for await (const event of client.subscribe()) {
      events.push(event);
      if (events.length === 2) break;
    }

    expect(events).toEqual([
      {
        id: "evt-1",
        action: "file_write",
        contributor: "alice",
        path: "notes/a.md",
        timestamp: "2026-02-15T10:00:00Z",
      },
      {
        id: "evt-2",
        action: "file_delete",
        contributor: "bob",
        path: "notes/b.md",
        timestamp: "2026-02-15T10:00:00Z",
      },
    ]);
  });

  test("filters by contributor", async () => {
    server = Bun.serve({
      port: 0,
      fetch(req) {
        const body = [
          "event: connected\ndata: {}\n\n",
          'event: file_updated\ndata: {"id":"evt-1","contributor":"alice","path":"a.md","size":1,"modifiedAt":"2026-02-15T10:00:00Z"}\n\n',
          'event: file_updated\ndata: {"id":"evt-2","contributor":"bob","path":"b.md","size":1,"modifiedAt":"2026-02-15T10:00:00Z"}\n\n',
        ].join("");
        return new Response(body, {
          headers: { "Content-Type": "text/event-stream" },
        });
      },
    });

    const client = createClient(
      `http://localhost:${server.port}`,
      "test-token",
    );
    const events = [];

    for await (const event of client.subscribe({ contributor: "bob" })) {
      events.push(event);
      if (events.length === 1) break;
    }

    expect(events.length).toBe(1);
    expect(events[0].contributor).toBe("bob");
  });

  test("filters by action", async () => {
    server = Bun.serve({
      port: 0,
      fetch(req) {
        const body = [
          "event: connected\ndata: {}\n\n",
          'event: file_updated\ndata: {"id":"evt-1","contributor":"alice","path":"a.md","size":1,"modifiedAt":"2026-02-15T10:00:00Z"}\n\n',
          'event: file_deleted\ndata: {"id":"evt-2","contributor":"alice","path":"b.md"}\n\n',
        ].join("");
        return new Response(body, {
          headers: { "Content-Type": "text/event-stream" },
        });
      },
    });

    const client = createClient(
      `http://localhost:${server.port}`,
      "test-token",
    );
    const events = [];

    for await (const event of client.subscribe({
      actions: ["file_delete"],
    })) {
      events.push(event);
      if (events.length === 1) break;
    }

    expect(events.length).toBe(1);
    expect(events[0].action).toBe("file_delete");
  });

  test("ignores activity and connected events", async () => {
    server = Bun.serve({
      port: 0,
      fetch(req) {
        const body = [
          "event: connected\ndata: {}\n\n",
          'event: activity\ndata: {"id":"act-1","contributor":"alice","action":"file_upserted","detail":"whatever","created_at":"2026-02-15T10:00:00Z"}\n\n',
          'event: file_updated\ndata: {"id":"evt-1","contributor":"alice","path":"a.md","size":1,"modifiedAt":"2026-02-15T10:00:00Z"}\n\n',
        ].join("");
        return new Response(body, {
          headers: { "Content-Type": "text/event-stream" },
        });
      },
    });

    const client = createClient(
      `http://localhost:${server.port}`,
      "test-token",
    );
    const events = [];

    for await (const event of client.subscribe()) {
      events.push(event);
      if (events.length === 1) break;
    }

    expect(events.length).toBe(1);
    expect(events[0].action).toBe("file_write");
  });

  test("sends Authorization header", async () => {
    let receivedAuth = "";
    server = Bun.serve({
      port: 0,
      fetch(req) {
        receivedAuth = req.headers.get("authorization") ?? "";
        const body =
          'event: file_updated\ndata: {"id":"evt-1","contributor":"alice","path":"a.md","size":1,"modifiedAt":"2026-02-15T10:00:00Z"}\n\n';
        return new Response(body, {
          headers: { "Content-Type": "text/event-stream" },
        });
      },
    });

    const client = createClient(
      `http://localhost:${server.port}`,
      "my-secret-token",
    );

    for await (const _ of client.subscribe()) {
      break;
    }

    expect(receivedAuth).toBe("Bearer my-secret-token");
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd /Users/yiliu/repos/seedvault && bun test test/subscribe.test.ts`
Expected: FAIL — `client.subscribe is not a function`

**Step 3: Write implementation**

Add these types after line 112 in `cli/src/client.ts` (after `HealthResponse`):

```typescript
// --- SSE subscription types ---

export interface SubscribeOptions {
  /** Filter to a specific contributor. Omit for all. */
  contributor?: string;
  /** Filter to specific actions. Omit for all. */
  actions?: Array<"file_write" | "file_delete">;
}

export interface VaultEvent {
  id: string;
  action: "file_write" | "file_delete";
  contributor: string;
  path: string;
  timestamp: string;
}
```

Add to the `SeedvaultClient` interface (after the `health()` method on line 29):

```typescript
  /** GET /v1/events — subscribe to real-time SSE events */
  subscribe(opts?: SubscribeOptions): AsyncGenerator<VaultEvent>;
```

Add the `subscribe` method inside the `createClient` return object (after the `health()` method, before the closing `};` on line 260):

```typescript
    async *subscribe(opts?: SubscribeOptions): AsyncGenerator<VaultEvent> {
      const MAX_BACKOFF = 60_000;
      let backoff = 1_000;

      while (true) {
        const controller = new AbortController();
        let res: Response;

        try {
          const headers: Record<string, string> = {};
          if (token) {
            headers["Authorization"] = `Bearer ${token}`;
          }

          res = await fetch(`${base}/v1/events`, {
            headers,
            signal: controller.signal,
          });

          if (!res.ok) {
            throw new ApiError(res.status, res.statusText);
          }
        } catch (e) {
          if (controller.signal.aborted) return;
          await new Promise((r) => setTimeout(r, backoff));
          backoff = Math.min(backoff * 2, MAX_BACKOFF);
          continue;
        }

        backoff = 1_000;

        try {
          yield* parseSSEStream(res.body!, opts, controller);
        } catch (e) {
          if (controller.signal.aborted) return;
          await new Promise((r) => setTimeout(r, backoff));
          backoff = Math.min(backoff * 2, MAX_BACKOFF);
          continue;
        }

        // Stream ended without error (server closed) — reconnect
        if (controller.signal.aborted) return;
        await new Promise((r) => setTimeout(r, backoff));
        backoff = Math.min(backoff * 2, MAX_BACKOFF);
      }
    },
```

Add the SSE parser as a module-level function (before `createClient`, after `encodePath`):

```typescript
/** Map server SSE event names to VaultEvent action names */
const SSE_ACTION_MAP: Record<string, "file_write" | "file_delete"> = {
  file_updated: "file_write",
  file_deleted: "file_delete",
};

async function* parseSSEStream(
  body: ReadableStream<Uint8Array>,
  opts: SubscribeOptions | undefined,
  controller: AbortController,
): AsyncGenerator<VaultEvent> {
  const decoder = new TextDecoder();
  const reader = body.getReader();
  let buffer = "";
  let eventType = "";
  let dataLines: string[] = [];

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop()!;

      for (const line of lines) {
        if (line.startsWith("event: ")) {
          eventType = line.slice(7).trim();
        } else if (line.startsWith("data: ")) {
          dataLines.push(line.slice(6));
        } else if (line === "" && eventType && dataLines.length > 0) {
          const action = SSE_ACTION_MAP[eventType];
          if (action) {
            const data = JSON.parse(dataLines.join("\n"));
            const event: VaultEvent = {
              id: data.id ?? "",
              action,
              contributor: data.contributor ?? "",
              path: data.path ?? "",
              timestamp: data.modifiedAt ?? data.created_at ?? new Date().toISOString(),
            };

            const passContributor =
              !opts?.contributor || event.contributor === opts.contributor;
            const passAction =
              !opts?.actions || opts.actions.includes(event.action);

            if (passContributor && passAction) {
              yield event;
            }
          }
          eventType = "";
          dataLines = [];
        } else if (line === "") {
          eventType = "";
          dataLines = [];
        }
      }
    }
  } finally {
    reader.releaseLock();
    controller.abort();
  }
}
```

**Step 4: Run test to verify it passes**

Run: `cd /Users/yiliu/repos/seedvault && bun test test/subscribe.test.ts`
Expected: All 5 tests PASS

**Step 5: Run type check**

Run: `cd /Users/yiliu/repos/seedvault/cli && bun run check`
Expected: No errors

**Step 6: Commit**

```bash
git add cli/src/client.ts test/subscribe.test.ts
git commit -m "feat(client): add subscribe() SSE method to SeedvaultClient"
```

---

### Task 2: Re-export new SSE types from API surface

**Files:**
- Modify: `cli/src/api/client.ts:1-14`
- Modify: `cli/src/api/index.ts:27-40`

**Step 1: Update `cli/src/api/client.ts`**

Add `SubscribeOptions` and `VaultEvent` to the type re-exports:

```typescript
export { createClient, ApiError } from "../client.js";

export type {
  SeedvaultClient,
  FileEntry,
  PutFileOptions,
  SearchResult,
  SearchOptions,
  SearchResponse,
  ActivityEvent,
  ActivityOptions,
  ActivityResponse,
  HealthResponse,
  SubscribeOptions,
  VaultEvent,
} from "../client.js";
```

**Step 2: Update `cli/src/api/index.ts`**

Add `SubscribeOptions` and `VaultEvent` to the Client re-exports section:

```typescript
// Client
export { createClient, ApiError } from "./client.js";

export type {
  SeedvaultClient,
  FileEntry,
  PutFileOptions,
  SearchResult,
  SearchOptions,
  SearchResponse,
  ActivityEvent,
  ActivityOptions,
  ActivityResponse,
  HealthResponse,
  SubscribeOptions,
  VaultEvent,
} from "./client.js";
```

**Step 3: Update the API exports smoke test**

In `test/api.test.ts`, the "all expected exports" test dynamically imports `api/index.js`. No code change needed for types (they're type-only exports and don't show up at runtime). The existing test should still pass.

**Step 4: Run tests and type check**

Run: `cd /Users/yiliu/repos/seedvault && bun test test/api.test.ts`
Expected: PASS

Run: `cd /Users/yiliu/repos/seedvault/cli && bun run check`
Expected: No errors

**Step 5: Commit**

```bash
git add cli/src/api/client.ts cli/src/api/index.ts
git commit -m "feat(api): re-export SubscribeOptions and VaultEvent types"
```

---

### Task 3: Create daemon socket server

**Files:**
- Create: `cli/src/daemon/socket.ts`
- Test: `test/daemon-socket.test.ts`

**Step 1: Write the failing test**

Create `test/daemon-socket.test.ts`:

```typescript
import { describe, test, expect, afterEach } from "bun:test";
import { createServer, type Server } from "net";
import { join } from "path";
import { tmpdir } from "os";
import { unlinkSync, existsSync } from "fs";
import {
  createDaemonSocket,
  type DaemonSocketServer,
  type DaemonFileEvent,
} from "../cli/src/daemon/socket.js";

describe("daemon socket server", () => {
  let socketServer: DaemonSocketServer | null = null;
  let socketPath: string;

  afterEach(async () => {
    if (socketServer) {
      await socketServer.close();
      socketServer = null;
    }
    try {
      unlinkSync(socketPath);
    } catch {}
  });

  test("creates socket file and accepts connections", async () => {
    socketPath = join(tmpdir(), `sv-test-${Date.now()}.sock`);
    socketServer = await createDaemonSocket(socketPath);

    expect(existsSync(socketPath)).toBe(true);

    const { createConnection } = await import("net");
    const conn = createConnection(socketPath);
    await new Promise<void>((resolve) => conn.on("connect", resolve));
    conn.destroy();
  });

  test("broadcasts events to connected clients as NDJSON", async () => {
    socketPath = join(tmpdir(), `sv-test-${Date.now()}.sock`);
    socketServer = await createDaemonSocket(socketPath);

    const { createConnection } = await import("net");
    const conn = createConnection(socketPath);
    await new Promise<void>((resolve) => conn.on("connect", resolve));

    const received: string[] = [];
    conn.on("data", (chunk) => received.push(chunk.toString()));

    const event: DaemonFileEvent = {
      action: "file_write",
      path: "notes/test.md",
      collection: "notes",
      timestamp: "2026-02-15T10:00:00Z",
    };
    socketServer.broadcast(event);

    // Give time for the data to arrive
    await new Promise((r) => setTimeout(r, 50));

    const lines = received.join("").trim().split("\n");
    expect(lines.length).toBe(1);
    expect(JSON.parse(lines[0])).toEqual(event);

    conn.destroy();
  });

  test("broadcasts to multiple clients", async () => {
    socketPath = join(tmpdir(), `sv-test-${Date.now()}.sock`);
    socketServer = await createDaemonSocket(socketPath);

    const { createConnection } = await import("net");

    const conn1 = createConnection(socketPath);
    const conn2 = createConnection(socketPath);
    await Promise.all([
      new Promise<void>((resolve) => conn1.on("connect", resolve)),
      new Promise<void>((resolve) => conn2.on("connect", resolve)),
    ]);

    const received1: string[] = [];
    const received2: string[] = [];
    conn1.on("data", (chunk) => received1.push(chunk.toString()));
    conn2.on("data", (chunk) => received2.push(chunk.toString()));

    const event: DaemonFileEvent = {
      action: "file_delete",
      path: "notes/gone.md",
      collection: "notes",
      timestamp: "2026-02-15T10:00:01Z",
    };
    socketServer.broadcast(event);

    await new Promise((r) => setTimeout(r, 50));

    expect(JSON.parse(received1.join("").trim())).toEqual(event);
    expect(JSON.parse(received2.join("").trim())).toEqual(event);

    conn1.destroy();
    conn2.destroy();
  });

  test("removes stale socket file on startup", async () => {
    socketPath = join(tmpdir(), `sv-test-${Date.now()}.sock`);

    // Create a stale socket file
    const { writeFileSync } = await import("fs");
    writeFileSync(socketPath, "stale");
    expect(existsSync(socketPath)).toBe(true);

    socketServer = await createDaemonSocket(socketPath);
    expect(existsSync(socketPath)).toBe(true);

    // Should be a real socket now, not the stale file
    const { createConnection } = await import("net");
    const conn = createConnection(socketPath);
    await new Promise<void>((resolve) => conn.on("connect", resolve));
    conn.destroy();
  });

  test("close() removes socket file and disconnects clients", async () => {
    socketPath = join(tmpdir(), `sv-test-${Date.now()}.sock`);
    socketServer = await createDaemonSocket(socketPath);

    const { createConnection } = await import("net");
    const conn = createConnection(socketPath);
    await new Promise<void>((resolve) => conn.on("connect", resolve));

    await socketServer.close();
    socketServer = null;

    expect(existsSync(socketPath)).toBe(false);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd /Users/yiliu/repos/seedvault && bun test test/daemon-socket.test.ts`
Expected: FAIL — cannot resolve module

**Step 3: Write implementation**

Create `cli/src/daemon/socket.ts`:

```typescript
import { createServer, type Socket, type Server } from "net";
import { existsSync, unlinkSync } from "fs";

export interface DaemonFileEvent {
  action: "file_write" | "file_delete" | "dir_delete";
  path: string;
  collection: string;
  timestamp: string;
}

export interface DaemonSocketServer {
  broadcast(event: DaemonFileEvent): void;
  close(): Promise<void>;
}

export function createDaemonSocket(
  socketPath: string,
): Promise<DaemonSocketServer> {
  return new Promise((resolve, reject) => {
    const clients = new Set<Socket>();

    // Remove stale socket file
    if (existsSync(socketPath)) {
      try {
        unlinkSync(socketPath);
      } catch {}
    }

    const server = createServer((socket) => {
      clients.add(socket);
      socket.on("close", () => clients.delete(socket));
      socket.on("error", () => clients.delete(socket));
    });

    server.on("error", reject);

    server.listen(socketPath, () => {
      resolve({
        broadcast(event: DaemonFileEvent): void {
          const line = JSON.stringify(event) + "\n";
          for (const socket of clients) {
            try {
              socket.write(line);
            } catch {
              clients.delete(socket);
            }
          }
        },

        close(): Promise<void> {
          return new Promise((res) => {
            for (const socket of clients) {
              socket.destroy();
            }
            clients.clear();
            server.close(() => {
              try {
                unlinkSync(socketPath);
              } catch {}
              res();
            });
          });
        },
      });
    });
  });
}
```

**Step 4: Run test to verify it passes**

Run: `cd /Users/yiliu/repos/seedvault && bun test test/daemon-socket.test.ts`
Expected: All 5 tests PASS

**Step 5: Run type check**

Run: `cd /Users/yiliu/repos/seedvault/cli && bun run check`
Expected: No errors

**Step 6: Commit**

```bash
git add cli/src/daemon/socket.ts test/daemon-socket.test.ts
git commit -m "feat(daemon): add Unix domain socket server for file events"
```

---

### Task 4: Wire socket server into daemon startup

**Files:**
- Modify: `cli/src/commands/start.ts:1-311`
- Modify: `cli/src/config.ts` (add socket path getter)

**Step 1: Add socket path to config**

In `cli/src/config.ts`, add after line 33 (`const PID_PATH = ...`):

```typescript
const DAEMON_SOCKET_PATH = join(CONFIG_DIR, "daemon.sock");
```

Add a getter after `getSchtasksXmlPath()` (after line 65):

```typescript
export function getDaemonSocketPath(): string {
  return DAEMON_SOCKET_PATH;
}
```

**Step 2: Wire socket into daemon startup**

In `cli/src/commands/start.ts`, add import of socket module and socket path:

After line 13 (`import { writeHealthFile } from "../api/health.js";`), add:

```typescript
import { createDaemonSocket, type DaemonSocketServer, type DaemonFileEvent } from "../daemon/socket.js";
import { getDaemonSocketPath } from "../config.js";
```

Update the `getDaemonSocketPath` import — add it to the existing config import on line 3-9:

```typescript
import {
  loadConfig,
  getPidPath,
  getDaemonSocketPath,
  normalizeConfigCollections,
  type CollectionConfig,
  type Config,
} from "../config.js";
```

After the watcher is built (after line 144, `await rebuildWatcher(config.collections);`), create the socket server:

```typescript
  const socketServer = await createDaemonSocket(getDaemonSocketPath());
  log(`Event socket listening at ${getDaemonSocketPath()}`);
```

Update the `rebuildWatcher` callback to also broadcast events to socket clients. Modify the watcher callback (lines 135-140) to:

```typescript
    watcher = createWatcher(collections, (event: FileEvent) => {
      syncer.handleEvent(event).catch((e) => {
        const label = "serverPath" in event ? event.serverPath : event.collectionName;
        log(`Error handling ${event.type} for ${label}: ${(e as Error).message}`);
      });

      // Broadcast to socket clients
      const socketEvent = fileEventToDaemonEvent(event);
      if (socketEvent) {
        socketServer.broadcast(socketEvent);
      }
    });
```

Add the mapping function before `startForeground()` (or as a module-level function):

```typescript
function fileEventToDaemonEvent(event: FileEvent): DaemonFileEvent | null {
  const timestamp = new Date().toISOString();

  switch (event.type) {
    case "add":
    case "change": {
      const collection = event.serverPath.split("/")[0];
      return {
        action: "file_write",
        path: event.serverPath,
        collection,
        timestamp,
      };
    }
    case "unlink": {
      const collection = event.serverPath.split("/")[0];
      return {
        action: "file_delete",
        path: event.serverPath,
        collection,
        timestamp,
      };
    }
    case "unlinkDir":
      return {
        action: "dir_delete",
        path: event.localPath,
        collection: event.collectionName,
        timestamp,
      };
    default:
      return null;
  }
}
```

Update the `shutdown()` function (line 244-268) to close the socket server:

```typescript
  const shutdown = () => {
    log("Shutting down...");
    clearInterval(pollTimer);
    clearInterval(healthTimer);
    if (watcher) void watcher.close();
    syncer.stop();
    void socketServer.close();

    writeHealthFile({
      running: false,
      serverConnected: false,
      serverUrl: config.server,
      username: config.username,
      pendingOps: 0,
      collectionsWatched: 0,
      lastSyncAt,
      updatedAt: new Date().toISOString(),
    });

    // Clean up PID file
    try {
      unlinkSync(getPidPath());
    } catch {}

    process.exit(0);
  };
```

**Step 3: Run type check**

Run: `cd /Users/yiliu/repos/seedvault/cli && bun run check`
Expected: No errors

**Step 4: Run existing tests**

Run: `cd /Users/yiliu/repos/seedvault && bun test`
Expected: All existing tests PASS

**Step 5: Commit**

```bash
git add cli/src/config.ts cli/src/commands/start.ts
git commit -m "feat(daemon): wire socket server into daemon startup and shutdown"
```

---

### Task 5: Create `subscribeDaemonEvents()` consumer API

**Files:**
- Create: `cli/src/api/daemon-events.ts`
- Test: `test/daemon-events.test.ts`

**Step 1: Write the failing test**

Create `test/daemon-events.test.ts`:

```typescript
import { describe, test, expect, afterEach } from "bun:test";
import { createServer, type Server } from "net";
import { join } from "path";
import { tmpdir } from "os";
import { unlinkSync } from "fs";
import type { DaemonFileEvent } from "../cli/src/daemon/socket.js";

describe("subscribeDaemonEvents()", () => {
  let server: Server | null = null;
  let socketPath: string;

  afterEach(() => {
    if (server) {
      server.close();
      server = null;
    }
    try {
      unlinkSync(socketPath);
    } catch {}
  });

  test("yields events from NDJSON socket stream", async () => {
    socketPath = join(tmpdir(), `sv-consumer-${Date.now()}.sock`);

    const events: DaemonFileEvent[] = [
      {
        action: "file_write",
        path: "notes/a.md",
        collection: "notes",
        timestamp: "2026-02-15T10:00:00Z",
      },
      {
        action: "file_delete",
        path: "notes/b.md",
        collection: "notes",
        timestamp: "2026-02-15T10:00:01Z",
      },
    ];

    server = createServer((socket) => {
      for (const event of events) {
        socket.write(JSON.stringify(event) + "\n");
      }
    });

    await new Promise<void>((resolve) => server!.listen(socketPath, resolve));

    const { subscribeDaemonEvents } = await import(
      "../cli/src/api/daemon-events.js"
    );

    const received: DaemonFileEvent[] = [];
    for await (const event of subscribeDaemonEvents(socketPath)) {
      received.push(event);
      if (received.length === 2) break;
    }

    expect(received).toEqual(events);
  });

  test("handles partial chunks (buffering)", async () => {
    socketPath = join(tmpdir(), `sv-consumer-${Date.now()}.sock`);

    const event: DaemonFileEvent = {
      action: "file_write",
      path: "notes/chunked.md",
      collection: "notes",
      timestamp: "2026-02-15T10:00:00Z",
    };

    const line = JSON.stringify(event) + "\n";
    const mid = Math.floor(line.length / 2);

    server = createServer((socket) => {
      // Send in two chunks
      socket.write(line.slice(0, mid));
      setTimeout(() => socket.write(line.slice(mid)), 20);
    });

    await new Promise<void>((resolve) => server!.listen(socketPath, resolve));

    const { subscribeDaemonEvents } = await import(
      "../cli/src/api/daemon-events.js"
    );

    const received: DaemonFileEvent[] = [];
    for await (const evt of subscribeDaemonEvents(socketPath)) {
      received.push(evt);
      if (received.length === 1) break;
    }

    expect(received[0]).toEqual(event);
  });

  test("handles dir_delete events", async () => {
    socketPath = join(tmpdir(), `sv-consumer-${Date.now()}.sock`);

    const event: DaemonFileEvent = {
      action: "dir_delete",
      path: "notes/archive",
      collection: "notes",
      timestamp: "2026-02-15T10:00:00Z",
    };

    server = createServer((socket) => {
      socket.write(JSON.stringify(event) + "\n");
    });

    await new Promise<void>((resolve) => server!.listen(socketPath, resolve));

    const { subscribeDaemonEvents } = await import(
      "../cli/src/api/daemon-events.js"
    );

    const received: DaemonFileEvent[] = [];
    for await (const evt of subscribeDaemonEvents(socketPath)) {
      received.push(evt);
      if (received.length === 1) break;
    }

    expect(received[0]).toEqual(event);
  });

  test("generator cleanup closes connection", async () => {
    socketPath = join(tmpdir(), `sv-consumer-${Date.now()}.sock`);

    let clientDisconnected = false;
    server = createServer((socket) => {
      socket.on("close", () => {
        clientDisconnected = true;
      });
      // Keep sending events
      const interval = setInterval(() => {
        try {
          socket.write(
            JSON.stringify({
              action: "file_write",
              path: "notes/x.md",
              collection: "notes",
              timestamp: new Date().toISOString(),
            }) + "\n",
          );
        } catch {
          clearInterval(interval);
        }
      }, 10);
    });

    await new Promise<void>((resolve) => server!.listen(socketPath, resolve));

    const { subscribeDaemonEvents } = await import(
      "../cli/src/api/daemon-events.js"
    );

    for await (const _ of subscribeDaemonEvents(socketPath)) {
      break; // break immediately to trigger cleanup
    }

    await new Promise((r) => setTimeout(r, 50));
    expect(clientDisconnected).toBe(true);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd /Users/yiliu/repos/seedvault && bun test test/daemon-events.test.ts`
Expected: FAIL — cannot resolve module

**Step 3: Write implementation**

Create `cli/src/api/daemon-events.ts`:

```typescript
import { createConnection } from "net";
import { join } from "path";
import { homedir } from "os";
import type { DaemonFileEvent } from "../daemon/socket.js";

const DEFAULT_SOCKET_PATH = join(
  homedir(),
  ".config",
  "seedvault",
  "daemon.sock",
);

export type { DaemonFileEvent };

export async function* subscribeDaemonEvents(
  socketPath: string = DEFAULT_SOCKET_PATH,
): AsyncGenerator<DaemonFileEvent> {
  const socket = createConnection(socketPath);
  let buffer = "";
  let done = false;

  const queue: DaemonFileEvent[] = [];
  let resolve: (() => void) | null = null;
  let rejectFn: ((err: Error) => void) | null = null;

  function notify(): void {
    if (resolve) {
      const r = resolve;
      resolve = null;
      rejectFn = null;
      r();
    }
  }

  socket.on("data", (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split("\n");
    buffer = lines.pop()!;

    for (const line of lines) {
      if (line.trim() === "") continue;
      try {
        queue.push(JSON.parse(line) as DaemonFileEvent);
      } catch {
        // Skip malformed lines
      }
    }
    notify();
  });

  socket.on("end", () => {
    done = true;
    notify();
  });

  socket.on("error", (err) => {
    done = true;
    if (rejectFn) {
      const r = rejectFn;
      resolve = null;
      rejectFn = null;
      r(err);
    }
  });

  await new Promise<void>((res, rej) => {
    socket.on("connect", res);
    socket.on("error", rej);
  });

  try {
    while (true) {
      while (queue.length > 0) {
        yield queue.shift()!;
      }
      if (done) break;
      await new Promise<void>((res, rej) => {
        resolve = res;
        rejectFn = rej;
      });
    }
  } finally {
    socket.destroy();
  }
}
```

**Step 4: Run test to verify it passes**

Run: `cd /Users/yiliu/repos/seedvault && bun test test/daemon-events.test.ts`
Expected: All 4 tests PASS

**Step 5: Run type check**

Run: `cd /Users/yiliu/repos/seedvault/cli && bun run check`
Expected: No errors

**Step 6: Commit**

```bash
git add cli/src/api/daemon-events.ts test/daemon-events.test.ts
git commit -m "feat(api): add subscribeDaemonEvents() consumer API"
```

---

### Task 6: Export daemon events from package and update package.json

**Files:**
- Modify: `cli/src/api/index.ts`
- Modify: `cli/package.json`
- Modify: `test/api.test.ts`

**Step 1: Update `cli/src/api/index.ts`**

Add after the Client exports section:

```typescript
// Daemon events
export { subscribeDaemonEvents } from "./daemon-events.js";

export type { DaemonFileEvent } from "./daemon-events.js";
```

**Step 2: Update `cli/package.json`**

Add a new subpath export entry in the `"exports"` object:

```json
"./daemon-events": {
  "types": "./dist/api/daemon-events.d.ts",
  "import": "./dist/api/daemon-events.js",
  "default": "./dist/api/daemon-events.js"
}
```

Add to `"typesVersions"`:

```json
"daemon-events": ["dist/api/daemon-events.d.ts"]
```

**Step 3: Update the API exports smoke test**

In `test/api.test.ts`, add to the "all expected exports" test assertions:

```typescript
    // Daemon events
    expect(typeof api.subscribeDaemonEvents).toBe("function");
```

**Step 4: Run all tests**

Run: `cd /Users/yiliu/repos/seedvault && bun test`
Expected: All tests PASS

**Step 5: Run type check**

Run: `cd /Users/yiliu/repos/seedvault/cli && bun run check`
Expected: No errors

**Step 6: Commit**

```bash
git add cli/src/api/index.ts cli/package.json test/api.test.ts
git commit -m "feat(api): export subscribeDaemonEvents and add package subpath"
```

---

### Task 7: Final verification

**Step 1: Run full test suite**

Run: `cd /Users/yiliu/repos/seedvault && bun test`
Expected: All tests PASS (existing + new)

**Step 2: Run type check**

Run: `cd /Users/yiliu/repos/seedvault/cli && bun run check`
Expected: No errors

**Step 3: Build**

Run: `cd /Users/yiliu/repos/seedvault/cli && bun run build`
Expected: Build succeeds, `dist/` contains new files

**Step 4: Verify exports resolve**

Run: `cd /Users/yiliu/repos/seedvault && node -e "import('@seedvault/cli').then(m => console.log(Object.keys(m).sort().join(', ')))"`
Expected: Output includes `subscribeDaemonEvents`

Run: `cd /Users/yiliu/repos/seedvault && node -e "import('@seedvault/cli/daemon-events').then(m => console.log(Object.keys(m)))"`
Expected: Output includes `subscribeDaemonEvents`
