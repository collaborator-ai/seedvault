import { loadConfig } from "../config.js";

/**
 * sv collections
 *
 * List all configured watched collections.
 */
export async function collections(): Promise<void> {
  const config = loadConfig();

  if (config.collections.length === 0) {
    console.log("No collections configured.");
    console.log("  Run 'sv add <path>' to add one.");
    return;
  }

  console.log("Configured collections:\n");
  for (const f of config.collections) {
    console.log(`  ${f.name}`);
    console.log(`    Path:   ${f.path}`);
    console.log(`    Syncs:  ${f.name}/<relative-path>`);
    console.log();
  }
}
