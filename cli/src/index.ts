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
import { sh } from "./commands/sh.js";
import { contributors } from "./commands/contributors.js";
import { invite } from "./commands/invite.js";
import { upgrade } from "./commands/update.js";

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
  sh <command>                  Run a shell command on the vault (ls, cat, grep, etc.)
  ls [args...]                  Shorthand for: sv sh "ls [args...]"
  cat <path>                    Shorthand for: sv sh "cat <path>"

Vault:
  contributors                  List all contributors
  invite                        Generate an invite code (operator only)

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

  try {
    switch (cmd) {
      case "init":
        return await init(args);
      case "add":
        return await add(args);
      case "remove":
        return await remove(args);
      case "collections":
        return await collections();
      case "start":
        return await start(args);
      case "stop":
        return await stop();
      case "status":
        return await status();
      case "sh":
        return await sh(args);
      case "ls":
        return await ls(args);
      case "cat":
        return await cat(args);
      // case "grep":
      //   return await grep(args);
      case "contributors":
        return await contributors();
      case "invite":
        return await invite();
      case "update":
        return await upgrade();
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
