import { uninstallService } from "../daemon/service.js";

/**
 * sv stop
 *
 * Stop the daemon and unregister the OS service.
 */
export async function stop(): Promise<void> {
  await uninstallService();
}
