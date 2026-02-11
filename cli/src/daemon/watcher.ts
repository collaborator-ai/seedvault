import { watch, type FSWatcher } from "chokidar";
import { relative } from "path";
import { existsSync } from "fs";
import type { CollectionConfig } from "../config.js";

/**
 * Detect if running inside a container (Docker, Podman, etc.)
 * where native inotify may not work reliably.
 */
function isRunningInContainer(): boolean {
  // Check for Docker/.dockerenv
  if (existsSync("/.dockerenv")) return true;
  
  // Check for container runtime in cgroup
  try {
    const cgroup = require("fs").readFileSync("/proc/1/cgroup", "utf-8");
    if (cgroup.includes("docker") || cgroup.includes("kubepods") || cgroup.includes("containerd")) {
      return true;
    }
  } catch {
    // Ignore — file might not exist
  }
  
  return false;
}

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

  // Use polling in Docker/containers where inotify doesn't work reliably
  const usePolling = process.env.SEEDVAULT_USE_POLLING === "1" || isRunningInContainer();
  
  if (usePolling) {
    console.log(`[watcher] Using polling mode (container detected: ${isRunningInContainer()})`);
  }

  const watcher = watch(paths, {
    ignored: [
      /(^|[/\\])\./,          // dotfiles / dotdirs (.git, .DS_Store, etc.)
      "**/node_modules/**",
      "**/*.tmp.*",
    ],
    persistent: true,
    ignoreInitial: true,       // we handle initial sync separately
    usePolling,
    interval: usePolling ? 500 : undefined,
    binaryInterval: usePolling ? 500 : undefined,
    // Disable awaitWriteFinish for polling - it can interfere
    awaitWriteFinish: usePolling ? false : {
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
    console.log(`[watcher] add: ${path}`);
    const sp = toServerPath(path);
    if (sp) onEvent({ type: "add", serverPath: sp, localPath: path });
  });

  watcher.on("change", (path) => {
    console.log(`[watcher] change: ${path}`);
    const sp = toServerPath(path);
    if (sp) onEvent({ type: "change", serverPath: sp, localPath: path });
  });

  watcher.on("unlink", (path) => {
    console.log(`[watcher] unlink: ${path}`);
    const sp = toServerPath(path);
    if (sp) onEvent({ type: "unlink", serverPath: sp, localPath: path });
  });
  
  watcher.on("error", (err) => {
    console.error(`[watcher] error: ${err}`);
  });
  
  watcher.on("ready", () => {
    console.log(`[watcher] ready, watching ${paths.length} path(s)`);
  });

  return watcher;
}
