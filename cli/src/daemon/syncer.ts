import { readdir, stat, readFile } from "fs/promises";
import { join, relative } from "path";
import type { SeedvaultClient, FileEntry } from "../client.js";
import type { CollectionConfig } from "../config.js";
import type { FileEvent } from "./watcher.js";
import { RetryQueue } from "./queue.js";

const SYNC_CONCURRENCY = 10;

export interface SyncerOptions {
  client: SeedvaultClient;
  username: string;
  collections: CollectionConfig[];
  onLog: (msg: string) => void;
}

export class Syncer {
  private client: SeedvaultClient;
  private username: string;
  private collections: CollectionConfig[];
  private queue: RetryQueue;
  private log: (msg: string) => void;

  constructor(opts: SyncerOptions) {
    this.client = opts.client;
    this.username = opts.username;
    this.collections = opts.collections;
    this.log = opts.onLog;
    this.queue = new RetryQueue(opts.client, opts.onLog);
  }

  /** Update the active collections set used for whole-collection syncs. */
  setCollections(collections: CollectionConfig[]): void {
    this.collections = [...collections];
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

    for (const collection of [...this.collections]) {
      const result = await this.syncCollection(collection);
      uploaded += result.uploaded;
      skipped += result.skipped;
      deleted += result.deleted;
    }

    // Purge server files that don't belong to any current collection
    deleted += await this.purgeOrphans();

    return { uploaded, skipped, deleted };
  }

  /**
   * Delete any server files whose collection prefix doesn't match
   * a currently-configured collection. Handles the case where a
   * collection was removed while the daemon wasn't running.
   */
  private async purgeOrphans(): Promise<number> {
    let deleted = 0;

    const { files: allServerFiles } = await this.client.listFiles(this.username);
    const collectionNames = new Set(this.collections.map((c) => c.name));

    const orphans = allServerFiles.filter((f) => {
      const prefix = f.path.split("/")[0];
      return !collectionNames.has(prefix);
    });

    if (orphans.length === 0) return 0;

    this.log(`Purging ${orphans.length} orphaned file(s) from removed collections...`);

    await pooled(orphans, SYNC_CONCURRENCY, async (f) => {
      try {
        await this.client.deleteFile(this.username, f.path);
        deleted++;
      } catch {
        this.queue.enqueue({
          type: "delete",
          username: this.username,
          serverPath: f.path,
          content: null,
          queuedAt: new Date().toISOString(),
          originCtime: null,
          originMtime: null,
        });
      }
    });

    this.log(`  Purged ${deleted} orphaned file(s)`);
    return deleted;
  }

  /**
   * Sync a single collection.
   */
  async syncCollection(collection: CollectionConfig): Promise<{ uploaded: number; skipped: number; deleted: number }> {
    let uploaded = 0;
    let skipped = 0;
    let deleted = 0;

    this.log(`Syncing '${collection.name}' (${collection.path})...`);

    try {
      // Get server file listing for this collection's prefix
      const { files: serverFiles } = await this.client.listFiles(
        this.username,
        collection.name + "/"
      );

      // Build a map of server files by path -> FileEntry
      const serverMap = new Map<string, FileEntry>();
      for (const f of serverFiles) {
        serverMap.set(f.path, f);
      }

      // Phase 1: Prepare — read local files and decide what to upload
      const localFiles = await walkMd(collection.path);
      const localServerPaths = new Set<string>();
      const toUpload: { serverPath: string; content: string; originCtime: string; originMtime: string }[] = [];

      for (const localFile of localFiles) {
        const relPath = toPosixPath(relative(collection.path, localFile.path));
        const serverPath = `${collection.name}/${relPath}`;
        localServerPaths.add(serverPath);

        const serverEntry = serverMap.get(serverPath);
        if (serverEntry) {
          const serverMod = serverEntry.originMtime || serverEntry.modifiedAt;
          const serverDate = new Date(serverMod).getTime();
          const localDate = localFile.mtimeMs;
          if (localDate <= serverDate) {
            skipped++;
            continue;
          }
        }

        const content = await readFile(localFile.path, "utf-8");
        const originCtime = new Date(localFile.birthtimeMs).toISOString();
        const originMtime = new Date(localFile.mtimeMs).toISOString();
        toUpload.push({ serverPath, content, originCtime, originMtime });
      }

      // Phase 2: Upload with bounded concurrency
      await pooled(toUpload, SYNC_CONCURRENCY, async (item) => {
        try {
          await this.client.putFile(this.username, item.serverPath, item.content, {
            originCtime: item.originCtime,
            originMtime: item.originMtime,
          });
          uploaded++;
        } catch {
          this.queue.enqueue({
            type: "put",
            username: this.username,
            serverPath: item.serverPath,
            content: item.content,
            queuedAt: new Date().toISOString(),
            originCtime: item.originCtime,
            originMtime: item.originMtime,
          });
        }
      });

      // Phase 3: Delete server files that no longer exist locally
      const toDelete = serverFiles.filter((f) => !localServerPaths.has(f.path));
      await pooled(toDelete, SYNC_CONCURRENCY, async (f) => {
        try {
          await this.client.deleteFile(this.username, f.path);
          deleted++;
        } catch {
          this.queue.enqueue({
            type: "delete",
            username: this.username,
            serverPath: f.path,
            content: null,
            queuedAt: new Date().toISOString(),
          });
        }
      });

      this.log(
        `  '${collection.name}': ${uploaded} uploaded, ${skipped} up-to-date, ${deleted} deleted`
      );
    } catch (e: unknown) {
      this.log(`  '${collection.name}': sync failed (${(e as Error).message})`);
    }

    return { uploaded, skipped, deleted };
  }

