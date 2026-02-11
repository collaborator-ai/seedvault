import { loadConfig } from "../config.js";
import { createClient } from "../client.js";

/**
 * sv grep [args...]
 *
 * Search files via shell passthrough. Pass args directly to `grep`.
 */
export async function grep(args: string[]): Promise<void> {
  if (args.length === 0) {
    console.error("Usage: sv grep [options] <pattern> [path...]");
    process.exit(1);
  }

  const config = loadConfig();
  const client = createClient(config.server, config.token);
  const output = await client.sh(`grep ${args.join(" ")}`);
  process.stdout.write(output);
}
