import { readdir, stat, readFile } from "fs/promises";
import { join, relative } from "path";
import type { SeedvaultClient, FileEntry } from "../client.js";
import type { CollectionConfig } from "../config.js";
import type { FileEvent } from "./watcher.js";
import { RetryQueue } from "./queue.js";

const SYNC_CONCURRENCY = 10;

/**
 * Resolve origin ctime: returns mtime when birthtimeMs is 0 (Linux/Docker bug).
 */
function resolveOriginCtime(birthtimeMs: number, mtimeMs: number): number {
  return birthtimeMs > 0 ? birthtimeMs : mtimeMs;
}

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
  private writeTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private dirSyncTimers = new Map<string, ReturnType<typeof setTimeout>>();

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
          const serverDate = new Date(serverEntry.modifiedAt).getTime();
          const localDate = localFile.mtimeMs;
          if (localDate <= serverDate) {
            skipped++;
            continue;
          }
        }

        const content = await readFile(localFile.path, "utf-8");
        const originCtime = new Date(resolveOriginCtime(localFile.birthtimeMs, localFile.mtimeMs)).toISOString();
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
   * Writes are debounced (300ms) so partial saves don't trigger
   * multiple uploads. Unlinks fire immediately.
   */
  async handleEvent(event: FileEvent): Promise<void> {
    if (event.type === "add" || event.type === "change") {
      const key = event.serverPath;
      const existing = this.writeTimers.get(key);
      if (existing) clearTimeout(existing);
      this.writeTimers.set(key, setTimeout(() => {
        this.writeTimers.delete(key);
        this.syncWrite(event.serverPath, event.localPath);
      }, 300));
    } else if (event.type === "unlink") {
      // Cancel any pending write for this file
      const pending = this.writeTimers.get(event.serverPath);
      if (pending) {
        clearTimeout(pending);
        this.writeTimers.delete(event.serverPath);
      }
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
    } else if (event.type === "unlinkDir") {
      // Debounce directory deletions — multiple unlinkDir events
      // may fire for nested directories removed at once
      const key = event.collectionName;
      const existing = this.dirSyncTimers.get(key);
      if (existing) clearTimeout(existing);
      this.dirSyncTimers.set(key, setTimeout(() => {
        this.dirSyncTimers.delete(key);
        const collection = this.collections.find((c) => c.name === key);
        if (collection) {
          this.reconcileCollection(collection).catch((e) => {
            this.log(`Reconcile failed for '${key}': ${(e as Error).message}`);
          });
        }
      }, 500));
    }
  }

  private async syncWrite(serverPath: string, localPath: string): Promise<void> {
    try {
      const [content, s] = await Promise.all([
        readFile(localPath, "utf-8"),
        stat(localPath),
      ]);
      const originCtime = new Date(resolveOriginCtime(s.birthtimeMs, s.mtimeMs)).toISOString();
      const originMtime = new Date(s.mtimeMs).toISOString();
      this.log(`PUT ${serverPath} (${content.length} bytes)`);
      this.queue.enqueue({
        type: "put",
        username: this.username,
        serverPath,
        content,
        queuedAt: new Date().toISOString(),
        originCtime,
        originMtime,
      });
    } catch (e: unknown) {
      // File may have been deleted between event and debounce firing
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
      throw e;
    }
  }

  /**
   * Diff a collection's server files against local files and delete
   * any server files that no longer exist locally.
   */
  private async reconcileCollection(collection: CollectionConfig): Promise<void> {
    this.log(`Reconciling '${collection.name}' after directory change...`);
    const { files: serverFiles } = await this.client.listFiles(
      this.username,
      collection.name + "/"
    );
    if (serverFiles.length === 0) return;

    const localFiles = await walkMd(collection.path).catch(() => [] as LocalFile[]);
    const localServerPaths = new Set(
      localFiles.map((f) => `${collection.name}/${toPosixPath(relative(collection.path, f.path))}`)
    );

    const orphans = serverFiles.filter((f) => !localServerPaths.has(f.path));
    if (orphans.length === 0) return;

    this.log(`  Deleting ${orphans.length} orphaned file(s)`);
    for (const f of orphans) {
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
  }

  /** Stop retry timers. Pending ops remain in memory for process lifetime only. */
  stop(): void {
    this.queue.stop();
    for (const timer of this.writeTimers.values()) clearTimeout(timer);
    this.writeTimers.clear();
    for (const timer of this.dirSyncTimers.values()) clearTimeout(timer);
    this.dirSyncTimers.clear();
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
