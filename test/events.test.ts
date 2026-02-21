import { describe, test, expect } from "bun:test";
import { parseVaultEvent, matchesFilter } from "../sdk/src/events.js";
import type { VaultEvent } from "../sdk/src/events.js";

describe("parseVaultEvent", () => {
  test("parses file_updated", () => {
    const event = parseVaultEvent(
      "file_updated",
      JSON.stringify({
        id: "u1",
        contributor: "alice",
        path: "notes/hello.md",
        size: 42,
        modifiedAt: "2026-01-01T00:00:00Z",
      }),
    );
    expect(event).not.toBeNull();
    expect(event!.type).toBe("file_updated");
    if (event!.type === "file_updated") {
      expect(event!.id).toBe("u1");
      expect(event!.contributor).toBe("alice");
      expect(event!.path).toBe("notes/hello.md");
      expect(event!.size).toBe(42);
      expect(event!.modifiedAt).toBe("2026-01-01T00:00:00Z");
    }
  });

  test("parses file_deleted", () => {
    const event = parseVaultEvent(
      "file_deleted",
      JSON.stringify({
        id: "d1",
        contributor: "bob",
        path: "notes/bye.md",
      }),
    );
    expect(event).not.toBeNull();
    expect(event!.type).toBe("file_deleted");
    if (event!.type === "file_deleted") {
      expect(event!.id).toBe("d1");
      expect(event!.contributor).toBe("bob");
      expect(event!.path).toBe("notes/bye.md");
    }
  });

  test("parses activity", () => {
    const event = parseVaultEvent(
      "activity",
      JSON.stringify({
        id: "a1",
        contributor: "alice",
        action: "file_upserted",
        detail: "wrote a file",
        created_at: "2026-01-01T00:00:00Z",
      }),
    );
    expect(event).not.toBeNull();
    expect(event!.type).toBe("activity");
    if (event!.type === "activity") {
      expect(event!.id).toBe("a1");
      expect(event!.contributor).toBe("alice");
      expect(event!.action).toBe("file_upserted");
      expect(event!.detail).toBe("wrote a file");
      expect(event!.created_at).toBe("2026-01-01T00:00:00Z");
    }
  });

  test("returns null for unknown event types", () => {
    const event = parseVaultEvent(
      "connected",
      JSON.stringify({}),
    );
    expect(event).toBeNull();
  });

  test("returns null for malformed JSON", () => {
    const event = parseVaultEvent("file_updated", "{bad json");
    expect(event).toBeNull();
  });

  test("provides defaults for missing fields", () => {
    const event = parseVaultEvent(
      "file_updated",
      JSON.stringify({}),
    );
    expect(event).not.toBeNull();
    if (event!.type === "file_updated") {
      expect(event!.id).toBe("");
      expect(event!.contributor).toBe("");
      expect(event!.path).toBe("");
      expect(event!.size).toBe(0);
      expect(event!.modifiedAt).toBe("");
    }
  });

  test("coerces wrong types to defaults", () => {
    const event = parseVaultEvent(
      "file_updated",
      JSON.stringify({
        id: 123,
        contributor: true,
        path: null,
        size: "42",
        modifiedAt: undefined,
      }),
    );
    expect(event).not.toBeNull();
    if (event!.type === "file_updated") {
      expect(event!.id).toBe("");
      expect(event!.contributor).toBe("");
      expect(event!.path).toBe("");
      expect(event!.size).toBe(0);
      expect(event!.modifiedAt).toBe("");
    }
  });

  test("coerces non-string detail to null", () => {
    const event = parseVaultEvent(
      "activity",
      JSON.stringify({
        id: "a1",
        contributor: "alice",
        action: "file_upserted",
        detail: 42,
        created_at: "2026-01-01T00:00:00Z",
      }),
    );
    expect(event).not.toBeNull();
    if (event!.type === "activity") {
      expect(event!.detail).toBeNull();
    }
  });
});

describe("matchesFilter", () => {
  const fileEvent: VaultEvent = {
    type: "file_updated",
    id: "u1",
    contributor: "alice",
    path: "a.md",
    size: 10,
    modifiedAt: "2026-01-01T00:00:00Z",
  };

  const activityEvent: VaultEvent = {
    type: "activity",
    id: "a1",
    contributor: "bob",
    action: "file_upserted",
    detail: null,
    created_at: "2026-01-01T00:00:00Z",
  };

  test("no filter passes all events", () => {
    expect(matchesFilter(fileEvent)).toBe(true);
    expect(matchesFilter(activityEvent)).toBe(true);
    expect(matchesFilter(fileEvent, {})).toBe(true);
  });

  test("contributor filter", () => {
    expect(
      matchesFilter(fileEvent, { contributor: "alice" }),
    ).toBe(true);
    expect(
      matchesFilter(fileEvent, { contributor: "bob" }),
    ).toBe(false);
  });

  test("eventTypes filter", () => {
    expect(
      matchesFilter(fileEvent, { eventTypes: ["file_updated"] }),
    ).toBe(true);
    expect(
      matchesFilter(fileEvent, { eventTypes: ["file_deleted"] }),
    ).toBe(false);
    expect(
      matchesFilter(activityEvent, { eventTypes: ["activity"] }),
    ).toBe(true);
  });

  test("combined contributor and eventTypes filter", () => {
    expect(
      matchesFilter(fileEvent, {
        contributor: "alice",
        eventTypes: ["file_updated"],
      }),
    ).toBe(true);
    expect(
      matchesFilter(fileEvent, {
        contributor: "alice",
        eventTypes: ["file_deleted"],
      }),
    ).toBe(false);
    expect(
      matchesFilter(fileEvent, {
        contributor: "bob",
        eventTypes: ["file_updated"],
      }),
    ).toBe(false);
  });
});
