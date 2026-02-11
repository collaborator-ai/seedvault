import { describe, test, expect } from "bun:test";
import {
  addCollection,
  normalizeConfigCollections,
  type Config,
} from "../cli/src/config.js";

function baseConfig(collections: Config["collections"]): Config {
  return {
    server: "http://127.0.0.1:3000",
    token: "sv_test",
    contributorId: "contributor_test",
    collections,
  };
}

describe("collection overlap policy", () => {
  test("rejects adding a child folder under an existing collection", () => {
    const config = baseConfig([
      { name: "parent", path: "/tmp/notes" },
    ]);

    expect(() => addCollection(config, "/tmp/notes/sub", "child")).toThrow(
      "Cannot add '/tmp/notes/sub' because it is inside existing collection 'parent' (/tmp/notes)."
    );
  });

  test("adding a parent folder removes existing child collections", () => {
    const config = baseConfig([
      { name: "child-a", path: "/tmp/notes/projectA" },
      { name: "child-b", path: "/tmp/notes/projectB" },
      { name: "sibling", path: "/tmp/other" },
    ]);

    const result = addCollection(config, "/tmp/notes", "parent");

    expect(result.removedChildCollections.map((c) => c.name).sort()).toEqual(["child-a", "child-b"]);
    expect(result.config.collections.map((c) => c.name).sort()).toEqual(["parent", "sibling"]);
  });

  test("allows parent add when name matches a removed child collection", () => {
    const config = baseConfig([
      { name: "notes", path: "/tmp/notes/project" },
    ]);

    const result = addCollection(config, "/tmp/notes", "notes");
    expect(result.removedChildCollections.map((c) => c.name)).toEqual(["notes"]);
    expect(result.config.collections).toEqual([{ name: "notes", path: "/tmp/notes" }]);
  });
});

describe("collection normalization", () => {
  test("normalizes overlapping config by keeping parent collections", () => {
    const config = baseConfig([
      { name: "child", path: "/tmp/notes/sub" },
      { name: "parent", path: "/tmp/notes" },
      { name: "other", path: "/tmp/elsewhere" },
    ]);

    const normalized = normalizeConfigCollections(config);

    expect(normalized.config.collections.map((c) => c.name).sort()).toEqual(["other", "parent"]);
    expect(normalized.removedOverlappingCollections.map((c) => c.name)).toContain("child");
  });
});
