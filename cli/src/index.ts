#!/usr/bin/env bun

import { readFileSync } from "fs";
import { resolve } from "path";
import { init } from "./commands/init.js";
import { add } from "./commands/add.js";
import { remove } from "./commands/remove.js";
import { collections } from "./commands/collections.js";
import { start } from "./commands/start.js";
import { stop } from "./commands/stop.js";
import { status } from "./commands/status.js";
import { ls } from "./commands/ls.js";
import { cat } from "./commands/cat.js";
import { grep } from "./commands/grep.js";
import { contributors } from "./commands/contributors.js";
import { invite } from "./commands/invite.js";
import { kick } from "./commands/kick.js";
import { activity } from "./commands/activity.js";
import { upgrade } from "./commands/update.js";
import { checkForUpdates } from "./update-check.js";

const USAGE = `
Seedvault CLI

Usage: sv <command> [options]

Setup:
  init                                       Interactive first-time setup
  init --server URL --token T                Non-interactive (existing token)
  init --server URL --name N [--invite CODE] Non-interactive (signup)
  init --force                               Overwrite existing config

Collections:
  add <path> [--name N]         Add a collection path
  remove <name>                 Remove a collection by name
  collections                   List configured collections

Daemon:
  start                         Register OS service and start syncing
  start -f                      Start syncing in foreground (debug)
  stop                          Stop daemon and unregister service
  status                        Show sync status

Files:
  ls [username[/prefix]]        List contributors or files
  cat <username/path>           Read a file from the vault
  grep <query> [--contributor NAME] [--limit N]  Search vault content

Vault:
  contributors                  List all contributors
  invite                        Generate an invite code (admin only)
  kick <username>               Remove a contributor and their files (admin only)
  activity [--contributor NAME] [--action TYPE] [--limit N]  View activity log

Maintenance:
  update                        Update CLI to latest version
`.trim();

async function main(): Promise<void> {
  const [cmd, ...args] = process.argv.slice(2);

  if (!cmd || cmd === "--help" || cmd === "-h") {
    console.log(USAGE);
    return;
  }

  if (cmd === "--version" || cmd === "-v") {
    const pkgPath = resolve(import.meta.dirname, "..", "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
    console.log(pkg.version);
    return;
  }

  const skipUpdateCheck = cmd === "update";
  const updateNotice = skipUpdateCheck
    ? Promise.resolve(null)
    : checkForUpdates();

  try {
    switch (cmd) {
      case "init":
        await init(args);
        break;
      case "add":
        await add(args);
        break;
      case "remove":
        await remove(args);
        break;
      case "collections":
        await collections();
        break;
      case "start":
        await start(args);
        break;
      case "stop":
        await stop();
        break;
      case "status":
        await status();
        break;
      case "ls":
        await ls(args);
        break;
      case "cat":
        await cat(args);
        break;
      case "grep":
        await grep(args);
        break;
      case "contributors":
        await contributors();
        break;
      case "invite":
        await invite();
        break;
      case "kick":
        await kick(args);
        break;
      case "activity":
        await activity(args);
        break;
      case "update":
        await upgrade();
        break;
      default:
        console.error(`Unknown command: ${cmd}\n`);
        console.log(USAGE);
        process.exit(1);
    }

    const notice = await updateNotice;
    if (notice) {
      process.stderr.write(`\n${notice}\n`);
    }
  } catch (e: unknown) {
    console.error(`Error: ${(e as Error).message}`);
    process.exit(1);
  }
}

main();
