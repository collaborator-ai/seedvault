import { writeFileSync, unlinkSync, watch, type FSWatcher } from "fs";
import { loadConfig, getPidPath, getConfigPath } from "../config.js";
import { installService } from "../daemon/service.js";
import { startSync } from "../api/sync.js";

/**
 * sv start [-f]
 *
 *   Default: registers an OS service (launchd/systemd) that runs the daemon.
 *   -f / --foreground: runs the daemon directly in the current terminal.
 */
export async function start(args: string[]): Promise<void> {
  const foreground = args.includes("-f") || args.includes("--foreground");

  if (foreground) {
    return startForeground();
  }

  return installService();
}

/** Run daemon in the foreground */
async function startForeground(): Promise<void> {
  const config = loadConfig();

  const log = (msg: string) => {
    const ts = new Date().toISOString().slice(11, 19);
    console.log(`[${ts}] ${msg}`);
  };

  log("Seedvault daemon starting...");
  log(`  Server:  ${config.server}`);
  log(`  Contributor: ${config.username}`);
  if (config.collections.length === 0) {
    log("  Collections: none");
    log("  Waiting for collections to be added...");
  } else {
    log(
      `  Collections: ` +
      `${config.collections.map((f) => f.name).join(", ")}`,
    );
  }

  // Write PID file (useful for sv status / sv stop even in foreground)
  writeFileSync(getPidPath(), String(process.pid));

  const handle = await startSync({
    config,
    onLog: log,
  }).catch((e: unknown) => {
    log(`Failed to start: ${(e as Error).message}`);
    try {
      unlinkSync(getPidPath());
    } catch {}
    process.exit(1);
  });

  // Watch config.json for changes instead of polling
  let configDebounce: ReturnType<typeof setTimeout> | null = null;
  const configWatcher: FSWatcher = watch(
    getConfigPath(),
    () => {
      if (configDebounce) clearTimeout(configDebounce);
      configDebounce = setTimeout(() => {
        try {
          handle.reloadConfig(loadConfig()).catch((e: unknown) => {
            log(`Config reload failed: ${(e as Error).message}`);
          });
        } catch (e: unknown) {
          log(`Failed to read config: ${(e as Error).message}`);
        }
      }, 300);
    },
  );

  log("Daemon running. Press Ctrl+C to stop.");

  const shutdown = () => {
    log("Shutting down...");
    configWatcher.close();
    if (configDebounce) clearTimeout(configDebounce);
    void handle.stop()
      .catch((e: unknown) => {
        log(`Shutdown error: ${(e as Error).message}`);
      })
      .finally(() => {
        try {
          unlinkSync(getPidPath());
        } catch {}
        process.exit(0);
      });
  };

  process.on("uncaughtException", (error) => {
    log(`Uncaught exception: ${error.message}`);
    shutdown();
  });
  process.on("unhandledRejection", (reason) => {
    const msg =
      reason instanceof Error ? reason.message : String(reason);
    log(`Unhandled rejection: ${msg}`);
  });
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
