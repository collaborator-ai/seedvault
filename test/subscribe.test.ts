import { describe, test, expect, afterEach } from "bun:test";
import { createClient, type VaultEvent } from "../cli/src/client.js";

type TestServer = ReturnType<typeof Bun.serve>;

let servers: TestServer[] = [];

afterEach(() => {
  for (const s of servers) s.stop(true);
  servers = [];
});

function sseServer(
  events: string,
  opts?: { captureHeaders?: (h: Headers) => void },
): TestServer {
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      opts?.captureHeaders?.(req.headers);
      return new Response(events, {
        headers: { "Content-Type": "text/event-stream" },
      });
    },
  });
  servers.push(server);
  return server;
}

function sseBlock(
  eventType: string,
  data: Record<string, unknown>,
): string {
  return `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;
}

async function collect(
  gen: AsyncGenerator<VaultEvent>,
  count: number,
  timeoutMs = 2000,
): Promise<VaultEvent[]> {
  const results: VaultEvent[] = [];
  const deadline = Date.now() + timeoutMs;
  for await (const event of gen) {
    results.push(event);
    if (results.length >= count) break;
    if (Date.now() > deadline) break;
  }
  return results;
}

describe("subscribe", () => {
  test("yields VaultEvent for file_updated and file_deleted", async () => {
    const body =
      sseBlock("file_updated", {
        id: "u1",
        contributor: "alice",
        path: "notes/hello.md",
        size: 42,
        modifiedAt: "2026-01-01T00:00:00Z",
      }) +
      sseBlock("file_deleted", {
        id: "d1",
        contributor: "bob",
        path: "notes/bye.md",
      });

    const server = sseServer(body);
    const client = createClient(
      `http://localhost:${server.port}`,
      "tok",
    );
    const events = await collect(client.subscribe(), 2);

    expect(events).toHaveLength(2);

    expect(events[0]!.id).toBe("u1");
    expect(events[0]!.action).toBe("file_write");
    expect(events[0]!.contributor).toBe("alice");
    expect(events[0]!.path).toBe("notes/hello.md");
    expect(events[0]!.timestamp).toBe("2026-01-01T00:00:00Z");

    expect(events[1]!.id).toBe("d1");
    expect(events[1]!.action).toBe("file_delete");
    expect(events[1]!.contributor).toBe("bob");
    expect(events[1]!.path).toBe("notes/bye.md");
  });

  test("filters by contributor option", async () => {
    const body =
      sseBlock("file_updated", {
        id: "u1",
        contributor: "alice",
        path: "a.md",
        size: 1,
        modifiedAt: "2026-01-01T00:00:00Z",
      }) +
      sseBlock("file_updated", {
        id: "u2",
        contributor: "bob",
        path: "b.md",
        size: 2,
        modifiedAt: "2026-01-02T00:00:00Z",
      });

    const server = sseServer(body);
    const client = createClient(
      `http://localhost:${server.port}`,
      "tok",
    );
    const events = await collect(
      client.subscribe({ contributor: "bob" }),
      1,
    );

    expect(events).toHaveLength(1);
    expect(events[0]!.contributor).toBe("bob");
    expect(events[0]!.path).toBe("b.md");
  });

  test("filters by action option", async () => {
    const body =
      sseBlock("file_updated", {
        id: "u1",
        contributor: "alice",
        path: "a.md",
        size: 1,
        modifiedAt: "2026-01-01T00:00:00Z",
      }) +
      sseBlock("file_deleted", {
        id: "d1",
        contributor: "alice",
        path: "b.md",
      });

    const server = sseServer(body);
    const client = createClient(
      `http://localhost:${server.port}`,
      "tok",
    );
    const events = await collect(
      client.subscribe({ actions: ["file_delete"] }),
      1,
    );

    expect(events).toHaveLength(1);
    expect(events[0]!.action).toBe("file_delete");
    expect(events[0]!.path).toBe("b.md");
  });

  test("ignores activity and connected events", async () => {
    const body =
      sseBlock("connected", {}) +
      sseBlock("activity", {
        id: "a1",
        contributor: "alice",
        action: "file_write",
        detail: "wrote something",
        created_at: "2026-01-01T00:00:00Z",
      }) +
      sseBlock("file_updated", {
        id: "u1",
        contributor: "alice",
        path: "a.md",
        size: 1,
        modifiedAt: "2026-01-01T00:00:00Z",
      });

    const server = sseServer(body);
    const client = createClient(
      `http://localhost:${server.port}`,
      "tok",
    );
    const events = await collect(client.subscribe(), 1);

    expect(events).toHaveLength(1);
    expect(events[0]!.id).toBe("u1");
    expect(events[0]!.action).toBe("file_write");
  });

  test("sends Authorization header", async () => {
    let captured: Headers | null = null;

    const body = sseBlock("file_updated", {
      id: "u1",
      contributor: "alice",
      path: "a.md",
      size: 1,
      modifiedAt: "2026-01-01T00:00:00Z",
    });

    const server = sseServer(body, {
      captureHeaders: (h) => { captured = h; },
    });
    const client = createClient(
      `http://localhost:${server.port}`,
      "secret-token",
    );
    await collect(client.subscribe(), 1);

    expect(captured).not.toBeNull();
    expect(captured!.get("authorization")).toBe("Bearer secret-token");
  });
});
