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

  const { contributors } = await client.listContributors();

  if (contributors.length === 0) {
    console.log("No contributors in the vault.");
    return;
  }

  console.log("Contributors:\n");
  for (const contributor of contributors) {
    const you = contributor.id === config.contributorId ? " (you)" : "";
    console.log(`  ${contributor.name}${you}`);
    console.log(`    ID:      ${contributor.id}`);
    console.log(`    Created: ${new Date(contributor.createdAt).toLocaleString()}`);
    console.log();
  }
}
