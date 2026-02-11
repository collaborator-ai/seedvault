#!/usr/bin/env bun
import { join, dirname } from "path";
import { fileURLToPath } from "url";
const __dirname = dirname(fileURLToPath(import.meta.url));
await import(join(__dirname, "..", "dist", "sv.js"));
