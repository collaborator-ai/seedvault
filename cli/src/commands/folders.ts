import { loadConfig } from "../config.js";

/**
 * sv folders
 *
 * List all configured watched folders.
 */
export async function folders(): Promise<void> {
  const config = loadConfig();

  if (config.folders.length === 0) {
    console.log("No folders configured.");
    console.log("  Run 'sv add <folder>' to add one.");
    return;
  }

  console.log("Configured folders:\n");
  for (const f of config.folders) {
    console.log(`  ${f.label}`);
    console.log(`    Path:   ${f.path}`);
    console.log(`    Syncs:  ${f.label}/<relative-path>`);
    console.log();
  }
}
