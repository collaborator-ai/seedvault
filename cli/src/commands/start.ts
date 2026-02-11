import { writeFileSync, unlinkSync } from "fs";
import type { FSWatcher } from "chokidar";
import {
  loadConfig,
  getPidPath,
  normalizeConfigCollections,
  type CollectionConfig,
  type Config,
} from "../config.js";
import { createClient } from "../client.js";
import { createWatcher, type FileEvent } from "../daemon/watcher.js";
import { Syncer } from "../daemon/syncer.js";
import { installService } from "../daemon/service.js";

/**
 * sv start [-f]
 *
 *   Default: registers an OS service (launchd/systemd) that runs the daemon.
 *   -f / --foreground: runs the daemon directly in the current terminal.
 */
export async function start(args: string[]): Promise<void> {
  const foreground = args.includes("-f") || args.includes("--foreground");

  if (foreground) {
    return startForeground();
  }

  return installService();
}

/** Run daemon in the foreground */
async function startForeground(): Promise<void> {
  let config = loadConfig();
  let { config: normalizedConfig, removedOverlappingCollections } = normalizeConfigCollections(config);
  if (removedOverlappingCollections.length > 0) {
    config = normalizedConfig;
  }

  const client = createClient(config.server, config.token);

  // Verify server reachable
  try {
    await client.health();
  } catch {
    console.error(`Cannot reach server at ${config.server}`);
    process.exit(1);
  }

  const log = (msg: string) => {
    const ts = new Date().toISOString().slice(11, 19);
    console.log(`[${ts}] ${msg}`);
  };

  let lastOverlapWarning = "";
  const maybeLogOverlapWarning = (removed: CollectionConfig[]) => {
    const summary = removed
      .map((c) => `${c.name} (${c.path})`)
      .sort()
      .join(", ");
    if (!summary) {
      lastOverlapWarning = "";
      return;
    }
    if (summary === lastOverlapWarning) return;
    lastOverlapWarning = summary;
    log(`Ignoring overlapping collections in config: ${summary}`);
  };

  maybeLogOverlapWarning(removedOverlappingCollections);

  log("Seedvault daemon starting...");
  log(`  Server:  ${config.server}`);
  log(`  Contributor: ${config.contributorId}`);
  if (config.collections.length === 0) {
    log("  Collections: none");
    log("  Waiting for collections to be added...");
  } else {
    log(`  Collections: ${config.collections.map((f) => f.name).join(", ")}`);
  }

  // Write PID file (useful for sv status / sv stop even in foreground)
  writeFileSync(getPidPath(), String(process.pid));

  const syncer = new Syncer({
    client,
    contributorId: config.contributorId,
    collections: config.collections,
    onLog: log,
  });

  if (config.collections.length > 0) {
    // Initial sync
    log("Running initial sync...");
    try {
      const { uploaded, skipped, deleted } = await syncer.initialSync();
      log(`Initial sync complete: ${uploaded} uploaded, ${skipped} skipped, ${deleted} deleted`);
    } catch (e: unknown) {
      log(`Initial sync failed: ${(e as Error).message}`);
      log("Will continue watching for changes...");
    }
  }

  const onWatcherEvent = (event: FileEvent) => {
    syncer.handleEvent(event).catch((e) => {
      log(`Error handling ${event.type} for ${event.serverPath}: ${(e as Error).message}`);
    });
  };

  let watcher: FSWatcher | null = null;
  const rebuildWatcher = async (collections: CollectionConfig[]): Promise<void> => {
    if (watcher) {
      await watcher.close();
      watcher = null;
    }

    if (collections.length === 0) {
      log("No collections configured. Daemon idle.");
      return;
    }

    watcher = createWatcher(collections, onWatcherEvent);
    log(`Watching ${collections.length} collection(s): ${collections.map((f) => f.name).join(", ")}`);
  };

  await rebuildWatcher(config.collections);

  let reloadingCollections = false;
  const pollTimer = setInterval(() => {
    if (reloadingCollections) return;
    let nextConfig: Config;
    try {
      nextConfig = loadConfig();
    } catch (e: unknown) {
      log(`Failed to read config: ${(e as Error).message}`);
      return;
    }

    ({ config: normalizedConfig, removedOverlappingCollections } = normalizeConfigCollections(nextConfig));
    maybeLogOverlapWarning(removedOverlappingCollections);

    reloadingCollections = true;

    void (async () => {
      try {
        const { nextConfig: reconciledConfig, added, removed } = reconcileCollections(config, normalizedConfig);
        if (added.length === 0 && removed.length === 0) return;

        log(
          `Collections changed: +${added.map((c) => c.name).join(", ") || "none"}, -${removed
            .map((c) => c.name)
            .join(", ") || "none"}`
        );

        config = reconciledConfig;
        syncer.setCollections(reconciledConfig.collections);
        await rebuildWatcher(reconciledConfig.collections);

        for (const collection of removed) {
          await syncer.purgeCollection(collection);
        }
        for (const collection of added) {
          await syncer.syncCollection(collection);
        }
      } catch (e: unknown) {
        log(`Failed to reload collections from config: ${(e as Error).message}`);
      } finally {
        reloadingCollections = false;
      }
    })();
  }, 1500);

  log("Daemon running. Press Ctrl+C to stop.");

  // Handle graceful shutdown
  const shutdown = () => {
    log("Shutting down...");
    clearInterval(pollTimer);
    if (watcher) void watcher.close();
    syncer.stop();

    // Clean up PID file
    try {
      unlinkSync(getPidPath());
    } catch {}

    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

function keyByName(collections: CollectionConfig[]): Map<string, CollectionConfig> {
  const map = new Map<string, CollectionConfig>();
  for (const collection of collections) {
    map.set(collection.name, collection);
  }
  return map;
}

function reconcileCollections(
  prev: Config,
  next: Config
): { nextConfig: Config; added: CollectionConfig[]; removed: CollectionConfig[] } {
  const prevByName = keyByName(prev.collections);
  const nextByName = keyByName(next.collections);

  const added: CollectionConfig[] = [];
  const removed: CollectionConfig[] = [];

  for (const [name, prevCollection] of prevByName) {
    const nextCollection = nextByName.get(name);
    if (!nextCollection) {
      removed.push(prevCollection);
      continue;
    }
    if (nextCollection.path !== prevCollection.path) {
      removed.push(prevCollection);
      added.push(nextCollection);
    }
  }

  for (const [name, nextCollection] of nextByName) {
    if (!prevByName.has(name)) {
      added.push(nextCollection);
    }
  }

  return { nextConfig: next, added, removed };
}
