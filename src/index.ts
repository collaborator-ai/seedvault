import { join } from "path";
import { mkdir } from "fs/promises";
import { initDb, listBanks } from "./db.js";
import { createApp } from "./routes.js";
import { isQmdAvailable, syncCollections } from "./qmd.js";

const PORT = parseInt(process.env.PORT || "3000", 10);
const DATA_DIR = process.env.DATA_DIR || "./data";

const dbPath = join(DATA_DIR, "seedvault.db");
const storageRoot = join(DATA_DIR, "files");

// Ensure directories exist
await mkdir(DATA_DIR, { recursive: true });
await mkdir(storageRoot, { recursive: true });

// Initialize database
initDb(dbPath);

// Check for QMD and sync collections
const qmdAvailable = await isQmdAvailable();
if (qmdAvailable) {
  console.log("  QMD:      available");
  const banks = listBanks();
  if (banks.length > 0) {
    await syncCollections(storageRoot, banks);
    console.log(`  QMD:      synced ${banks.length} collection(s)`);
  }
} else {
  console.log("  QMD:      not found (search disabled)");
}

// Create and start the server
const app = createApp(storageRoot);

console.log(`Seedvault server starting on port ${PORT}`);
console.log(`  Data dir: ${DATA_DIR}`);
console.log(`  Database: ${dbPath}`);
console.log(`  Storage:  ${storageRoot}`);

export default {
  port: PORT,
  fetch: app.fetch,
};
