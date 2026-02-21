import { writeFileSync, unlinkSync } from "fs";
import {
  loadConfig,
  getPidPath,
  getApiPort,
  addCollection,
  removeCollection,
  saveConfig,
} from "../config.js";
import { installService } from "../daemon/service.js";
import { startSync, type SyncHandle } from "../api/sync.js";
import { createDaemonServer } from "../daemon/api.js";

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

  let handle: SyncHandle;
  try {
    handle = await startSync({
      config,
      onLog: log,
    });
  } catch (e: unknown) {
    log(`Failed to start: ${(e as Error).message}`);
    try {
      unlinkSync(getPidPath());
    } catch {}
    process.exit(1);
  }

  const apiPort = getApiPort(config);
  let currentConfig = config;

  const apiServer = createDaemonServer({
    port: apiPort,
    getConfig: () => currentConfig,
    getStatus: () => handle.getStatus(),
    fileEvents: handle.fileEvents,
    updateCollections: (action, payload) => {
      try {
        if (action === "add") {
          if (!payload.path) return { error: "path is required" };
          const result = addCollection(
            currentConfig,
            payload.path,
            payload.name,
          );
          saveConfig(result.config);
          currentConfig = result.config;
          return {};
        }
        if (action === "remove") {
          currentConfig = removeCollection(
            currentConfig,
            payload.name,
          );
          saveConfig(currentConfig);
          return {};
        }
        return { error: `Unknown action: ${action}` };
      } catch (e: unknown) {
        return { error: (e as Error).message };
      }
    },
  });

  log(`API server listening on http://127.0.0.1:${apiPort}`);
  log("Daemon running. Press Ctrl+C to stop.");

  const shutdown = () => {
    log("Shutting down...");
    apiServer.stop();
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
