import { describe, test, expect, afterEach } from "bun:test";
import { createServer, type Server } from "net";
import { tmpdir } from "os";
import { join } from "path";
import { subscribeDaemonEvents } from "../cli/src/api/daemon-events.js";
import type { DaemonFileEvent } from "../cli/src/daemon/socket.js";

let servers: Server[] = [];

function uniqueSocketPath(): string {
  const id = Math.random().toString(36).slice(2, 10);
  return join(tmpdir(), `sv-events-test-${id}.sock`);
}

afterEach(async () => {
  for (const s of servers) {
    await new Promise<void>((res) => s.close(() => res()));
  }
  servers = [];
});

const writeEvent: DaemonFileEvent = {
  action: "file_write",
  path: "notes/hello.md",
  collection: "notes",
  timestamp: "2026-01-15T00:00:00Z",
};

const deleteEvent: DaemonFileEvent = {
  action: "file_delete",
  path: "notes/gone.md",
  collection: "notes",
  timestamp: "2026-01-15T00:01:00Z",
};

describe("subscribeDaemonEvents", () => {
  test("yields events from NDJSON socket stream", async () => {
    const path = uniqueSocketPath();
    const server = createServer((socket) => {
      socket.write(JSON.stringify(writeEvent) + "\n");
      socket.write(JSON.stringify(deleteEvent) + "\n");
      setTimeout(() => socket.end(), 50);
    });
    servers.push(server);

    await new Promise<void>((res) => server.listen(path, res));

    const events: DaemonFileEvent[] = [];
    for await (const event of subscribeDaemonEvents(path)) {
      events.push(event);
    }

    expect(events).toHaveLength(2);
    expect(events[0]!.action).toBe("file_write");
    expect(events[0]!.path).toBe("notes/hello.md");
    expect(events[0]!.collection).toBe("notes");
    expect(events[1]!.action).toBe("file_delete");
    expect(events[1]!.path).toBe("notes/gone.md");
  });

  test("handles partial chunks (buffering)", async () => {
    const path = uniqueSocketPath();
    const json = JSON.stringify(writeEvent) + "\n";
    const mid = Math.floor(json.length / 2);
    const firstHalf = json.slice(0, mid);
    const secondHalf = json.slice(mid);

    const server = createServer((socket) => {
      socket.write(firstHalf);
      setTimeout(() => {
        socket.write(secondHalf);
        setTimeout(() => socket.end(), 50);
      }, 50);
    });
    servers.push(server);

    await new Promise<void>((res) => server.listen(path, res));

    const events: DaemonFileEvent[] = [];
    for await (const event of subscribeDaemonEvents(path)) {
      events.push(event);
    }

    expect(events).toHaveLength(1);
    expect(events[0]!.action).toBe("file_write");
    expect(events[0]!.path).toBe("notes/hello.md");
    expect(events[0]!.collection).toBe("notes");
    expect(events[0]!.timestamp).toBe("2026-01-15T00:00:00Z");
  });

  test("handles dir_delete events", async () => {
    const path = uniqueSocketPath();
    const dirDeleteEvent: DaemonFileEvent = {
      action: "dir_delete",
      path: "archive/old-folder",
      collection: "archive",
      timestamp: "2026-01-15T00:02:00Z",
    };

    const server = createServer((socket) => {
      socket.write(JSON.stringify(dirDeleteEvent) + "\n");
      setTimeout(() => socket.end(), 50);
    });
    servers.push(server);

    await new Promise<void>((res) => server.listen(path, res));

    const events: DaemonFileEvent[] = [];
    for await (const event of subscribeDaemonEvents(path)) {
      events.push(event);
    }

    expect(events).toHaveLength(1);
    expect(events[0]!.action).toBe("dir_delete");
    expect(events[0]!.path).toBe("archive/old-folder");
    expect(events[0]!.collection).toBe("archive");
  });

  test("generator cleanup closes connection", async () => {
    const path = uniqueSocketPath();
    let clientDisconnected = false;
    const disconnectPromise = new Promise<void>((res) => {
      const server = createServer((socket) => {
        socket.write(JSON.stringify(writeEvent) + "\n");

        const interval = setInterval(() => {
          socket.write(JSON.stringify(deleteEvent) + "\n");
        }, 20);

        socket.on("close", () => {
          clearInterval(interval);
          clientDisconnected = true;
          res();
        });
      });
      servers.push(server);

      server.listen(path);
    });

    // Wait for server to be ready
    await Bun.sleep(50);

    const events: DaemonFileEvent[] = [];
    for await (const event of subscribeDaemonEvents(path)) {
      events.push(event);
      break; // Break after first event
    }

    await disconnectPromise;

    expect(events).toHaveLength(1);
    expect(events[0]!.action).toBe("file_write");
    expect(clientDisconnected).toBe(true);
  });
});
