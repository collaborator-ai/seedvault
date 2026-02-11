import { writeFileSync } from "fs";
import { loadConfig, getPidPath, getConfigDir } from "../config.js";
import { createClient } from "../client.js";
import { createWatcher } from "../daemon/watcher.js";
import { Syncer } from "../daemon/syncer.js";

/**
 * sv start [-d]
 *
 *   Foreground (default): runs the daemon in the current terminal.
 *   -d: detaches as a background process.
 */
export async function start(args: string[]): Promise<void> {
  const daemonize = args.includes("-d") || args.includes("--daemon");

  if (daemonize) {
    return startBackground();
  }

  return startForeground();
}

/** Run daemon in the foreground */
async function startForeground(): Promise<void> {
  const config = loadConfig();

  if (config.collections.length === 0) {
    console.error("No collections configured. Run 'sv add <path>' first.");
    process.exit(1);
  }

  const client = createClient(config.server, config.token);

  // Verify server reachable
  try {
    await client.health();
  } catch {
    console.error(`Cannot reach server at ${config.server}`);
    process.exit(1);
  }

  const log = (msg: string) => {
    const ts = new Date().toISOString().slice(11, 19);
    console.log(`[${ts}] ${msg}`);
  };

  log("Seedvault daemon starting...");
  log(`  Server:  ${config.server}`);
  log(`  Contributor: ${config.contributorId}`);
  log(`  Collections: ${config.collections.map((f) => f.name).join(", ")}`);

  // Write PID file (useful for sv status / sv stop even in foreground)
  writeFileSync(getPidPath(), String(process.pid));

  const syncer = new Syncer({
    client,
    contributorId: config.contributorId,
    collections: config.collections,
    onLog: log,
  });

  // Initial sync
  log("Running initial sync...");
  try {
    const { uploaded, skipped, deleted } = await syncer.initialSync();
    log(`Initial sync complete: ${uploaded} uploaded, ${skipped} skipped, ${deleted} deleted`);
  } catch (e: unknown) {
    log(`Initial sync failed: ${(e as Error).message}`);
    log("Will continue watching for changes...");
  }

  // Start watching
  const watcher = createWatcher(config.collections, (event) => {
    syncer.handleEvent(event).catch((e) => {
      log(`Error handling ${event.type} for ${event.serverPath}: ${(e as Error).message}`);
    });
  });

  log("Watching for changes. Press Ctrl+C to stop.");

  // Handle graceful shutdown
  const shutdown = () => {
    log("Shutting down...");
    watcher.close();
    syncer.stop();

    // Clean up PID file
    try {
      const { unlinkSync } = require("fs");
      unlinkSync(getPidPath());
    } catch {}

    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

/** Spawn a detached background daemon */
async function startBackground(): Promise<void> {
  const config = loadConfig();

  if (config.collections.length === 0) {
    console.error("No collections configured. Run 'sv add <path>' first.");
    process.exit(1);
  }

  // Spawn a detached child running "sv start" (foreground, no -d)
  // We find our entry point by going up from commands/ to index.ts
  const entryPoint = import.meta.dir + "/../index.ts";
  const logPath = getConfigDir() + "/daemon.log";

  const child = Bun.spawn({
    cmd: ["bun", "run", entryPoint, "start"],
    stdin: "ignore",
    stdout: Bun.file(logPath),
    stderr: Bun.file(logPath),
    env: { ...process.env },
  });

  const pid = child.pid;
  writeFileSync(getPidPath(), String(pid));

  console.log(`Daemon started in background (PID ${pid}).`);
  console.log(`  Log:  ${logPath}`);
  console.log(`  Run 'sv status' to check, 'sv stop' to stop.`);

  // Detach: don't wait for child
  child.unref();
}
