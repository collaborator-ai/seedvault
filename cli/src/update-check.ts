import { join } from "path";
import { homedir } from "os";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";

const CHECK_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const FETCH_TIMEOUT_MS = 3000;
const REGISTRY_URL =
  "https://registry.npmjs.org/@seedvault/client/latest";
const CHECK_FILE = join(
  homedir(),
  ".config",
  "seedvault",
  "update-check.json",
);

interface CheckState {
  lastCheck: number;
  latestVersion: string;
}

function readCheckState(): CheckState | null {
  try {
    const raw = readFileSync(CHECK_FILE, "utf-8");
    return JSON.parse(raw) as CheckState;
  } catch {
    return null;
  }
}

function writeCheckState(state: CheckState): void {
  const dir = join(homedir(), ".config", "seedvault");
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(CHECK_FILE, JSON.stringify(state) + "\n");
}

function isNewer(latest: string, current: string): boolean {
  const a = latest.split(".").map(Number);
  const b = current.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    if (av > bv) return true;
    if (av < bv) return false;
  }
  return false;
}

function getCurrentVersion(): string | null {
  try {
    const pkgPath = join(import.meta.dirname, "..", "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
    return pkg.version as string;
  } catch {
    return null;
  }
}

async function fetchLatestVersion(): Promise<string | null> {
  try {
    const res = await fetch(REGISTRY_URL, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { version: string };
    return data.version;
  } catch {
    return null;
  }
}

/**
 * Non-blocking update check. Returns a promise that resolves
 * to a notice string (print to stderr) or null.
 */
export async function checkForUpdates(): Promise<string | null> {
  const currentVersion = getCurrentVersion();
  if (!currentVersion) return null;

  const state = readCheckState();
  const now = Date.now();

  // Skip fetch if checked recently — but still notify from cache
  if (state && now - state.lastCheck < CHECK_INTERVAL_MS) {
    if (isNewer(state.latestVersion, currentVersion)) {
      return (
        `Update available: ${currentVersion} → ${state.latestVersion}` +
        `  (run \`sv update\`)`
      );
    }
    return null;
  }

  const latestVersion = await fetchLatestVersion();
  if (!latestVersion) return null;

  writeCheckState({ lastCheck: now, latestVersion });

  if (isNewer(latestVersion, currentVersion)) {
    return (
      `Update available: ${currentVersion} → ${latestVersion}` +
      `  (run \`sv update\`)`
    );
  }
  return null;
}
