import { describe, test, expect } from "bun:test";
import { EventBus } from "../client/src/daemon/event-bus.js";
import type { FileEvent } from "../client/src/daemon/watcher.js";

describe("EventBus", () => {
  test("subscriber receives emitted events", () => {
    const bus = new EventBus<FileEvent>();
    const received: FileEvent[] = [];
    bus.subscribe((e) => received.push(e));

    const event: FileEvent = {
      type: "add",
      serverPath: "notes/test.md",
      localPath: "/tmp/notes/test.md",
    };
    bus.emit(event);

    expect(received).toEqual([event]);
  });

  test("multiple subscribers all receive events", () => {
    const bus = new EventBus<FileEvent>();
    const a: FileEvent[] = [];
    const b: FileEvent[] = [];
    bus.subscribe((e) => a.push(e));
    bus.subscribe((e) => b.push(e));

    const event: FileEvent = {
      type: "change",
      serverPath: "notes/test.md",
      localPath: "/tmp/notes/test.md",
    };
    bus.emit(event);

    expect(a).toEqual([event]);
    expect(b).toEqual([event]);
  });

  test("unsubscribe stops delivery", () => {
    const bus = new EventBus<FileEvent>();
    const received: FileEvent[] = [];
    const unsub = bus.subscribe((e) => received.push(e));

    bus.emit({
      type: "add",
      serverPath: "a.md",
      localPath: "/tmp/a.md",
    });
    unsub();
    bus.emit({
      type: "add",
      serverPath: "b.md",
      localPath: "/tmp/b.md",
    });

    expect(received).toHaveLength(1);
    expect(received[0].serverPath).toBe("a.md");
  });

  test("subscriber count is accurate", () => {
    const bus = new EventBus<FileEvent>();
    expect(bus.subscriberCount).toBe(0);

    const unsub1 = bus.subscribe(() => {});
    expect(bus.subscriberCount).toBe(1);

    const unsub2 = bus.subscribe(() => {});
    expect(bus.subscriberCount).toBe(2);

    unsub1();
    expect(bus.subscriberCount).toBe(1);

    unsub2();
    expect(bus.subscriberCount).toBe(0);
  });
});
