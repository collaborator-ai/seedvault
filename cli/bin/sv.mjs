#!/usr/bin/env node
import { execFileSync } from "child_process";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
const __dirname = dirname(fileURLToPath(import.meta.url));
try {
  execFileSync("bun", [join(__dirname, "..", "dist", "sv.js"), ...process.argv.slice(2)], { stdio: "inherit" });
} catch (e) {
  process.exit(e.status || 1);
}
