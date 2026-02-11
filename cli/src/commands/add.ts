import { existsSync } from "fs";
import { resolve } from "path";
import { homedir } from "os";
import { loadConfig, saveConfig, addFolder, defaultLabel } from "../config.js";

/**
 * sv add <folder> [--label <label>]
 *
 * Watch a folder. Label defaults to the folder's basename.
 */
export async function add(args: string[]): Promise<void> {
  if (args.length === 0 || args[0].startsWith("--")) {
    console.error("Usage: sv add <folder> [--label <label>]");
    process.exit(1);
  }

  const rawPath = args[0];
  const labelIdx = args.indexOf("--label");
  const label = labelIdx !== -1 && args[labelIdx + 1]
    ? args[labelIdx + 1]
    : defaultLabel(rawPath);

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
    const updated = addFolder(config, absPath, label);
    saveConfig(updated);
    console.log(`Added folder: ${absPath}`);
    console.log(`  Label: ${label}`);
    console.log(`  Files will sync to: ${label}/<relative-path>`);
  } catch (e: unknown) {
    console.error((e as Error).message);
    process.exit(1);
  }
}
