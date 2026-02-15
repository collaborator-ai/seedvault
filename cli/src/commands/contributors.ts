import { loadConfig } from "../config.js";
import { createClient } from "../client.js";

/**
 * sv contributors
 *
 * List all contributors in the vault.
 */
export async function contributors(): Promise<void> {
  const config = loadConfig();
  const client = createClient(config.server, config.token);

  const allContributors = await client.listContributors();

  if (allContributors.length === 0) {
    console.log("No contributors in the vault.");
    return;
  }

  console.log("Contributors:\n");
  for (const contributor of allContributors) {
    const you = contributor.username === config.username ? " (you)" : "";
    console.log(`  ${contributor.username}${you}`);
    console.log(`    Created: ${new Date(contributor.createdAt).toLocaleString()}`);
    console.log();
  }
}
