import { readdir, stat } from "fs/promises";
import { join, relative } from "path";
import type { CollectionConfig } from "../config.js";
import type { FileEvent } from "./watcher.js";

export type EventHandler = (event: FileEvent) => void;

interface FileState {
  mtimeMs: number;
  size: number;
}

/**
 * Manual polling watcher for environments where inotify doesn't work.
 * Scans directories periodically and compares file states.
 */
export class PollWatcher {
  private collections: CollectionConfig[];
  private onEvent: EventHandler;
  private interval: number;
  private timer: NodeJS.Timeout | null = null;
  private fileStates = new Map<string, FileState>();
  private running = false;

  constructor(collections: CollectionConfig[], onEvent: EventHandler, intervalMs = 1000) {
    this.collections = collections;
    this.onEvent = onEvent;
    this.interval = intervalMs;
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    // Initial scan to populate state (don't emit events)
    await this.scan(false);

    // Start polling
    this.timer = setInterval(() => {
      this.scan(true).catch((err) => {
        console.error(`[poll-watcher] scan error: ${err.message}`);
      });
    }, this.interval);
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async scan(emitEvents: boolean): Promise<void> {
    const currentFiles = new Map<string, FileState>();

    for (const collection of this.collections) {
      await this.scanDir(collection.path, collection, currentFiles);
    }

    if (emitEvents) {
      // Check for new or changed files
      for (const [path, state] of currentFiles) {
        const oldState = this.fileStates.get(path);
        if (!oldState) {
          // New file
          const collection = this.findCollection(path);
          if (collection) {
            const serverPath = this.toServerPath(path, collection);
            if (serverPath) {
              this.onEvent({ type: "add", serverPath, localPath: path });
            }
          }
        } else if (oldState.mtimeMs !== state.mtimeMs || oldState.size !== state.size) {
          // Changed file
          const collection = this.findCollection(path);
          if (collection) {
            const serverPath = this.toServerPath(path, collection);
            if (serverPath) {
              this.onEvent({ type: "change", serverPath, localPath: path });
            }
          }
        }
      }

      // Check for deleted files
      for (const [path] of this.fileStates) {
        if (!currentFiles.has(path)) {
          const collection = this.findCollection(path);
          if (collection) {
            const serverPath = this.toServerPath(path, collection);
            if (serverPath) {
              this.onEvent({ type: "unlink", serverPath, localPath: path });
            }
          }
        }
      }
    }

    this.fileStates = currentFiles;
  }

  private async scanDir(
    dir: string,
    collection: CollectionConfig,
    out: Map<string, FileState>
  ): Promise<void> {
    try {
      const entries = await readdir(dir, { withFileTypes: true });

      for (const entry of entries) {
        // Skip hidden files and node_modules
        if (entry.name.startsWith(".") || entry.name === "node_modules") continue;

        const fullPath = join(dir, entry.name);

        if (entry.isDirectory()) {
          await this.scanDir(fullPath, collection, out);
        } else if (entry.isFile() && entry.name.endsWith(".md")) {
          try {
            const s = await stat(fullPath);
            out.set(fullPath, { mtimeMs: s.mtimeMs, size: s.size });
          } catch {
            // File might have been deleted between readdir and stat
          }
        }
      }
    } catch {
      // Directory might not exist or be readable
    }
  }

  private findCollection(path: string): CollectionConfig | undefined {
    for (const c of this.collections) {
      if (path.startsWith(c.path + "/") || path === c.path) {
        return c;
      }
    }
    return undefined;
  }

  private toServerPath(localPath: string, collection: CollectionConfig): string | null {
    if (!localPath.endsWith(".md")) return null;
    const rel = relative(collection.path, localPath);
    return `${collection.name}/${rel}`;
  }
}
