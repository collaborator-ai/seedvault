import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { RetryQueue, type QueuedOperation } from "../client/src/daemon/queue.js";
import { ApiError } from "../client/src/client.js";

function mockClient(overrides: {
  putFile?: (...args: any[]) => Promise<any>;
  deleteFile?: (...args: any[]) => Promise<any>;
} = {}) {
  return {
    putFile: overrides.putFile ?? (async () => ({})),
    deleteFile: overrides.deleteFile ?? (async () => {}),
  } as any;
}

function makeOp(overrides: Partial<QueuedOperation> = {}): QueuedOperation {
  return {
    type: "put",
    username: "testuser",
    serverPath: "notes/test.md",
    content: "# Test\n",
    queuedAt: new Date().toISOString(),
    originCtime: null,
    originMtime: null,
    ...overrides,
  };
}

let queue: RetryQueue;

afterEach(() => {
  queue?.stop();
});

describe("RetryQueue", () => {
  describe("basic operations", () => {
    test("put op calls client.putFile with correct args", async () => {
      const calls: any[][] = [];
      const client = mockClient({
        putFile: async (...args: any[]) => {
          calls.push(args);
          return {};
        },
      });

      queue = new RetryQueue(client);
      queue.enqueue(makeOp());
      await Bun.sleep(50);

      expect(calls).toHaveLength(1);
      expect(calls[0]![0]).toBe("testuser");
      expect(calls[0]![1]).toBe("notes/test.md");
      expect(calls[0]![2]).toBe("# Test\n");
      expect(calls[0]![3]).toBeUndefined();
    });

    test("delete op calls client.deleteFile with correct args", async () => {
      const calls: any[][] = [];
      const client = mockClient({
        deleteFile: async (...args: any[]) => {
          calls.push(args);
        },
      });

      queue = new RetryQueue(client);
      queue.enqueue(makeOp({
        type: "delete",
        content: null,
        serverPath: "notes/gone.md",
      }));
      await Bun.sleep(50);

      expect(calls).toHaveLength(1);
      expect(calls[0]![0]).toBe("testuser");
      expect(calls[0]![1]).toBe("notes/gone.md");
    });

    test("pending returns correct count before and after flush", async () => {
      const client = mockClient();
      queue = new RetryQueue(client);

      expect(queue.pending).toBe(0);

      queue.stop(); // prevent auto-flush
      queue.enqueue(makeOp());
      queue.enqueue(makeOp({ serverPath: "notes/b.md" }));
      queue.stop(); // cancel the scheduled flush

      expect(queue.pending).toBe(2);

      // Re-enqueue to trigger flush
      queue.enqueue(makeOp({ serverPath: "notes/c.md" }));
      await Bun.sleep(50);

      expect(queue.pending).toBe(0);
    });

    test("put op with originCtime/originMtime passes opts", async () => {
      const calls: any[][] = [];
      const client = mockClient({
        putFile: async (...args: any[]) => {
          calls.push(args);
          return {};
        },
      });

      queue = new RetryQueue(client);
      queue.enqueue(makeOp({
        originCtime: "2026-01-10T00:00:00Z",
        originMtime: "2026-01-12T00:00:00Z",
      }));
      await Bun.sleep(50);

      expect(calls).toHaveLength(1);
      expect(calls[0]![3]).toEqual({
        originCtime: "2026-01-10T00:00:00Z",
        originMtime: "2026-01-12T00:00:00Z",
      });
    });

    test("put op with only originMtime passes opts", async () => {
      const calls: any[][] = [];
      const client = mockClient({
        putFile: async (...args: any[]) => {
          calls.push(args);
          return {};
        },
      });

      queue = new RetryQueue(client);
      queue.enqueue(makeOp({
        originCtime: null,
        originMtime: "2026-01-12T00:00:00Z",
      }));
      await Bun.sleep(50);

      expect(calls).toHaveLength(1);
      expect(calls[0]![3]).toEqual({
        originCtime: undefined,
        originMtime: "2026-01-12T00:00:00Z",
      });
    });
  });

  describe("FIFO ordering", () => {
    test("ops are flushed in enqueue order", async () => {
      const order: string[] = [];
      const client = mockClient({
        putFile: async (_u: string, path: string) => {
          order.push(path);
          return {};
        },
        deleteFile: async (_u: string, path: string) => {
          order.push(`delete:${path}`);
        },
      });

      queue = new RetryQueue(client);
      queue.enqueue(makeOp({ serverPath: "a.md" }));
      queue.enqueue(makeOp({ serverPath: "b.md" }));
      queue.enqueue(makeOp({
        type: "delete",
        content: null,
        serverPath: "c.md",
      }));
      await Bun.sleep(50);

      expect(order).toEqual(["a.md", "b.md", "delete:c.md"]);
    });
  });

  describe("4xx ApiError handling (drop and continue)", () => {
    test("400 error drops the op and continues to next", async () => {
      const processed: string[] = [];
      let callCount = 0;
      const client = mockClient({
        putFile: async (_u: string, path: string) => {
          callCount++;
          if (path === "bad.md") {
            throw new ApiError(400, "bad request");
          }
          processed.push(path);
          return {};
        },
      });

      const messages: string[] = [];
      queue = new RetryQueue(client, (msg) => messages.push(msg));
      queue.enqueue(makeOp({ serverPath: "bad.md" }));
      queue.enqueue(makeOp({ serverPath: "good.md" }));
      await Bun.sleep(50);

      expect(processed).toEqual(["good.md"]);
      expect(queue.pending).toBe(0);
      expect(messages.some(
        (m) => m.includes("Dropping") && m.includes("bad.md") && m.includes("400")
      )).toBe(true);
    });

    test("404 error drops the op", async () => {
      const messages: string[] = [];
      const client = mockClient({
        deleteFile: async () => {
          throw new ApiError(404, "not found");
        },
      });

      queue = new RetryQueue(client, (msg) => messages.push(msg));
      queue.enqueue(makeOp({
        type: "delete",
        content: null,
        serverPath: "missing.md",
      }));
      await Bun.sleep(50);

      expect(queue.pending).toBe(0);
      expect(messages.some(
        (m) => m.includes("Dropping") && m.includes("missing.md") && m.includes("404")
      )).toBe(true);
    });

    test("409 error drops the op and processes remaining", async () => {
      const processed: string[] = [];
      const client = mockClient({
        putFile: async (_u: string, path: string) => {
          if (path === "conflict.md") {
            throw new ApiError(409, "conflict");
          }
          processed.push(path);
          return {};
        },
      });

      queue = new RetryQueue(client, () => {});
      queue.enqueue(makeOp({ serverPath: "conflict.md" }));
      queue.enqueue(makeOp({ serverPath: "ok.md" }));
      await Bun.sleep(50);

      expect(processed).toEqual(["ok.md"]);
      expect(queue.pending).toBe(0);
    });
  });

  describe("network error handling (retry with backoff)", () => {
    test("network error stops flushing and keeps op in queue", async () => {
      const client = mockClient({
        putFile: async () => {
          throw new Error("fetch failed");
        },
      });

      const messages: string[] = [];
      queue = new RetryQueue(client, (msg) => messages.push(msg));
      queue.enqueue(makeOp());
      queue.enqueue(makeOp({ serverPath: "b.md" }));
      await Bun.sleep(50);

      expect(queue.pending).toBe(2);
      expect(messages.some(
        (m) => m.includes("Server unreachable") && m.includes("fetch failed")
      )).toBe(true);
    });

    test("status message includes op count and retry delay", async () => {
      const client = mockClient({
        putFile: async () => {
          throw new Error("connection reset");
        },
      });

      const messages: string[] = [];
      queue = new RetryQueue(client, (msg) => messages.push(msg));
      queue.enqueue(makeOp());
      await Bun.sleep(50);

      expect(messages).toHaveLength(1);
      expect(messages[0]).toContain("1 op(s) queued");
      expect(messages[0]).toContain("Retry in 1s");
    });

    test("5xx ApiError is treated as network error (not dropped)", async () => {
      const client = mockClient({
        putFile: async () => {
          throw new ApiError(503, "service unavailable");
        },
      });

      const messages: string[] = [];
      queue = new RetryQueue(client, (msg) => messages.push(msg));
      queue.enqueue(makeOp());
      await Bun.sleep(50);

      expect(queue.pending).toBe(1);
      expect(messages.some(
        (m) => m.includes("Server unreachable")
      )).toBe(true);
    });
  });

  describe("backoff behavior", () => {
    test("backoff doubles after consecutive network errors", async () => {
      let callCount = 0;
      const client = mockClient({
        putFile: async () => {
          callCount++;
          throw new Error("offline");
        },
      });

      const messages: string[] = [];
      queue = new RetryQueue(client, (msg) => messages.push(msg));
      queue.enqueue(makeOp());

      // First failure: backoff starts at 1s
      await Bun.sleep(50);
      expect(messages[0]).toContain("Retry in 1s");

      // Stop to prevent the 1s retry, manually re-trigger
      queue.stop();
      queue.enqueue(makeOp({ serverPath: "b.md" }));

      // Second failure: backoff should be 2s
      await Bun.sleep(50);
      expect(messages[1]).toContain("Retry in 2s");

      // Stop and trigger again
      queue.stop();
      queue.enqueue(makeOp({ serverPath: "c.md" }));

      // Third failure: backoff should be 4s
      await Bun.sleep(50);
      expect(messages[2]).toContain("Retry in 4s");
    });

    test("backoff caps at 60s", async () => {
      const client = mockClient({
        putFile: async () => {
          throw new Error("offline");
        },
      });

      const messages: string[] = [];
      queue = new RetryQueue(client, (msg) => messages.push(msg));

      // Trigger enough failures to exceed 60s cap
      // 1s -> 2s -> 4s -> 8s -> 16s -> 32s -> 64s (capped to 60s)
      for (let i = 0; i < 7; i++) {
        queue.enqueue(makeOp({ serverPath: `f${i}.md` }));
        await Bun.sleep(50);
        queue.stop();
      }

      // The 7th message should show 60s (capped)
      expect(messages[6]).toContain("Retry in 60s");
    });

    test("backoff resets to 1s after a successful flush", async () => {
      let shouldFail = true;
      const client = mockClient({
        putFile: async () => {
          if (shouldFail) throw new Error("offline");
          return {};
        },
      });

      const messages: string[] = [];
      queue = new RetryQueue(client, (msg) => messages.push(msg));

      // First: network error (backoff = 1s, then doubles to 2s)
      queue.enqueue(makeOp());
      await Bun.sleep(50);
      expect(messages[0]).toContain("Retry in 1s");
      queue.stop();

      // Second: another network error (backoff = 2s)
      queue.enqueue(makeOp({ serverPath: "b.md" }));
      await Bun.sleep(50);
      expect(messages[1]).toContain("Retry in 2s");
      queue.stop();

      // Now succeed
      shouldFail = false;
      queue.enqueue(makeOp({ serverPath: "c.md" }));
      await Bun.sleep(50);

      // Backoff should have reset. Trigger another failure.
      shouldFail = true;
      queue.enqueue(makeOp({ serverPath: "d.md" }));
      await Bun.sleep(50);

      // Should be back to 1s, not 4s
      const retryMessages = messages.filter((m) => m.includes("Retry in"));
      expect(retryMessages[retryMessages.length - 1]).toContain("Retry in 1s");
    });
  });

  describe("stop()", () => {
    test("cancels pending flush so no ops are processed", async () => {
      const calls: string[] = [];
      const client = mockClient({
        putFile: async (_u: string, path: string) => {
          calls.push(path);
          return {};
        },
      });

      queue = new RetryQueue(client);
      queue.enqueue(makeOp());
      queue.stop();
      await Bun.sleep(50);

      expect(calls).toHaveLength(0);
      expect(queue.pending).toBe(1);
    });

    test("stop() is safe to call when nothing is queued", () => {
      const client = mockClient();
      queue = new RetryQueue(client);
      // Should not throw
      queue.stop();
      queue.stop();
    });
  });

  describe("flush completion", () => {
    test("reports all synced when queue is fully flushed", async () => {
      const messages: string[] = [];
      const client = mockClient();

      queue = new RetryQueue(client, (msg) => messages.push(msg));
      queue.enqueue(makeOp());
      queue.enqueue(makeOp({ serverPath: "b.md" }));
      await Bun.sleep(50);

      expect(messages).toContain("Queue flushed — all synced.");
    });

    test("does not report synced if network error halts flush", async () => {
      const messages: string[] = [];
      const client = mockClient({
        putFile: async () => {
          throw new Error("offline");
        },
      });

      queue = new RetryQueue(client, (msg) => messages.push(msg));
      queue.enqueue(makeOp());
      await Bun.sleep(50);

      expect(messages).not.toContain("Queue flushed — all synced.");
    });
  });

  describe("mixed put and delete operations", () => {
    test("processes interleaved put and delete ops", async () => {
      const ops: string[] = [];
      const client = mockClient({
        putFile: async (_u: string, path: string) => {
          ops.push(`put:${path}`);
          return {};
        },
        deleteFile: async (_u: string, path: string) => {
          ops.push(`delete:${path}`);
        },
      });

      const messages: string[] = [];
      queue = new RetryQueue(client, (msg) => messages.push(msg));
      queue.enqueue(makeOp({
        type: "put",
        serverPath: "a.md",
        content: "a",
      }));
      queue.enqueue(makeOp({
        type: "delete",
        serverPath: "b.md",
        content: null,
      }));
      queue.enqueue(makeOp({
        type: "put",
        serverPath: "c.md",
        content: "c",
      }));
      queue.enqueue(makeOp({
        type: "delete",
        serverPath: "d.md",
        content: null,
      }));
      await Bun.sleep(50);

      expect(ops).toEqual([
        "put:a.md",
        "delete:b.md",
        "put:c.md",
        "delete:d.md",
      ]);
      expect(queue.pending).toBe(0);
      expect(messages).toContain("Queue flushed — all synced.");
    });

    test("4xx on delete does not block subsequent puts", async () => {
      const processed: string[] = [];
      const client = mockClient({
        putFile: async (_u: string, path: string) => {
          processed.push(`put:${path}`);
          return {};
        },
        deleteFile: async () => {
          throw new ApiError(410, "gone");
        },
      });

      queue = new RetryQueue(client, () => {});
      queue.enqueue(makeOp({
        type: "delete",
        serverPath: "old.md",
        content: null,
      }));
      queue.enqueue(makeOp({
        type: "put",
        serverPath: "new.md",
        content: "hello",
      }));
      await Bun.sleep(50);

      expect(processed).toEqual(["put:new.md"]);
      expect(queue.pending).toBe(0);
    });
  });
});
