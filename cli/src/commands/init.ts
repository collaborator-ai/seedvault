import * as readline from "readline/promises";
import { stdout } from "process";
import * as fs from "fs";
import { configExists, saveConfig, type Config } from "../config.js";
import { createClient } from "../client.js";

/**
 * sv init
 *   Interactive:  prompts for server URL, name, optional invite code
 *   Non-interactive:
 *     sv init --server URL --token TOKEN              (already have a token)
 *     sv init --server URL --name NAME [--invite C]   (signup via API)
 */
export async function init(args: string[]): Promise<void> {
  // Parse flags
  const flags = parseFlags(args);

  if (configExists() && !flags.force) {
    console.log("Seedvault is already configured.");
    console.log("  Run 'sv init --force' to overwrite.");
    return;
  }

  // Non-interactive: --server + --token
  if (flags.server && flags.token) {
    const client = createClient(flags.server, flags.token);
    let username: string;
    try {
      const me = await client.me();
      username = me.username;
    } catch {
      console.error(`Could not authenticate with server at ${flags.server}`);
      process.exit(1);
    }

    const config: Config = {
      server: flags.server,
      token: flags.token,
      username,
      collections: [],
    };
    saveConfig(config);
    console.log("Seedvault configured.");
    console.log(`  Server:  ${config.server}`);
    console.log(`  Username: ${config.username}`);
    return;
  }

  // Non-interactive: --server + --name (signup)
  if (flags.server && flags.name) {
    const client = createClient(flags.server);
    const reachable = await client.health();
    if (!reachable) {
      console.error(`Could not reach server at ${flags.server}`);
      process.exit(1);
    }

    const result = await client.signup(flags.name, flags.invite);
    const config: Config = {
      server: flags.server,
      token: result.token,
      username: result.contributor.username,
      collections: [],
    };
    saveConfig(config);
    console.log("Signed up and configured.");
    console.log(`  Server:  ${config.server}`);
    console.log(`  Username: ${result.contributor.username}`);
    console.log(`  Token:   ${result.token}`);
    return;
  }

  // Interactive mode — open /dev/tty directly so this works even when
  // stdin is a pipe (e.g. curl | bash). Falls back to process.stdin on Windows.
  let input: NodeJS.ReadableStream;
  try {
    const fd = fs.openSync("/dev/tty", "r");
    input = fs.createReadStream("", { fd });
  } catch {
    input = process.stdin;
  }
  const rl = readline.createInterface({ input, output: stdout });

  try {
    console.log("Seedvault Setup\n");

    const server = await rl.question("Server URL: ");
    if (!server) {
      console.error("Server URL is required.");
      process.exit(1);
    }

    // Verify server is reachable
    const client = createClient(server);
    const isReachable = await client.health();
    if (!isReachable) {
      console.error(`  Could not reach server at ${server}`);
      process.exit(1);
    }
    console.log("  Server is reachable.\n");

    const hasToken = await rl.question("Do you already have a token? (y/N): ");

    if (hasToken.toLowerCase() === "y") {
      const token = (await rl.question("Token: ")).trim();
      const authedClient = createClient(server, token);
      let username: string;
      try {
        const me = await authedClient.me();
        username = me.username;
      } catch {
        console.error("  Token is invalid or server rejected it.");
        process.exit(1);
      }
      const config: Config = { server, token, username, collections: [] };
      saveConfig(config);
      console.log(`\nSeedvault configured as '${username}'`);
    } else {
      const name = await rl.question("Username (e.g. your-name-notes): ");
      const invite = await rl.question("Invite code (leave blank if first user): ");

      const result = await client.signup(name.trim(), invite.trim() || undefined);
      const config: Config = {
        server,
        token: result.token,
        username: result.contributor.username,
        collections: [],
      };
      saveConfig(config);
      console.log(`\nSigned up as '${result.contributor.username}'.`);
      console.log(`  Token:   ${result.token}`);
      console.log("\nSave your token — it won't be shown again.");
    }

    console.log("\nNext steps:");
    console.log("  sv add ~/notes         # Add a collection to sync");
    console.log("  sv start               # Start the daemon");
  } finally {
    rl.close();
  }

  process.exit(0);
}

function parseFlags(args: string[]): Record<string, string> {
  const flags: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = args[i + 1];
      if (next && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = "true";
      }
    }
  }
  return flags;
}
