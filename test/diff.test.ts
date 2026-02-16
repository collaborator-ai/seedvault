import { describe, test, expect } from "bun:test";
import { computeDiff } from "../server/src/diff.js";

describe("computeDiff", () => {
	// --- Null returns ---

	describe("null returns", () => {
		test("identical texts return null", () => {
			expect(computeDiff("hello\n", "hello\n")).toBeNull();
		});

		test("identical multi-line texts return null", () => {
			expect(computeDiff("a\nb\nc\n", "a\nb\nc\n")).toBeNull();
		});

		test("empty old text (new file) returns null", () => {
			expect(computeDiff("", "hello\n")).toBeNull();
		});

		test("both empty returns null (identical)", () => {
			expect(computeDiff("", "")).toBeNull();
		});
	});

	// --- Simple diffs ---

	describe("simple diffs", () => {
		test("single line changed", () => {
			const result = computeDiff("hello\n", "world\n");
			expect(result).not.toBeNull();
			expect(result!.truncated).toBe(false);
			expect(result!.diff).toContain("-hello");
			expect(result!.diff).toContain("+world");
		});

		test("line added at end", () => {
			const result = computeDiff("a\n", "a\nb\n");
			expect(result).not.toBeNull();
			expect(result!.truncated).toBe(false);
			expect(result!.diff).toContain("+b");
		});

		test("line deleted", () => {
			const result = computeDiff("a\nb\n", "a\n");
			expect(result).not.toBeNull();
			expect(result!.truncated).toBe(false);
			expect(result!.diff).toContain("-b");
		});

		test("line inserted in middle", () => {
			const result = computeDiff("a\nc\n", "a\nb\nc\n");
			expect(result).not.toBeNull();
			expect(result!.diff).toContain("+b");
			// "a" and "c" should appear as context
			expect(result!.diff).toContain(" a");
			expect(result!.diff).toContain(" c");
		});
	});

	// --- Diff format correctness ---

	describe("diff format", () => {
		test("contains hunk header with correct format", () => {
			const result = computeDiff("hello\n", "world\n");
			expect(result).not.toBeNull();
			// Match the @@ -X,Y +A,B @@ pattern
			expect(result!.diff).toMatch(/@@ -\d+,\d+ \+\d+,\d+ @@/);
		});

		test("hunk header has correct line counts", () => {
			// Replace one line with one line: old has 1 line, new has 1 line
			const result = computeDiff("hello\n", "world\n");
			expect(result).not.toBeNull();
			// "hello\n" splits to ["hello", ""], so 2 elements
			// Both old and new have same split length, change is at index 0
			expect(result!.diff).toContain("@@ -1,");
			expect(result!.diff).toContain("+1,");
		});

		test("context lines have space prefix", () => {
			const result = computeDiff("a\nb\nc\n", "a\nX\nc\n");
			expect(result).not.toBeNull();
			const lines = result!.diff.split("\n");
			const contextLines = lines.filter((l) => l.startsWith(" "));
			expect(contextLines.length).toBeGreaterThan(0);
			// "a" and "c" should be context lines
			expect(contextLines.some((l) => l === " a")).toBe(true);
			expect(contextLines.some((l) => l === " c")).toBe(true);
		});

		test("deletion lines have minus prefix", () => {
			const result = computeDiff("a\nb\nc\n", "a\nc\n");
			expect(result).not.toBeNull();
			const lines = result!.diff.split("\n");
			const deletions = lines.filter((l) => l.startsWith("-"));
			expect(deletions).toContain("-b");
		});

		test("addition lines have plus prefix", () => {
			const result = computeDiff("a\nc\n", "a\nb\nc\n");
			expect(result).not.toBeNull();
			const lines = result!.diff.split("\n");
			const additions = lines.filter((l) => l.startsWith("+"));
			expect(additions).toContain("+b");
		});

		test("truncated is false for small diffs", () => {
			const result = computeDiff("a\n", "b\n");
			expect(result).not.toBeNull();
			expect(result!.truncated).toBe(false);
		});
	});

	// --- Context lines ---

	describe("context lines", () => {
		test("shows 3 lines of context before and after a change", () => {
			// Build a file with 10 lines, change line 5 (0-indexed: 4)
			const lines = Array.from({ length: 10 }, (_, i) => `line${i}`);
			const oldText = lines.join("\n") + "\n";
			const newLines = [...lines];
			newLines[4] = "CHANGED";
			const newText = newLines.join("\n") + "\n";

			const result = computeDiff(oldText, newText);
			expect(result).not.toBeNull();

			const diffLines = result!.diff.split("\n");
			// 3 context lines before the change: line1, line2, line3
			expect(diffLines.some((l) => l === " line1")).toBe(true);
			expect(diffLines.some((l) => l === " line2")).toBe(true);
			expect(diffLines.some((l) => l === " line3")).toBe(true);
			// The change itself
			expect(diffLines.some((l) => l === "-line4")).toBe(true);
			expect(diffLines.some((l) => l === "+CHANGED")).toBe(true);
			// 3 context lines after the change: line5, line6, line7
			expect(diffLines.some((l) => l === " line5")).toBe(true);
			expect(diffLines.some((l) => l === " line6")).toBe(true);
			expect(diffLines.some((l) => l === " line7")).toBe(true);
			// line8, line9 should NOT be in the diff (beyond context)
			expect(diffLines.some((l) => l === " line8")).toBe(false);
		});

		test("separate changes produce separate hunks", () => {
			// 20 lines, change line 2 and line 18 (far apart)
			const lines = Array.from({ length: 20 }, (_, i) => `line${i}`);
			const oldText = lines.join("\n") + "\n";
			const newLines = [...lines];
			newLines[1] = "FIRST_CHANGE";
			newLines[17] = "SECOND_CHANGE";
			const newText = newLines.join("\n") + "\n";

			const result = computeDiff(oldText, newText);
			expect(result).not.toBeNull();

			// Count hunk headers
			const hunkHeaders = result!.diff
				.split("\n")
				.filter((l) => l.startsWith("@@"));
			expect(hunkHeaders.length).toBe(2);

			expect(result!.diff).toContain("-line1");
			expect(result!.diff).toContain("+FIRST_CHANGE");
			expect(result!.diff).toContain("-line17");
			expect(result!.diff).toContain("+SECOND_CHANGE");
		});

		test("nearby changes are merged into one hunk", () => {
			// Changes on line 3 and line 5 (only 1 line apart)
			const lines = Array.from({ length: 10 }, (_, i) => `line${i}`);
			const oldText = lines.join("\n") + "\n";
			const newLines = [...lines];
			newLines[2] = "CHANGE_A";
			newLines[4] = "CHANGE_B";
			const newText = newLines.join("\n") + "\n";

			const result = computeDiff(oldText, newText);
			expect(result).not.toBeNull();

			const hunkHeaders = result!.diff
				.split("\n")
				.filter((l) => l.startsWith("@@"));
			expect(hunkHeaders.length).toBe(1);
		});
	});

	// --- Truncation ---

	describe("truncation", () => {
		test("diff larger than 5000 bytes sets truncated=true", () => {
			// Generate a large diff by changing many lines
			const count = 500;
			const oldLines = Array.from(
				{ length: count },
				(_, i) => `old-line-${i}-${"x".repeat(20)}`,
			);
			const newLines = Array.from(
				{ length: count },
				(_, i) => `new-line-${i}-${"y".repeat(20)}`,
			);
			const oldText = oldLines.join("\n") + "\n";
			const newText = newLines.join("\n") + "\n";

			const result = computeDiff(oldText, newText);
			expect(result).not.toBeNull();
			expect(result!.truncated).toBe(true);
			expect(result!.diff.length).toBeLessThanOrEqual(5000);
		});

		test("diff smaller than 5000 bytes sets truncated=false", () => {
			const result = computeDiff("hello\nworld\n", "hello\nearth\n");
			expect(result).not.toBeNull();
			expect(result!.truncated).toBe(false);
			expect(result!.diff.length).toBeLessThan(5000);
		});
	});

	// --- Edge cases ---

	describe("edge cases", () => {
		test("single line files without trailing newline", () => {
			const result = computeDiff("hello", "world");
			expect(result).not.toBeNull();
			expect(result!.diff).toContain("-hello");
			expect(result!.diff).toContain("+world");
		});

		test("completely different files", () => {
			const result = computeDiff("aaa\nbbb\nccc\n", "xxx\nyyy\nzzz\n");
			expect(result).not.toBeNull();
			expect(result!.diff).toContain("-aaa");
			expect(result!.diff).toContain("-bbb");
			expect(result!.diff).toContain("-ccc");
			expect(result!.diff).toContain("+xxx");
			expect(result!.diff).toContain("+yyy");
			expect(result!.diff).toContain("+zzz");
		});

		test("old has content, new has more lines", () => {
			const newLines = Array.from({ length: 10 }, (_, i) => `line${i}`);
			const result = computeDiff("x\n", "x\n" + newLines.join("\n") + "\n");
			expect(result).not.toBeNull();
			expect(result!.diff).toContain("+line0");
			expect(result!.diff).toContain("+line9");
		});

		test("multi-line additions and deletions", () => {
			const oldText = "keep\nremove1\nremove2\nremove3\nkeep2\n";
			const newText = "keep\nadd1\nadd2\nkeep2\n";
			const result = computeDiff(oldText, newText);
			expect(result).not.toBeNull();
			expect(result!.diff).toContain("-remove1");
			expect(result!.diff).toContain("-remove2");
			expect(result!.diff).toContain("-remove3");
			expect(result!.diff).toContain("+add1");
			expect(result!.diff).toContain("+add2");
			expect(result!.diff).toContain(" keep");
			expect(result!.diff).toContain(" keep2");
		});

		test("adding trailing newline to file without one", () => {
			const result = computeDiff("hello", "hello\n");
			expect(result).not.toBeNull();
			// The split behavior means the empty string after \n is new
		});

		test("removing trailing newline", () => {
			const result = computeDiff("hello\n", "hello");
			expect(result).not.toBeNull();
		});

		test("whitespace-only changes are detected", () => {
			const result = computeDiff("hello world\n", "hello  world\n");
			expect(result).not.toBeNull();
			expect(result!.diff).toContain("-hello world");
			expect(result!.diff).toContain("+hello  world");
		});

		test("empty lines in content", () => {
			const result = computeDiff("a\n\nb\n", "a\n\nc\n");
			expect(result).not.toBeNull();
			expect(result!.diff).toContain("-b");
			expect(result!.diff).toContain("+c");
		});
	});
});
