import { readFileSync } from "fs";
import { resolve } from "path";
import { $ } from "bun";
import { restartService, getServiceStatus } from "../daemon/service.js";

const INSTALL_SCRIPT_URL =
  "https://raw.githubusercontent.com/collaborator-ai/seedvault/main/install-cli.sh";

/**
 * sv update
 *
 * Update the CLI to the latest version by re-running the install script,
 * then restart the daemon if it was running.
 */
export async function upgrade(): Promise<void> {
  // Get current version
  const pkgPath = resolve(import.meta.dirname, "..", "..", "package.json");
  let currentVersion = "unknown";
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
    currentVersion = pkg.version;
  } catch {
    // Ignore — might be running from a different location
  }

  // Check if daemon is installed before upgrade
  const preStatus = await getServiceStatus();

  console.log(`Current version: ${currentVersion}`);
  console.log(`Fetching latest from: ${INSTALL_SCRIPT_URL}\n`);

  // Run the install script with --no-onboard (skip interactive setup)
  const result = await $`curl -fsSL ${INSTALL_SCRIPT_URL} | bash -s -- --no-onboard`
    .quiet()
    .nothrow();

  if (result.exitCode !== 0) {
    console.error("Upgrade failed:");
    console.error(result.stderr.toString());
    process.exit(1);
  }

  console.log(result.stdout.toString());

  // Restart daemon if it was installed
  if (preStatus.installed) {
    console.log("Restarting daemon...");
    await restartService();
  }

  console.log("Upgrade complete. Run 'sv --version' to verify.");
}
