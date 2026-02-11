import { loadConfig, saveConfig, removeFolder } from "../config.js";

/**
 * sv remove <label>
 *
 * Stop watching a folder by its label.
 */
export async function remove(args: string[]): Promise<void> {
  if (args.length === 0) {
    console.error("Usage: sv remove <label>");
    process.exit(1);
  }

  const label = args[0];
  const config = loadConfig();

  try {
    const updated = removeFolder(config, label);
    saveConfig(updated);
    console.log(`Removed folder '${label}'.`);
  } catch (e: unknown) {
    console.error((e as Error).message);
    process.exit(1);
  }
}
