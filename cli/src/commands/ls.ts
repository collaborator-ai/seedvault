import { loadConfig } from "../config.js";
import { createClient } from "../client.js";

/**
 * sv ls [args...]
 *
 * List files via shell passthrough. Pass args directly to `ls`.
 */
export async function ls(args: string[]): Promise<void> {
  const config = loadConfig();
  const client = createClient(config.server, config.token);
  const output = await client.sh(`ls ${args.join(" ")}`);
  process.stdout.write(output);
}
