/**
 * QMD integration via CLI.
 *
 * Shells out to `qmd` for collection management, indexing, and search.
 * Assumes `qmd` is installed and on PATH.
 */

import type { Contributor } from "./db.js";

/** Check if QMD is available on PATH */
export async function isQmdAvailable(): Promise<boolean> {
  try {
    const proc = Bun.spawn(["qmd", "status"], { stdout: "pipe", stderr: "pipe" });
    await proc.exited;
    return true;
  } catch {
    return false;
  }
}

/** Register a contributor as a QMD collection */
export async function addCollection(
  storageRoot: string,
  contributor: Contributor
): Promise<void> {
  const dir = `${storageRoot}/${contributor.id}`;
  const proc = Bun.spawn(
    ["qmd", "collection", "add", dir, "--name", contributor.name, "--mask", "**/*.md"],
    { stdout: "pipe", stderr: "pipe" }
  );
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    // Ignore "already exists" errors
    if (!stderr.includes("already exists")) {
      console.error(`QMD collection add failed for ${contributor.name}:`, stderr);
    }
  }
}

/** Remove a contributor's QMD collection */
export async function removeCollection(contributorName: string): Promise<void> {
  const proc = Bun.spawn(
    ["qmd", "collection", "remove", contributorName],
    { stdout: "pipe", stderr: "pipe" }
  );
  await proc.exited;
}

/**
 * Trigger QMD to re-index. Called after file writes/deletes.
 * Runs async — does not block the caller.
 */
let updateInFlight = false;
let updateQueued = false;

export function triggerUpdate(): void {
  if (updateInFlight) {
    updateQueued = true;
    return;
  }
  runUpdate();
}

async function runUpdate(): Promise<void> {
  updateInFlight = true;
  try {
    const proc = Bun.spawn(["qmd", "update"], { stdout: "pipe", stderr: "pipe" });
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      const stderr = await new Response(proc.stderr).text();
      console.error("QMD update failed:", stderr);
    }
  } catch (e) {
    console.error("QMD update error:", e);
  } finally {
    updateInFlight = false;
    if (updateQueued) {
      updateQueued = false;
      runUpdate();
    }
  }
}

export interface QmdSearchResult {
  contributor?: string;
  path: string;
  snippet: string;
  score: number;
}

/** Search via QMD CLI */
export async function search(
  query: string,
  options: { collection?: string; limit?: number } = {}
): Promise<QmdSearchResult[]> {
  const limit = options.limit ?? 10;
  const args = ["search", query, "--json", "-n", String(limit)];
  if (options.collection) {
    args.push("-c", options.collection);
  }

  try {
    const proc = Bun.spawn(["qmd", ...args], { stdout: "pipe", stderr: "pipe" });
    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;

    if (exitCode !== 0) {
      const stderr = await new Response(proc.stderr).text();
      console.error("QMD search failed:", stderr);
      return [];
    }

    if (!stdout.trim()) return [];
    return JSON.parse(stdout);
  } catch (e) {
    console.error("QMD search error:", e);
    return [];
  }
}

/**
 * Register all existing contributors as QMD collections on startup.
 */
export async function syncContributors(
  storageRoot: string,
  contributors: Contributor[]
): Promise<void> {
  for (const contributor of contributors) {
    await addCollection(storageRoot, contributor);
  }
}
