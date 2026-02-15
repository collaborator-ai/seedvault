export {
  getServiceStatus,
  installService,
  uninstallService,
  restartService,
} from "../daemon/service.js";

export type { ServiceStatus } from "../daemon/service.js";

import { getServiceStatus, installService, restartService } from "../daemon/service.js";
import type { ServiceStatus } from "../daemon/service.js";

/**
 * Ensure the daemon is installed as an OS service and currently running.
 *
 * - Not installed → installs (which also starts it).
 * - Installed but not running → restarts.
 * - Already running → no-op.
 */
export async function ensureDaemonRunning(): Promise<ServiceStatus> {
  let status = await getServiceStatus();

  if (!status.installed) {
    await installService();
    status = await getServiceStatus();
  }

  if (!status.running) {
    await restartService();
    await new Promise((resolve) => setTimeout(resolve, 1000));
    status = await getServiceStatus();
  }

  return status;
}
