import { loadConfig } from "../config.js";
import { createClient } from "../client.js";

/**
 * sv cat [args...]
 *
 * Read files via shell passthrough. Pass args directly to `cat`.
 */
export async function cat(args: string[]): Promise<void> {
  if (args.length === 0) {
    console.error("Usage: sv cat <path>");
    process.exit(1);
  }

  const config = loadConfig();
  const client = createClient(config.server, config.token);
  const output = await client.sh(`cat ${args.join(" ")}`);
  process.stdout.write(output);
}
