import { describe, test, expect, afterEach } from "bun:test";
import { createConnection, type Socket } from "net";
import { existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  createDaemonSocket,
  type DaemonSocketServer,
  type DaemonFileEvent,
} from "../cli/src/daemon/socket.js";

let servers: DaemonSocketServer[] = [];
let clients: Socket[] = [];

function socketPath(): string {
  const id = Math.random().toString(36).slice(2, 10);
  return join(tmpdir(), `sv-test-${id}.sock`);
}

function connectClient(path: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const sock = createConnection(path, () => resolve(sock));
    sock.on("error", reject);
    clients.push(sock);
  });
}

function readLines(
  sock: Socket,
  count: number,
  timeoutMs = 2000,
): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const lines: string[] = [];
    let buffer = "";
    const timer = setTimeout(() => {
      reject(
        new Error(
          `Timed out waiting for ${count} lines, got ${lines.length}`,
        ),
      );
    }, timeoutMs);

    sock.on("data", (chunk) => {
      buffer += chunk.toString();
      const parts = buffer.split("\n");
      buffer = parts.pop()!;
      for (const part of parts) {
        if (part.length > 0) {
          lines.push(part);
        }
        if (lines.length >= count) {
          clearTimeout(timer);
          resolve(lines);
          return;
        }
      }
    });
  });
}

afterEach(async () => {
  for (const c of clients) {
    c.destroy();
  }
  clients = [];
  for (const s of servers) {
    await s.close();
  }
  servers = [];
});

const sampleEvent: DaemonFileEvent = {
  action: "file_write",
  path: "notes/hello.md",
  collection: "notes",
  timestamp: "2026-01-15T00:00:00Z",
};

describe("daemon socket server", () => {
  test("creates socket file and accepts connections", async () => {
    const path = socketPath();
    const srv = await createDaemonSocket(path);
    servers.push(srv);

    expect(existsSync(path)).toBe(true);

    const client = await connectClient(path);
    expect(client.readable).toBe(true);
  });

  test("broadcasts events to connected clients as NDJSON", async () => {
    const path = socketPath();
    const srv = await createDaemonSocket(path);
    servers.push(srv);

    const client = await connectClient(path);
    const linePromise = readLines(client, 1);

    // Small delay so the server registers the connection
    await Bun.sleep(50);
    srv.broadcast(sampleEvent);

    const lines = await linePromise;
    expect(lines).toHaveLength(1);

    const parsed = JSON.parse(lines[0]!) as DaemonFileEvent;
    expect(parsed.action).toBe("file_write");
    expect(parsed.path).toBe("notes/hello.md");
    expect(parsed.collection).toBe("notes");
    expect(parsed.timestamp).toBe("2026-01-15T00:00:00Z");
  });

  test("broadcasts to multiple clients", async () => {
    const path = socketPath();
    const srv = await createDaemonSocket(path);
    servers.push(srv);

    const client1 = await connectClient(path);
    const client2 = await connectClient(path);

    const p1 = readLines(client1, 1);
    const p2 = readLines(client2, 1);

    await Bun.sleep(50);
    srv.broadcast(sampleEvent);

    const [lines1, lines2] = await Promise.all([p1, p2]);
    expect(lines1).toHaveLength(1);
    expect(lines2).toHaveLength(1);

    const parsed1 = JSON.parse(lines1[0]!) as DaemonFileEvent;
    const parsed2 = JSON.parse(lines2[0]!) as DaemonFileEvent;
    expect(parsed1.action).toBe("file_write");
    expect(parsed2.action).toBe("file_write");
  });

  test("removes stale socket file on startup", async () => {
    const path = socketPath();

    // Create a first server, then close it without removing the socket
    const first = await createDaemonSocket(path);
    expect(existsSync(path)).toBe(true);
    await first.close();

    // Manually recreate a stale socket file
    await Bun.write(path, "stale");
    expect(existsSync(path)).toBe(true);

    // Creating a new server should remove the stale file and succeed
    const second = await createDaemonSocket(path);
    servers.push(second);

    const client = await connectClient(path);
    expect(client.readable).toBe(true);
  });

  test("close() removes socket file and disconnects clients", async () => {
    const path = socketPath();
    const srv = await createDaemonSocket(path);

    const client = await connectClient(path);
    await Bun.sleep(50);

    const closePromise = new Promise<void>((resolve) => {
      client.on("close", () => resolve());
    });

    await srv.close();

    expect(existsSync(path)).toBe(false);
    await closePromise;
  });
});
