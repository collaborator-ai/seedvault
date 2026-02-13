import { createInterface } from "readline";
import { loadConfig } from "../config.js";
import { createClient, ApiError } from "../client.js";

function confirm(prompt: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() === "y");
    });
  });
}

/**
 * sv kick <username>
 *
 * Remove a contributor and all their files (admin only).
 */
export async function kick(args: string[]): Promise<void> {
  const username = args[0];
  if (!username) {
    console.error("Usage: sv kick <username>");
    process.exit(1);
  }

  const config = loadConfig();
  const client = createClient(config.server, config.token);

  const { files } = await client.listFiles(username);

  const ok = await confirm(
    `Delete contributor "${username}" and ${files.length} file(s)? [y/N] `
  );
  if (!ok) {
    console.log("Cancelled.");
    return;
  }

  try {
    await client.deleteContributor(username);
    console.log(`Deleted contributor "${username}" and all their files.`);
  } catch (e) {
    if (e instanceof ApiError && e.status === 403) {
      console.error("Only the admin can delete contributors.");
      process.exit(1);
    }
    if (e instanceof ApiError && e.status === 400) {
      console.error(e.message);
      process.exit(1);
    }
    throw e;
  }
}
