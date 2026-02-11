import { loadConfig } from "../config.js";
import { createClient, ApiError } from "../client.js";

/**
 * sv cat <path>
 *
 * Read a file from the server and print its content.
 */
export async function cat(args: string[]): Promise<void> {
  if (args.length === 0) {
    console.error("Usage: sv cat <path>");
    process.exit(1);
  }

  const filePath = args[0];
  const config = loadConfig();
  const client = createClient(config.server, config.token);

  try {
    const content = await client.getFile(config.username, filePath);
    process.stdout.write(content);
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) {
      console.error(`File not found: ${filePath}`);
      process.exit(1);
    }
    throw e;
  }
}
