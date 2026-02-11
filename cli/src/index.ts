#!/usr/bin/env bun

import { init } from "./commands/init.js";
import { add } from "./commands/add.js";
import { remove } from "./commands/remove.js";
import { folders } from "./commands/folders.js";
import { start } from "./commands/start.js";
import { stop } from "./commands/stop.js";
import { status } from "./commands/status.js";
import { ls } from "./commands/ls.js";
import { cat } from "./commands/cat.js";
import { banks } from "./commands/banks.js";
import { invite } from "./commands/invite.js";

const USAGE = `
Seedvault CLI

Usage: sv <command> [options]

Setup:
  init                          Interactive first-time setup
  init --server URL --token T   Non-interactive (existing token)
  init --server URL --name N    Non-interactive (signup)

Folders:
  add <folder> [--label L]      Watch a folder
  remove <label>                Stop watching a folder
  folders                       List configured folders

Daemon:
  start                         Start syncing (foreground)
  start -d                      Start syncing (background)
  stop                          Stop the daemon
  status                        Show sync status

Files:
  ls [prefix]                   List files in your bank
  cat <path>                    Read a file from the server

Vault:
  banks                         List all banks
  invite                        Generate an invite code (operator only)
`.trim();

async function main(): Promise<void> {
  const [cmd, ...args] = process.argv.slice(2);

  if (!cmd || cmd === "--help" || cmd === "-h") {
    console.log(USAGE);
    return;
  }

  try {
    switch (cmd) {
      case "init":
        return await init(args);
      case "add":
        return await add(args);
      case "remove":
        return await remove(args);
      case "folders":
        return await folders();
      case "start":
        return await start(args);
      case "stop":
        return await stop();
      case "status":
        return await status();
      case "ls":
        return await ls(args);
      case "cat":
        return await cat(args);
      case "banks":
        return await banks();
      case "invite":
        return await invite();
      default:
        console.error(`Unknown command: ${cmd}\n`);
        console.log(USAGE);
        process.exit(1);
    }
  } catch (e: unknown) {
    console.error(`Error: ${(e as Error).message}`);
    process.exit(1);
  }
}

main();
