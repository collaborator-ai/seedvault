import { join } from "path";
import { homedir } from "os";
import { mkdir } from "fs/promises";
import { initDb } from "./db.js";
import { createApp } from "./routes.js";

const PORT = parseInt(process.env.PORT || "3000", 10);
const DATA_DIR = process.env.DATA_DIR || join(homedir(), ".seedvault", "data");

const dbPath = join(DATA_DIR, "seedvault.db");

// Ensure data directory exists
await mkdir(DATA_DIR, { recursive: true });

// Initialize database
initDb(dbPath);

// Create and start the server
const app = createApp();

console.log(`Seedvault server starting on port ${PORT}`);
console.log(`  Data dir: ${DATA_DIR}`);
console.log(`  Database: ${dbPath}`);

const server = Bun.serve({
  port: PORT,
  fetch: app.fetch,
});

console.log(`Listening on http://localhost:${server.port}`);
