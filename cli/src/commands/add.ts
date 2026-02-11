import { existsSync } from "fs";
import { resolve } from "path";
import { homedir } from "os";
import { loadConfig, saveConfig, addCollection, defaultCollectionName } from "../config.js";

/**
 * sv add <path> [--name <name>]
 *
 * Add a collection path to sync. Name defaults to the path basename.
 */
export async function add(args: string[]): Promise<void> {
  if (args.length === 0 || args[0].startsWith("--")) {
    console.error("Usage: sv add <path> [--name <name>]");
    process.exit(1);
  }

  const rawPath = args[0];
  const nameIdx = args.indexOf("--name");
  const name = nameIdx !== -1 && args[nameIdx + 1]
    ? args[nameIdx + 1]
    : defaultCollectionName(rawPath);

  // Resolve path
  const absPath = rawPath.startsWith("~")
    ? resolve(homedir(), rawPath.slice(2)) // skip ~/
    : resolve(rawPath);

  if (!existsSync(absPath)) {
    console.error(`Directory not found: ${absPath}`);
    process.exit(1);
  }

  const config = loadConfig();

  try {
    const result = addCollection(config, absPath, name);
    const updated = result.config;
    saveConfig(updated);
    console.log(`Added collection: ${absPath}`);
    console.log(`  Name: ${name}`);
    console.log(`  Files will sync to: ${name}/<relative-path>`);
    if (result.removedChildCollections.length > 0) {
      console.log("  Removed overlapping child collections:");
      for (const child of result.removedChildCollections) {
        console.log(`    - ${child.name} (${child.path})`);
      }
    }
  } catch (e: unknown) {
    console.error((e as Error).message);
    process.exit(1);
  }
}
