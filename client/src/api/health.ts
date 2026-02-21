import { join } from "path";
import { readFileSync, writeFileSync } from "fs";
import { getConfigDir } from "../config.js";

const HEALTH_FILE = "daemon-health.json";

export interface DaemonHealth {
  running: boolean;
  serverConnected: boolean;
  serverUrl: string | null;
  username: string | null;
  pendingOps: number;
  collectionsWatched: number;
  watcherAlive: boolean;
  lastSyncAt: string | null;
  lastReconcileAt: string | null;
  updatedAt: string;
}

/**
 * Read the daemon's health status from disk.
 * Returns null if the health file doesn't exist (daemon not running or just started).
 */
export function getDaemonHealth(configDir?: string): DaemonHealth | null {
  const filePath = join(configDir ?? getConfigDir(), HEALTH_FILE);
  try {
    const raw = readFileSync(filePath, "utf-8");
    return JSON.parse(raw) as DaemonHealth;
  } catch {
    return null;
  }
}

/**
 * Write the daemon's health status to disk.
 * Called periodically by the daemon and on shutdown.
 */
export function writeHealthFile(
  health: DaemonHealth,
  configDir?: string,
): void {
  const filePath = join(configDir ?? getConfigDir(), HEALTH_FILE);
  writeFileSync(filePath, JSON.stringify(health, null, 2) + "\n");
}
