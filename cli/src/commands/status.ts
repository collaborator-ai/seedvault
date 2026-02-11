import { loadConfig, configExists } from "../config.js";
import { createClient } from "../client.js";
import { getServiceStatus, detectPlatform } from "../daemon/service.js";

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
  console.log(`  Contributor: ${config.contributorId}`);

  // Daemon
  try {
    const platform = detectPlatform();
    const serviceName = platform === "macos" ? "launchd" : platform === "linux" ? "systemd" : "Task Scheduler";
    const svc = await getServiceStatus();

    if (!svc.installed) {
      console.log(`  Daemon:  not registered (run 'sv start' to register)`);
    } else if (svc.running) {
      console.log(`  Daemon:  running via ${serviceName}${svc.pid ? ` (PID ${svc.pid})` : ""}`);
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
