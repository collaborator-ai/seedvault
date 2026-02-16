import { describe, test, expect } from "bun:test";
import {
  validateUsername,
  validatePath,
  validateOriginCtime,
} from "../server/src/db.js";

// --- validateUsername ---

describe("validateUsername", () => {
  describe("valid usernames", () => {
    test("single character", () => {
      expect(validateUsername("a")).toBeNull();
      expect(validateUsername("0")).toBeNull();
      expect(validateUsername("z")).toBeNull();
      expect(validateUsername("9")).toBeNull();
    });

    test("two characters", () => {
      expect(validateUsername("ab")).toBeNull();
      expect(validateUsername("a1")).toBeNull();
    });

    test("with hyphens", () => {
      expect(validateUsername("test-user")).toBeNull();
      expect(validateUsername("a-b-c")).toBeNull();
      expect(validateUsername("my-long-username")).toBeNull();
    });

    test("with numbers", () => {
      expect(validateUsername("user123")).toBeNull();
      expect(validateUsername("123user")).toBeNull();
      expect(validateUsername("1a2b3c")).toBeNull();
    });

    test("max length (63 chars)", () => {
      const name = "a" + "-b".repeat(31);
      expect(name.length).toBe(63);
      expect(validateUsername(name)).toBeNull();
    });
  });

  describe("invalid usernames", () => {
    test("empty string", () => {
      expect(validateUsername("")).toBe("Username is required");
    });

    test("too long (64+ chars)", () => {
      const name = "a".repeat(64);
      expect(validateUsername(name)).toBe(
        "Username must be 63 characters or fewer"
      );
    });

    test("uppercase letters", () => {
      const err = validateUsername("TestUser");
      expect(err).toContain("lowercase");
    });

    test("starts with hyphen", () => {
      const err = validateUsername("-user");
      expect(err).toContain("starting and ending with alphanumeric");
    });

    test("ends with hyphen", () => {
      const err = validateUsername("user-");
      expect(err).toContain("starting and ending with alphanumeric");
    });

    test("contains special characters", () => {
      expect(validateUsername("user@name")).not.toBeNull();
      expect(validateUsername("user!name")).not.toBeNull();
      expect(validateUsername("user#name")).not.toBeNull();
    });

    test("contains spaces", () => {
      expect(validateUsername("test user")).not.toBeNull();
    });

    test("contains dots", () => {
      expect(validateUsername("test.user")).not.toBeNull();
    });

    test("contains underscores", () => {
      expect(validateUsername("test_user")).not.toBeNull();
    });
  });
});

// --- validatePath ---

describe("validatePath", () => {
  describe("valid paths", () => {
    test("simple filename", () => {
      expect(validatePath("file.md")).toBeNull();
    });

    test("single nested path", () => {
      expect(validatePath("folder/file.md")).toBeNull();
    });

    test("deeply nested path", () => {
      expect(validatePath("a/b/c/deep.md")).toBeNull();
    });

    test("filename with hyphens", () => {
      expect(validatePath("my-file.md")).toBeNull();
    });

    test("path with date-like segments", () => {
      expect(validatePath("notes/2024/jan.md")).toBeNull();
    });
  });

  describe("invalid paths", () => {
    test("empty string", () => {
      expect(validatePath("")).toBe("Path cannot be empty");
    });

    test("starts with slash", () => {
      expect(validatePath("/file.md")).toBe("Path cannot start with /");
    });

    test("contains backslash", () => {
      expect(validatePath("folder\\file.md")).toBe(
        "Path cannot contain backslashes"
      );
    });

    test("double slash", () => {
      expect(validatePath("folder//file.md")).toBe(
        "Path cannot contain double slashes"
      );
    });

    test("does not end in .md (txt)", () => {
      expect(validatePath("file.txt")).toBe("Path must end in .md");
    });

    test("does not end in .md (no extension)", () => {
      expect(validatePath("file")).toBe("Path must end in .md");
    });

    test("dot segment at start", () => {
      expect(validatePath("./file.md")).toBe(
        "Path cannot contain . or .. segments"
      );
    });

    test("dot-dot traversal", () => {
      expect(validatePath("folder/../file.md")).toBe(
        "Path cannot contain . or .. segments"
      );
    });

    test("dot-dot segment in deeper path", () => {
      expect(validatePath("folder/../secret.md")).toBe(
        "Path cannot contain . or .. segments"
      );
    });
  });
});

// --- validateOriginCtime ---

describe("validateOriginCtime", () => {
  const VALID_CTIME = "2025-06-15T10:00:00.000Z";
  const VALID_MTIME = "2025-06-15T12:00:00.000Z";
  const EPOCH = "1970-01-01T00:00:00.000Z";

  test("returns ctime when ctime is valid", () => {
    expect(validateOriginCtime(VALID_CTIME, VALID_MTIME)).toBe(VALID_CTIME);
  });

  test("returns ctime when ctime is valid and mtime is undefined", () => {
    expect(validateOriginCtime(VALID_CTIME, undefined)).toBe(VALID_CTIME);
  });

  test("falls back to mtime when ctime is epoch", () => {
    expect(validateOriginCtime(EPOCH, VALID_MTIME)).toBe(VALID_MTIME);
  });

  test("falls back to mtime when ctime is undefined", () => {
    expect(validateOriginCtime(undefined, VALID_MTIME)).toBe(VALID_MTIME);
  });

  test("falls back to now when both are epoch", () => {
    const before = Date.now();
    const result = validateOriginCtime(EPOCH, EPOCH);
    const after = Date.now();

    const resultMs = new Date(result).getTime();
    expect(resultMs).toBeGreaterThanOrEqual(before);
    expect(resultMs).toBeLessThanOrEqual(after);
  });

  test("falls back to now when both are undefined", () => {
    const before = Date.now();
    const result = validateOriginCtime(undefined, undefined);
    const after = Date.now();

    const resultMs = new Date(result).getTime();
    expect(resultMs).toBeGreaterThanOrEqual(before);
    expect(resultMs).toBeLessThanOrEqual(after);
  });

  test("falls back to now when ctime is invalid date string", () => {
    const before = Date.now();
    const result = validateOriginCtime("not-a-date", undefined);
    const after = Date.now();

    const resultMs = new Date(result).getTime();
    expect(resultMs).toBeGreaterThanOrEqual(before);
    expect(resultMs).toBeLessThanOrEqual(after);
  });

  test("falls back to mtime when ctime is invalid, mtime is valid", () => {
    expect(validateOriginCtime("garbage", VALID_MTIME)).toBe(VALID_MTIME);
  });

  test("falls back to now when both are invalid date strings", () => {
    const before = Date.now();
    const result = validateOriginCtime("garbage", "also-garbage");
    const after = Date.now();

    const resultMs = new Date(result).getTime();
    expect(resultMs).toBeGreaterThanOrEqual(before);
    expect(resultMs).toBeLessThanOrEqual(after);
  });

  test("returns a valid ISO string in all fallback cases", () => {
    const result = validateOriginCtime(undefined, undefined);
    expect(new Date(result).toISOString()).toBe(result);
  });
});