  /**
   * Remove all remote files under a collection prefix.
   * Used when a collection is removed from config while the daemon is running.
   */
  async purgeCollection(collection: CollectionConfig): Promise<{ deleted: number; queued: number }> {
    let deleted = 0;
    let queued = 0;

    this.log(`Removing '${collection.name}' files from server...`);

    try {
      const { files: serverFiles } = await this.client.listFiles(
        this.username,
        collection.name + "/"
      );

      await pooled(serverFiles, SYNC_CONCURRENCY, async (f) => {
        try {
          await this.client.deleteFile(this.username, f.path);
          deleted++;
        } catch {
          this.queue.enqueue({
            type: "delete",
            username: this.username,
            serverPath: f.path,
            content: null,
            queuedAt: new Date().toISOString(),
          });
          queued++;
        }
      });

      this.log(`  '${collection.name}': ${deleted} deleted, ${queued} queued`);
    } catch (e: unknown) {
      this.log(`  '${collection.name}': remove failed (${(e as Error).message})`);
    }

    return { deleted, queued };
  }

  /**
   * Handle a file event from the watcher.
   */
  async handleEvent(event: FileEvent): Promise<void> {
    if (event.type === "add" || event.type === "change") {
      const [content, s] = await Promise.all([
        readFile(event.localPath, "utf-8"),
        stat(event.localPath),
      ]);
      const originCtime = new Date(s.birthtimeMs).toISOString();
      const originMtime = new Date(s.mtimeMs).toISOString();
      this.log(`PUT ${event.serverPath} (${content.length} bytes)`);
      this.queue.enqueue({
        type: "put",
        username: this.username,
        serverPath: event.serverPath,
        content,
        queuedAt: new Date().toISOString(),
        originCtime,
        originMtime,
      });
    } else if (event.type === "unlink") {
      this.log(`DELETE ${event.serverPath}`);
      this.queue.enqueue({
        type: "delete",
        username: this.username,
        serverPath: event.serverPath,
        content: null,
        queuedAt: new Date().toISOString(),
        originCtime: null,
        originMtime: null,
      });
    }
  }

  /** Stop retry timers. Pending ops remain in memory for process lifetime only. */
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
  birthtimeMs: number;
}

function toPosixPath(path: string): string {
  return path.split("\\").join("/");
}

async function walkMd(dir: string): Promise<LocalFile[]> {
  const results: LocalFile[] = [];
  await walkDirRecursive(dir, results);
  return results;
}

async function pooled<T>(items: T[], concurrency: number, fn: (item: T) => Promise<void>): Promise<void> {
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      await fn(items[idx]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
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
      results.push({ path: full, mtimeMs: s.mtimeMs, birthtimeMs: s.birthtimeMs });
    }
  }
}
