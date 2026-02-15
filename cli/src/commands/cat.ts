import { loadConfig } from "../config.js";
import { createClient } from "../client.js";

/**
 * sv cat <username/path>
 *
 * Read a file from the vault via GET /v1/files/:username/*path.
 */
export async function cat(args: string[]): Promise<void> {
  if (args.length === 0) {
    console.error("Usage: sv cat <username/path>");
    process.exit(1);
  }

  const input = args[0];
  const slashIdx = input.indexOf("/");
  if (slashIdx === -1) {
    console.error("Path must include username: sv cat <username/path>");
    process.exit(1);
  }

  const username = input.slice(0, slashIdx);
  const filePath = input.slice(slashIdx + 1);

  const config = loadConfig();
  const client = createClient(config.server, config.token);
  const file = await client.readFile(`${username}/${filePath}`);
  process.stdout.write(file.content);
}
