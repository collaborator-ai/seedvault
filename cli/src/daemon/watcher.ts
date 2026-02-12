import { watch, type FSWatcher } from "chokidar";
import { relative } from "path";
import type { CollectionConfig } from "../config.js";

export type FileEvent =
  | { type: "add" | "change"; serverPath: string; localPath: string }
  | { type: "unlink"; serverPath: string; localPath: string };

export type EventHandler = (event: FileEvent) => void;

/**
 * Create a chokidar watcher for a set of configured collections.
 * Maps local file events to server-relative paths using collection names.
 */
export function createWatcher(
  collections: CollectionConfig[],
  onEvent: EventHandler
): FSWatcher {
  // Build the paths to watch
  const paths = collections.map((f) => f.path);

  // Custom ignore function: only ignore dotfiles WITHIN collections,
  // not dotdirs in the absolute path leading to the collection.
  const shouldIgnore = (filePath: string): boolean => {
    // Find which collection this path belongs to
    for (const col of collections) {
      if (filePath.startsWith(col.path + "/") || filePath === col.path) {
        // Get the relative path within the collection
        const relPath = filePath.slice(col.path.length + 1);
        // Check if any segment in the relative path starts with "."
        const segments = relPath.split("/");
        for (const seg of segments) {
          if (seg.startsWith(".")) return true;
          if (seg === "node_modules") return true;
          if (seg.includes(".tmp.")) return true;
        }
        return false;
      }
    }
    return false;
  };

  const watcher = watch(paths, {
    ignored: shouldIgnore,
    persistent: true,
    ignoreInitial: true,       // we handle initial sync separately
    awaitWriteFinish: {
      stabilityThreshold: 300,
      pollInterval: 100,
    },
  });

  // Build a lookup: absolute collection path -> collection name
  const collectionMap = new Map<string, string>();
  for (const f of collections) {
    collectionMap.set(f.path, f.name);
  }

  function toServerPath(localPath: string): string | null {
    // Only markdown files
    if (!localPath.endsWith(".md")) return null;

    for (const [collectionPath, name] of collectionMap) {
      if (localPath.startsWith(collectionPath + "/") || localPath === collectionPath) {
        const rel = relative(collectionPath, localPath);
        return `${name}/${rel}`;
      }
    }
    return null;
  }

  watcher.on("add", (path) => {
    const sp = toServerPath(path);
    if (sp) onEvent({ type: "add", serverPath: sp, localPath: path });
  });

  watcher.on("change", (path) => {
    const sp = toServerPath(path);
    if (sp) onEvent({ type: "change", serverPath: sp, localPath: path });
  });

  watcher.on("unlink", (path) => {
    const sp = toServerPath(path);
    if (sp) onEvent({ type: "unlink", serverPath: sp, localPath: path });
  });

  return watcher;
}
