import { loadConfig } from "../config.js";
import { createClient } from "../client.js";

/**
 * sv sh <command>
 *
 * Execute a shell command on the vault via POST /v1/sh.
 * The command runs in the vault's files directory.
 * Only whitelisted read commands are allowed (ls, cat, head, tail, find, grep, wc, tree, stat).
 */
export async function sh(args: string[]): Promise<void> {
  if (args.length === 0) {
    console.error("Usage: sv sh <command>");
    console.error('Example: sv sh "ls -la yiliu/"');
    console.error('Example: sv sh "grep -r pattern ."');
    process.exit(1);
  }

  const cmd = args.join(" ");
  const config = loadConfig();
  const client = createClient(config.server, config.token);
  const output = await client.sh(cmd);
  process.stdout.write(output);
}
