const DIFF_MAX_BYTES = 5000;

/**
 * Compute a unified diff between two strings.
 * Returns null when both are identical or old is empty (new file).
 * Truncates output at DIFF_MAX_BYTES.
 */
export function computeDiff(
	oldText: string,
	newText: string,
): { diff: string; truncated: boolean } | null {
	if (oldText === newText) return null;
	if (oldText === "") return null;

	const oldLines = oldText.split("\n");
	const newLines = newText.split("\n");
	const editScript = myersDiff(oldLines, newLines);
	const hunks = buildHunks(editScript, oldLines, newLines, 3);

	let diff = "";
	let truncated = false;
	for (const hunk of hunks) {
		const header =
			`@@ -${hunk.oldStart},${hunk.oldCount}` +
			` +${hunk.newStart},${hunk.newCount} @@\n`;
		diff += header;
		for (const line of hunk.lines) {
			diff += line + "\n";
		}
		if (diff.length > DIFF_MAX_BYTES) {
			diff = diff.slice(0, DIFF_MAX_BYTES);
			truncated = true;
			break;
		}
	}

	return { diff, truncated };
}

const enum Op {
	Equal = 0,
	Insert = 1,
	Delete = 2,
}

interface Edit {
	op: Op;
	oldIdx: number;
	newIdx: number;
}

interface Hunk {
	oldStart: number;
	oldCount: number;
	newStart: number;
	newCount: number;
	lines: string[];
}

function myersDiff(a: string[], b: string[]): Edit[] {
	const n = a.length;
	const m = b.length;
	const max = n + m;
	const vSize = 2 * max + 1;
	const v = new Int32Array(vSize);
	v.fill(-1);
	const offset = max;
	v[offset + 1] = 0;

	const trace: Int32Array[] = [];

	outer: for (let d = 0; d <= max; d++) {
		trace.push(v.slice());
		for (let k = -d; k <= d; k += 2) {
			let x: number;
			if (k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])) {
				x = v[offset + k + 1];
			} else {
				x = v[offset + k - 1] + 1;
			}
			let y = x - k;
			while (x < n && y < m && a[x] === b[y]) {
				x++;
				y++;
			}
			v[offset + k] = x;
			if (x >= n && y >= m) break outer;
		}
	}

	const edits: Edit[] = [];
	let x = n;
	let y = m;
	for (let d = trace.length - 1; d >= 0; d--) {
		const tv = trace[d]!;
		const k = x - y;
		let prevK: number;
		if (k === -d || (k !== d && tv[offset + k - 1]! < tv[offset + k + 1]!)) {
			prevK = k + 1;
		} else {
			prevK = k - 1;
		}
		const prevX = tv[offset + prevK]!;
		const prevY = prevX - prevK;

		while (x > prevX && y > prevY) {
			x--;
			y--;
			edits.push({ op: Op.Equal, oldIdx: x, newIdx: y });
		}
		if (d > 0) {
			if (x === prevX) {
				edits.push({ op: Op.Insert, oldIdx: x, newIdx: prevY });
				y--;
			} else {
				edits.push({ op: Op.Delete, oldIdx: prevX, newIdx: y });
				x--;
			}
		}
	}

	edits.reverse();
	return edits;
}

function buildHunks(
	edits: Edit[],
	oldLines: string[],
	newLines: string[],
	context: number,
): Hunk[] {
	const hunks: Hunk[] = [];
	let i = 0;

	while (i < edits.length) {
		while (i < edits.length && edits[i]!.op === Op.Equal) i++;
		if (i >= edits.length) break;

		let start = i;
		for (let c = 0; c < context && start > 0; c++) start--;

		let end = i;
		while (end < edits.length) {
			if (edits[end]!.op !== Op.Equal) {
				end++;
				continue;
			}
			let run = 0;
			let j = end;
			while (j < edits.length && edits[j]!.op === Op.Equal) {
				run++;
				j++;
			}
			if (j >= edits.length || run > context * 2) {
				end = Math.min(end + context, edits.length);
				break;
			}
			end = j;
		}

		const hunkEdits = edits.slice(start, end);
		const firstEdit = hunkEdits[0]!;
		let oldStart = firstEdit.oldIdx + 1;
		let newStart = firstEdit.newIdx + 1;
		let oldCount = 0;
		let newCount = 0;
		const lines: string[] = [];

		for (const e of hunkEdits) {
			if (e.op === Op.Equal) {
				lines.push(" " + oldLines[e.oldIdx]);
				oldCount++;
				newCount++;
			} else if (e.op === Op.Delete) {
				lines.push("-" + oldLines[e.oldIdx]);
				oldCount++;
			} else {
				lines.push("+" + newLines[e.newIdx]);
				newCount++;
			}
		}

		hunks.push({ oldStart, oldCount, newStart, newCount, lines });
		i = end;
	}

	return hunks;
}
