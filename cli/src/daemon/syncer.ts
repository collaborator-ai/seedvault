import { readdir, stat, readFile } from "fs/promises";
import { join, relative } from "path";
import type { SeedvaultClient } from "../client.js";
import type { CollectionConfig } from "../config.js";
import type { FileEvent } from "./watcher.js";
import { RetryQueue } from "./queue.js";

export interface SyncerOptions {
  client: SeedvaultClient;
  contributorId: string;
  collections: CollectionConfig[];
  onLog: (msg: string) => void;
}

export class Syncer {
  private client: SeedvaultClient;
  private contributorId: string;
  private collections: CollectionConfig[];
  private queue: RetryQueue;
  private log: (msg: string) => void;

  constructor(opts: SyncerOptions) {
    this.client = opts.client;
    this.contributorId = opts.contributorId;
    this.collections = opts.collections;
    this.log = opts.onLog;
    this.queue = new RetryQueue(opts.client, opts.onLog);
  }

  /**
   * Initial sync: compare local files against what's on the server,
   * PUT anything that's newer or missing, and DELETE files that
   * exist on server but no longer exist locally.
   */
  async initialSync(): Promise<{ uploaded: number; skipped: number; deleted: number }> {
    let uploaded = 0;
    let skipped = 0;
    let deleted = 0;

    for (const collection of this.collections) {
      let collectionUploaded = 0;
      let collectionSkipped = 0;
      let collectionDeleted = 0;

      this.log(`Syncing '${collection.name}' (${collection.path})...`);

      try {
        // Get server file listing for this collection's prefix
        const { files: serverFiles } = await this.client.listFiles(
          this.contributorId,
          collection.name + "/"
        );

        // Build a map of server files by path -> modifiedAt
        const serverMap = new Map<string, string>();
        for (const f of serverFiles) {
          serverMap.set(f.path, f.modifiedAt);
        }

        // Walk local directory for .md files
        const localFiles = await walkMd(collection.path);
        const localServerPaths = new Set<string>();

        for (const localFile of localFiles) {
          const relPath = toPosixPath(relative(collection.path, localFile.path));
          const serverPath = `${collection.name}/${relPath}`;
          localServerPaths.add(serverPath);

          const serverMod = serverMap.get(serverPath);
          if (serverMod) {
            // File exists on server — compare mtime
            const serverDate = new Date(serverMod).getTime();
            const localDate = localFile.mtimeMs;
            if (localDate <= serverDate) {
              skipped++;
              collectionSkipped++;
              continue;
            }
          }

          // Upload
          const content = await readFile(localFile.path, "utf-8");
          try {
            await this.client.putFile(this.contributorId, serverPath, content);
            uploaded++;
            collectionUploaded++;
          } catch {
            // If server unreachable, queue it
            this.queue.enqueue({
              type: "put",
              contributorId: this.contributorId,
              serverPath,
              content,
              queuedAt: new Date().toISOString(),
            });
          }
        }

        // Delete server files that no longer exist locally
        for (const f of serverFiles) {
          if (localServerPaths.has(f.path)) continue;

          try {
            await this.client.deleteFile(this.contributorId, f.path);
            deleted++;
            collectionDeleted++;
          } catch {
            // If server unreachable, queue it
            this.queue.enqueue({
              type: "delete",
              contributorId: this.contributorId,
              serverPath: f.path,
              content: null,
              queuedAt: new Date().toISOString(),
            });
          }
        }

        this.log(
          `  '${collection.name}': ${collectionUploaded} uploaded, ${collectionSkipped} up-to-date, ${collectionDeleted} deleted`
        );
      } catch (e: unknown) {
        this.log(`  '${collection.name}': sync failed (${(e as Error).message})`);
      }
    }

    return { uploaded, skipped, deleted };
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
        contributorId: this.contributorId,
        serverPath: event.serverPath,
        content,
        queuedAt: new Date().toISOString(),
      });
    } else if (event.type === "unlink") {
      this.log(`DELETE ${event.serverPath}`);
      this.queue.enqueue({
        type: "delete",
        contributorId: this.contributorId,
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

function toPosixPath(path: string): string {
  return path.split("\\").join("/");
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
