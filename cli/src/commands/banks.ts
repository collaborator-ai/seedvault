import { loadConfig } from "../config.js";
import { createClient } from "../client.js";

/**
 * sv banks
 *
 * List all banks in the vault.
 */
export async function banks(): Promise<void> {
  const config = loadConfig();
  const client = createClient(config.server, config.token);

  const { banks } = await client.listBanks();

  if (banks.length === 0) {
    console.log("No banks in the vault.");
    return;
  }

  console.log("Banks:\n");
  for (const b of banks) {
    const you = b.id === config.bankId ? " (you)" : "";
    console.log(`  ${b.name}${you}`);
    console.log(`    ID:      ${b.id}`);
    console.log(`    Created: ${new Date(b.createdAt).toLocaleString()}`);
    console.log();
  }
}
