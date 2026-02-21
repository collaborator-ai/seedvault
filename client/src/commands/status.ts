import { loadConfig, configExists } from "../config.js";
import { createClient } from "../client.js";
import { getServiceStatus, detectPlatform } from "../daemon/service.js";
import { getDaemonHealth } from "../api/health.js";

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
  console.log(`  Contributor: ${config.username}`);

  // Daemon
  try {
    const platform = detectPlatform();
    const serviceName = platform === "macos" ? "launchd" : platform === "linux" ? "systemd" : "Task Scheduler";
    const svc = await getServiceStatus();

    if (!svc.installed) {
      console.log(`  Daemon:  not registered (run 'sv start' to register)`);
    } else if (svc.running) {
      console.log(`  Daemon:  running via ${serviceName}${svc.pid ? ` (PID ${svc.pid})` : ""}`);

      const health = getDaemonHealth();
      if (health) {
        const ageMs = Date.now() - new Date(health.updatedAt).getTime();
        const stale = ageMs > 15_000;
        console.log(`  Health:  ${stale ? "STALE" : "ok"} (updated ${Math.round(ageMs / 1000)}s ago)`);
        console.log(`  Watcher: ${health.watcherAlive ? "alive" : "dead"}`);
        if (health.pendingOps > 0) {
          console.log(`  Pending: ${health.pendingOps} ops`);
        }
        if (health.lastSyncAt) {
          const syncAge = Date.now() - new Date(health.lastSyncAt).getTime();
          console.log(`  Last sync: ${formatAge(syncAge)} ago`);
        }
        if (health.lastReconcileAt) {
          const reconcileAge = Date.now() - new Date(health.lastReconcileAt).getTime();
          console.log(`  Last reconcile: ${formatAge(reconcileAge)} ago`);
        }
      }
    } else {
      console.log(`  Daemon:  registered via ${serviceName} but not running`);
    }
  } catch {
    console.log("  Daemon:  unsupported platform");
  }

  // Collections
  if (config.collections.length === 0) {
    console.log("  Collections: none configured");
  } else {
    console.log(`  Collections: ${config.collections.length}`);
    for (const f of config.collections) {
      console.log(`    - ${f.name} -> ${f.path}`);
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

function formatAge(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}
