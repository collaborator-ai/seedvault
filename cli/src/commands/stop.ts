import { readFileSync, unlinkSync, existsSync } from "fs";
import { getPidPath } from "../config.js";

/**
 * sv stop
 *
 * Stop the running daemon by sending SIGTERM to the PID.
 */
export async function stop(): Promise<void> {
  const pidPath = getPidPath();

  if (!existsSync(pidPath)) {
    console.log("No daemon is running (no PID file found).");
    return;
  }

  const pid = parseInt(readFileSync(pidPath, "utf-8").trim(), 10);

  if (isNaN(pid)) {
    console.error("Invalid PID file. Removing it.");
    unlinkSync(pidPath);
    return;
  }

  // Check if process is alive
  try {
    process.kill(pid, 0); // signal 0 = check existence
  } catch {
    console.log(`Daemon (PID ${pid}) is not running. Cleaning up PID file.`);
    unlinkSync(pidPath);
    return;
  }

  // Send SIGTERM
  try {
    process.kill(pid, "SIGTERM");
    console.log(`Sent SIGTERM to daemon (PID ${pid}).`);

    // Wait briefly and verify it stopped
    await Bun.sleep(500);
    try {
      process.kill(pid, 0);
      console.log("Daemon still running. Send SIGKILL with: kill -9 " + pid);
    } catch {
      console.log("Daemon stopped.");
      try { unlinkSync(pidPath); } catch {}
    }
  } catch (e: unknown) {
    console.error(`Failed to stop daemon: ${(e as Error).message}`);
  }
}
