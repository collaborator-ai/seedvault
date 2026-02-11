import { readFileSync, existsSync } from "fs";
import { loadConfig, configExists, getPidPath } from "../config.js";
import { createClient } from "../client.js";

/**
 * sv status
 *
 * Show the current config, daemon status, and server connectivity.
 */
export async function status(): Promise<void> {
  if (!configExists()) {
    console.log("Not configured. Run 'sv init' first.");
    return;
  }

  const config = loadConfig();

  console.log("Seedvault Status\n");

  // Config
  console.log(`  Server:  ${config.server}`);
  console.log(`  Bank:    ${config.bankId}`);

  // Daemon
  const pidPath = getPidPath();
  if (existsSync(pidPath)) {
    const pid = parseInt(readFileSync(pidPath, "utf-8").trim(), 10);
    let alive = false;
    try {
      process.kill(pid, 0);
      alive = true;
    } catch {}

    if (alive) {
      console.log(`  Daemon:  running (PID ${pid})`);
    } else {
      console.log(`  Daemon:  not running (stale PID file)`);
    }
  } else {
    console.log("  Daemon:  not running");
  }

  // Folders
  if (config.folders.length === 0) {
    console.log("  Folders: none configured");
  } else {
    console.log(`  Folders: ${config.folders.length}`);
    for (const f of config.folders) {
      console.log(`    - ${f.label} -> ${f.path}`);
    }
  }

  // Server connectivity
  const client = createClient(config.server, config.token);
  try {
    await client.health();
    console.log("  Server:  reachable");
  } catch {
    console.log("  Server:  unreachable");
  }

  console.log();
}
