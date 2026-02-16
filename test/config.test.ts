import { describe, test, expect } from "bun:test";
import { homedir } from "os";
import {
  addCollection,
  removeCollection,
  normalizeConfigCollections,
  defaultCollectionName,
  type Config,
} from "../cli/src/config.js";

function baseConfig(collections: Config["collections"] = []): Config {
  return {
    server: "http://127.0.0.1:3000",
    token: "sv_test",
    username: "test-user",
    collections,
  };
}

// --- addCollection ---

describe("addCollection", () => {
  test("duplicate path detection throws", () => {
    const config = baseConfig([
      { name: "notes", path: "/tmp/notes" },
    ]);

    expect(() => addCollection(config, "/tmp/notes", "other")).toThrow(
      "Collection path '/tmp/notes' is already configured."
    );
  });

  test("duplicate name detection throws", () => {
    const config = baseConfig([
      { name: "notes", path: "/tmp/notes" },
    ]);

    expect(() => addCollection(config, "/tmp/docs", "notes")).toThrow(
      "A collection named 'notes' already exists. Use --name to pick a different name."
    );
  });

  test("tilde expansion resolves to homedir", () => {
    const config = baseConfig();
    const result = addCollection(config, "~/Documents", "docs");
    const added = result.config.collections[0];

    expect(added.path).toContain(homedir());
    expect(added.path).toContain("Documents");
    expect(added.path.startsWith("/")).toBe(true);
  });

  test("relative path resolves to absolute", () => {
    const config = baseConfig();
    const result = addCollection(config, ".", "cwd");
    const added = result.config.collections[0];

    expect(added.path).toBe(process.cwd());
  });

  test("child under existing parent is rejected", () => {
    const config = baseConfig([
      { name: "parent", path: "/tmp/notes" },
    ]);

    expect(() => addCollection(config, "/tmp/notes/sub", "sub")).toThrow(
      "Cannot add '/tmp/notes/sub' because it is inside existing collection 'parent' (/tmp/notes)."
    );
  });

  test("adding parent removes existing children", () => {
    const config = baseConfig([
      { name: "a", path: "/tmp/notes/a" },
      { name: "b", path: "/tmp/notes/b" },
    ]);

    const result = addCollection(config, "/tmp/notes", "parent");

    expect(
      result.removedChildCollections.map((c) => c.name).sort()
    ).toEqual(["a", "b"]);
    expect(result.config.collections).toEqual([
      { name: "parent", path: "/tmp/notes" },
    ]);
  });

  test("no conflicts keeps both collections", () => {
    const config = baseConfig([
      { name: "notes", path: "/tmp/notes" },
    ]);

    const result = addCollection(config, "/tmp/docs", "docs");

    expect(result.config.collections).toEqual([
      { name: "notes", path: "/tmp/notes" },
      { name: "docs", path: "/tmp/docs" },
    ]);
    expect(result.removedChildCollections).toEqual([]);
  });

  test("name collision with removed child is allowed", () => {
    const config = baseConfig([
      { name: "notes", path: "/tmp/notes/project" },
    ]);

    const result = addCollection(config, "/tmp/notes", "notes");

    expect(result.removedChildCollections).toEqual([
      { name: "notes", path: "/tmp/notes/project" },
    ]);
    expect(result.config.collections).toEqual([
      { name: "notes", path: "/tmp/notes" },
    ]);
  });
});

// --- removeCollection ---

describe("removeCollection", () => {
  test("removes an existing collection", () => {
    const config = baseConfig([
      { name: "a", path: "/tmp/a" },
      { name: "b", path: "/tmp/b" },
    ]);

    const result = removeCollection(config, "a");

    expect(result.collections).toEqual([
      { name: "b", path: "/tmp/b" },
    ]);
  });

  test("throws when removing a nonexistent collection", () => {
    const config = baseConfig([
      { name: "a", path: "/tmp/a" },
    ]);

    expect(() => removeCollection(config, "missing")).toThrow(
      "No collection named 'missing' found."
    );
  });

  test("removing the last collection leaves an empty array", () => {
    const config = baseConfig([
      { name: "only", path: "/tmp/only" },
    ]);

    const result = removeCollection(config, "only");

    expect(result.collections).toEqual([]);
  });
});

// --- normalizeConfigCollections ---

describe("normalizeConfigCollections", () => {
  test("returns same config when no overlaps exist", () => {
    const config = baseConfig([
      { name: "notes", path: "/tmp/notes" },
      { name: "docs", path: "/tmp/docs" },
    ]);

    const result = normalizeConfigCollections(config);

    expect(result.config).toBe(config);
    expect(result.removedOverlappingCollections).toEqual([]);
  });

  test("deduplicates identical paths keeping the first", () => {
    const config = baseConfig([
      { name: "first", path: "/tmp/notes" },
      { name: "second", path: "/tmp/notes" },
    ]);

    const result = normalizeConfigCollections(config);

    expect(result.config.collections).toEqual([
      { name: "first", path: "/tmp/notes" },
    ]);
    expect(result.removedOverlappingCollections).toEqual([
      { name: "second", path: "/tmp/notes" },
    ]);
  });

  test("removes child collection under parent", () => {
    const config = baseConfig([
      { name: "parent", path: "/tmp/notes" },
      { name: "child", path: "/tmp/notes/sub" },
    ]);

    const result = normalizeConfigCollections(config);

    expect(result.config.collections).toEqual([
      { name: "parent", path: "/tmp/notes" },
    ]);
    expect(result.removedOverlappingCollections).toEqual([
      { name: "child", path: "/tmp/notes/sub" },
    ]);
  });

  test("removes multiple children under one parent", () => {
    const config = baseConfig([
      { name: "parent", path: "/tmp/notes" },
      { name: "a", path: "/tmp/notes/a" },
      { name: "b", path: "/tmp/notes/b" },
      { name: "other", path: "/tmp/other" },
    ]);

    const result = normalizeConfigCollections(config);

    expect(
      result.config.collections.map((c) => c.name).sort()
    ).toEqual(["other", "parent"]);
    expect(
      result.removedOverlappingCollections.map((c) => c.name).sort()
    ).toEqual(["a", "b"]);
  });

  test("complex hierarchy keeps only the parent", () => {
    const config = baseConfig([
      { name: "root", path: "/tmp/notes" },
      { name: "child", path: "/tmp/notes/sub" },
      { name: "grandchild", path: "/tmp/notes/sub/deep" },
    ]);

    const result = normalizeConfigCollections(config);

    expect(result.config.collections).toEqual([
      { name: "root", path: "/tmp/notes" },
    ]);
    expect(
      result.removedOverlappingCollections.map((c) => c.name).sort()
    ).toEqual(["child", "grandchild"]);
  });
});

// --- defaultCollectionName ---

describe("defaultCollectionName", () => {
  test("returns basename of a simple path", () => {
    expect(defaultCollectionName("/tmp/notes")).toBe("notes");
  });

  test("returns basename of a nested path", () => {
    expect(defaultCollectionName("/home/user/projects/my-app")).toBe(
      "my-app"
    );
  });

  test("handles tilde path by returning basename", () => {
    expect(defaultCollectionName("~/notes")).toBe("notes");
  });

  test("throws for root path", () => {
    expect(() => defaultCollectionName("/")).toThrow(
      "Cannot derive name from path"
    );
  });
});
