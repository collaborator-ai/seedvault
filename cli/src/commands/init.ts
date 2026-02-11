import * as readline from "readline/promises";
import { stdin, stdout } from "process";
import { configExists, saveConfig, type Config } from "../config.js";
import { createClient } from "../client.js";

/**
 * sv init
 *   Interactive:  prompts for server URL, name, optional invite code
 *   Non-interactive:
 *     sv init --server URL --token TOKEN            (already have a token)
 *     sv init --server URL --name NAME [--invite C] (signup via API)
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
    // Verify the token works by hitting the server
    const client = createClient(flags.server, flags.token);
    try {
      await client.health();
    } catch {
      console.error(`Could not reach server at ${flags.server}`);
      process.exit(1);
    }

    // Get bank info from server
    const { banks } = await client.listBanks();
    // We don't know which bank this token belongs to without trying.
    // For now, save without bankId — the first PUT will tell us.
    // Actually, let's require --bank-id or try to infer it.
    const bankId = flags["bank-id"] || "";
    if (!bankId) {
      console.error("When using --token, also pass --bank-id");
      process.exit(1);
    }

    const config: Config = {
      server: flags.server,
      token: flags.token,
      bankId,
      folders: [],
    };
    saveConfig(config);
    console.log("Seedvault configured.");
    console.log(`  Server:  ${config.server}`);
    console.log(`  Bank ID: ${config.bankId}`);
    return;
  }

  // Non-interactive: --server + --name (signup)
  if (flags.server && flags.name) {
    const client = createClient(flags.server);
    try {
      await client.health();
    } catch {
      console.error(`Could not reach server at ${flags.server}`);
      process.exit(1);
    }

    const result = await client.signup(flags.name, flags.invite);
    const config: Config = {
      server: flags.server,
      token: result.token,
      bankId: result.bank.id,
      folders: [],
    };
    saveConfig(config);
    console.log("Signed up and configured.");
    console.log(`  Server:  ${config.server}`);
    console.log(`  Bank:    ${result.bank.name} (${result.bank.id})`);
    console.log(`  Token:   ${result.token}`);
    return;
  }

  // Interactive mode
  const rl = readline.createInterface({ input: stdin, output: stdout });

  try {
    console.log("Seedvault Setup\n");

    const server = await rl.question("Server URL: ");
    if (!server) {
      console.error("Server URL is required.");
      process.exit(1);
    }

    // Verify server is reachable
    const client = createClient(server);
    try {
      await client.health();
      console.log("  Server is reachable.\n");
    } catch {
      console.error(`  Could not reach server at ${server}`);
      process.exit(1);
    }

    const hasToken = await rl.question("Do you already have a token? (y/N): ");

    if (hasToken.toLowerCase() === "y") {
      const token = await rl.question("Token: ");
      const bankId = await rl.question("Bank ID: ");
      const config: Config = { server, token: token.trim(), bankId: bankId.trim(), folders: [] };
      saveConfig(config);
      console.log("\nSeedvault configured.");
    } else {
      const name = await rl.question("Bank name (e.g. your-name-notes): ");
      const invite = await rl.question("Invite code (leave blank if first user): ");

      const result = await client.signup(name.trim(), invite.trim() || undefined);
      const config: Config = {
        server,
        token: result.token,
        bankId: result.bank.id,
        folders: [],
      };
      saveConfig(config);
      console.log(`\nSigned up as '${result.bank.name}'.`);
      console.log(`  Bank ID: ${result.bank.id}`);
      console.log(`  Token:   ${result.token}`);
      console.log("\nSave your token — it won't be shown again.");
    }

    console.log("\nNext steps:");
    console.log("  sv add ~/notes         # Add a folder to sync");
    console.log("  sv start               # Start the daemon");
  } finally {
    rl.close();
  }
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
