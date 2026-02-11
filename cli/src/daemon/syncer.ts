import { readdir, stat, readFile } from "fs/promises";
import { join, relative } from "path";
import type { SeedvaultClient, FileEntry } from "../client.js";
import type { FolderConfig } from "../config.js";
import type { FileEvent } from "./watcher.js";
import { RetryQueue } from "./queue.js";

export interface SyncerOptions {
  client: SeedvaultClient;
  bankId: string;
  folders: FolderConfig[];
  onLog: (msg: string) => void;
}

export class Syncer {
  private client: SeedvaultClient;
  private bankId: string;
  private folders: FolderConfig[];
  private queue: RetryQueue;
  private log: (msg: string) => void;

  constructor(opts: SyncerOptions) {
    this.client = opts.client;
    this.bankId = opts.bankId;
    this.folders = opts.folders;
    this.log = opts.onLog;
    this.queue = new RetryQueue(opts.client, opts.onLog);
  }

  /**
   * Initial sync: compare local files against what's on the server,
   * PUT anything that's newer or missing.
   */
  async initialSync(): Promise<{ uploaded: number; skipped: number }> {
    let uploaded = 0;
    let skipped = 0;

    for (const folder of this.folders) {
      this.log(`Syncing '${folder.label}' (${folder.path})...`);

      // Get server file listing for this collection's prefix
      const { files: serverFiles } = await this.client.listFiles(
        this.bankId,
        folder.label + "/"
      );

      // Build a map of server files by path -> modifiedAt
      const serverMap = new Map<string, string>();
      for (const f of serverFiles) {
        serverMap.set(f.path, f.modifiedAt);
      }

      // Walk local directory for .md files
      const localFiles = await walkMd(folder.path);

      for (const localFile of localFiles) {
        const relPath = relative(folder.path, localFile.path);
        const serverPath = `${folder.label}/${relPath}`;

        const serverMod = serverMap.get(serverPath);
        if (serverMod) {
          // File exists on server — compare mtime
          const serverDate = new Date(serverMod).getTime();
          const localDate = localFile.mtimeMs;
          if (localDate <= serverDate) {
            skipped++;
            continue;
          }
        }

        // Upload
        const content = await readFile(localFile.path, "utf-8");
        try {
          await this.client.putFile(this.bankId, serverPath, content);
          uploaded++;
        } catch {
          // If server unreachable, queue it
          this.queue.enqueue({
            type: "put",
            bankId: this.bankId,
            serverPath,
            content,
            queuedAt: new Date().toISOString(),
          });
        }
      }

      this.log(
        `  '${folder.label}': ${uploaded} uploaded, ${skipped} up-to-date`
      );
    }

    return { uploaded, skipped };
  }

  /**
   * Handle a file event from the watcher.
   */
  async handleEvent(event: FileEvent): Promise<void> {
    if (event.type === "add" || event.type === "change") {
      const content = await readFile(event.localPath, "utf-8");
      this.log(`PUT ${event.serverPath} (${content.length} bytes)`);
      this.queue.enqueue({
        type: "put",
        bankId: this.bankId,
        serverPath: event.serverPath,
        content,
        queuedAt: new Date().toISOString(),
      });
    } else if (event.type === "unlink") {
      this.log(`DELETE ${event.serverPath}`);
      this.queue.enqueue({
        type: "delete",
        bankId: this.bankId,
        serverPath: event.serverPath,
        content: null,
        queuedAt: new Date().toISOString(),
      });
    }
  }

  /** Stop the queue (persist pending ops) */
  stop(): void {
    this.queue.stop();
  }

  /** Number of pending queued operations */
  get pendingOps(): number {
    return this.queue.pending;
  }
}

// --- Helpers ---

interface LocalFile {
  path: string;
  mtimeMs: number;
}

async function walkMd(dir: string): Promise<LocalFile[]> {
  const results: LocalFile[] = [];
  await walkDirRecursive(dir, results);
  return results;
}

async function walkDirRecursive(dir: string, results: LocalFile[]): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });

  for (const entry of entries) {
    // Skip hidden dirs and node_modules
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;

    const full = join(dir, entry.name);

    if (entry.isDirectory()) {
      await walkDirRecursive(full, results);
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      const s = await stat(full);
      results.push({ path: full, mtimeMs: s.mtimeMs });
    }
  }
}
