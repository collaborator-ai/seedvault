import { loadConfig, saveConfig, removeCollection } from "../config.js";

/**
 * sv remove <name>
 *
 * Stop syncing a collection by name.
 */
export async function remove(args: string[]): Promise<void> {
  if (args.length === 0) {
    console.error("Usage: sv remove <name>");
    process.exit(1);
  }

  const name = args[0];
  const config = loadConfig();

  try {
    const updated = removeCollection(config, name);
    saveConfig(updated);
    console.log(`Removed collection '${name}'.`);
  } catch (e: unknown) {
    console.error((e as Error).message);
    process.exit(1);
  }
}
