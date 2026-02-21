import type { FSWatcher } from "chokidar";
import {
  loadConfig,
  normalizeConfigCollections,
  type CollectionConfig,
  type Config,
} from "../config.js";
import { createClient } from "../client.js";
import { createWatcher, type FileEvent } from "../daemon/watcher.js";
import { EventBus } from "../daemon/event-bus.js";
import { Syncer } from "../daemon/syncer.js";
import { getDaemonHealth, writeHealthFile } from "./health.js";

export interface SyncStatus {
  running: boolean;
  serverConnected: boolean;
  collectionsWatched: number;
  pendingOps: number;
  watcherAlive: boolean;
  lastSyncAt: string | null;
  lastReconcileAt: string | null;
}

export interface SyncHandle {
  stop(): Promise<void>;
  getStatus(): SyncStatus;
  fileEvents: EventBus<FileEvent>;
}

export interface SyncOptions {
  config: Config;
  onLog?: (msg: string) => void;
  onError?: (error: Error) => void;
  reconcileInterval?: number;
  healthInterval?: number;
  pollInterval?: number;
  enableHealthFile?: boolean;
}

const DEFAULT_RECONCILE_INTERVAL = 5 * 60 * 1000;
const DEFAULT_HEALTH_INTERVAL = 5000;
const DEFAULT_POLL_INTERVAL = 1500;

export async function startSync(
  options: SyncOptions,
): Promise<SyncHandle> {
  const {
    onLog,
    onError,
    reconcileInterval = DEFAULT_RECONCILE_INTERVAL,
    healthInterval = DEFAULT_HEALTH_INTERVAL,
    pollInterval = DEFAULT_POLL_INTERVAL,
    enableHealthFile = true,
  } = options;

  const log = onLog ?? (() => {});
  const fileEventBus = new EventBus<FileEvent>();

  // Coexistence check: prevent two sync engines
  const existingHealth = getDaemonHealth();
  if (existingHealth?.running) {
    const updatedAt = new Date(existingHealth.updatedAt).getTime();
    const staleThreshold = healthInterval * 3;
    if (Date.now() - updatedAt < staleThreshold) {
      throw new Error(
        "Another sync engine is already running. " +
        "Stop the existing daemon before starting a new one.",
      );
    }
  }

  let config = options.config;
  let { config: normalizedConfig, removedOverlappingCollections } =
    normalizeConfigCollections(config);
  if (removedOverlappingCollections.length > 0) {
    config = normalizedConfig;
  }

  let client = createClient(config.server, config.token);

  // Verify server reachable
  try {
    await client.health();
  } catch {
    throw new Error(`Cannot reach server at ${config.server}`);
  }

  let lastOverlapWarning = "";
  const maybeLogOverlapWarning = (
    removed: CollectionConfig[],
  ) => {
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

  let syncer = new Syncer({
    client,
    username: config.username,
    collections: config.collections,
    onLog: log,
  });

  let serverConnected = true;
  let lastSyncAt: string | null = null;
  let lastReconcileAt: string | null = null;
  let watcher: FSWatcher | null = null;
  let stopped = false;

  const updateHealth = () => {
    if (!enableHealthFile) return;
    writeHealthFile({
      running: true,
      serverConnected,
      serverUrl: config.server,
      username: config.username,
      pendingOps: syncer.pendingOps,
      collectionsWatched: config.collections.length,
      watcherAlive: watcher !== null && !watcher.closed,
      lastSyncAt,
      lastReconcileAt,
      updatedAt: new Date().toISOString(),
    });
  };

  // Initial sync
  log("Running initial sync...");
  try {
    const { uploaded, skipped, deleted } = await syncer.initialSync();
    log(
      `Initial sync complete: ${uploaded} uploaded, ` +
      `${skipped} skipped, ${deleted} deleted`,
    );
    lastSyncAt = new Date().toISOString();
    updateHealth();
  } catch (e: unknown) {
    log(`Initial sync failed: ${(e as Error).message}`);
    log("Will continue watching for changes...");
    serverConnected = false;
    updateHealth();
  }

  let reloading = false;

  const rebuildWatcher = async (
    collections: CollectionConfig[],
  ): Promise<void> => {
    if (watcher) {
      await watcher.close();
      watcher = null;
    }

    if (collections.length === 0) {
      log("No collections configured. Sync idle.");
      return;
    }

    watcher = createWatcher(
      collections,
      (event: FileEvent) => {
        fileEventBus.emit(event);
        syncer.handleEvent(event).catch((e) => {
          const label =
            "serverPath" in event
              ? event.serverPath
              : event.collectionName;
          log(
            `Error handling ${event.type} for ${label}: ` +
            `${(e as Error).message}`,
          );
        });
      },
      (error: Error) => {
        log(`Watcher error: ${error.message}`);
        if (onError) onError(error);
        if (!reloading) {
          log("Attempting to rebuild watcher...");
          void rebuildWatcher(config.collections);
        }
      },
    );
    log(
      `Watching ${collections.length} collection(s): ` +
      `${collections.map((f) => f.name).join(", ")}`,
    );
  };

  await rebuildWatcher(config.collections);

  const pollTimer = setInterval(() => {
    if (reloading) return;
    let nextConfig: Config;
    try {
      nextConfig = loadConfig();
    } catch (e: unknown) {
      log(`Failed to read config: ${(e as Error).message}`);
      return;
    }

    ({ config: normalizedConfig, removedOverlappingCollections } =
      normalizeConfigCollections(nextConfig));
    maybeLogOverlapWarning(removedOverlappingCollections);

    // Detect core config changes (server, token, username)
    const coreChanged =
      normalizedConfig.server !== config.server ||
      normalizedConfig.token !== config.token ||
      normalizedConfig.username !== config.username;

    if (!coreChanged) {
      const { nextConfig: reconciledConfig, added, removed } =
        reconcileCollections(config, normalizedConfig);
      if (added.length === 0 && removed.length === 0) return;

      reloading = true;
      void (async () => {
        try {
          log(
            `Collections changed: ` +
            `+${added.map((c) => c.name).join(", ") || "none"}, ` +
            `-${removed.map((c) => c.name).join(", ") || "none"}`,
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
          log(
            `Failed to reload collections: ${(e as Error).message}`,
          );
        } finally {
          reloading = false;
        }
      })();
      return;
    }

    // Core config changed — full reinitialize
    reloading = true;
    void (async () => {
      try {
        log("Config changed, reinitializing...");
        if (config.server !== normalizedConfig.server) {
          log(
            `  Server: ${config.server} -> ` +
            `${normalizedConfig.server}`,
          );
        }
        if (config.username !== normalizedConfig.username) {
          log(
            `  Username: ${config.username} -> ` +
            `${normalizedConfig.username}`,
          );
        }
        if (config.token !== normalizedConfig.token) {
          log(`  Token: updated`);
        }

        syncer.stop();

        client = createClient(
          normalizedConfig.server,
          normalizedConfig.token,
        );
        config = normalizedConfig;

        syncer = new Syncer({
          client,
          username: config.username,
          collections: config.collections,
          onLog: log,
        });

        await rebuildWatcher(config.collections);

        if (config.collections.length > 0) {
          log("Running sync after reinitialize...");
          const { uploaded, skipped, deleted } =
            await syncer.initialSync();
          log(
            `Sync complete: ${uploaded} uploaded, ` +
            `${skipped} skipped, ${deleted} deleted`,
          );
        }
      } catch (e: unknown) {
        log(`Failed to reinitialize: ${(e as Error).message}`);
      } finally {
        reloading = false;
      }
    })();
  }, pollInterval);

  const healthTimer = setInterval(() => {
    if (watcher?.closed && !reloading) {
      log("Watchdog: watcher closed unexpectedly, rebuilding...");
      void rebuildWatcher(config.collections);
    }
    updateHealth();
  }, healthInterval);

  const reconcileTimer = setInterval(() => {
    if (reloading || config.collections.length === 0) return;
    void (async () => {
      try {
        const { uploaded, deleted } = await syncer.initialSync();
        lastReconcileAt = new Date().toISOString();
        if (uploaded > 0 || deleted > 0) {
          log(
            `Reconciliation: ${uploaded} uploaded, ${deleted} deleted`,
          );
          lastSyncAt = lastReconcileAt;
        }
        updateHealth();
      } catch (e: unknown) {
        log(`Reconciliation failed: ${(e as Error).message}`);
      }
    })();
  }, reconcileInterval);

  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;

    clearInterval(pollTimer);
    clearInterval(healthTimer);
    clearInterval(reconcileTimer);
    if (watcher) await watcher.close();
    syncer.stop();

    if (enableHealthFile) {
      writeHealthFile({
        running: false,
        serverConnected: false,
        serverUrl: config.server,
        username: config.username,
        pendingOps: 0,
        collectionsWatched: 0,
        watcherAlive: false,
        lastSyncAt,
        lastReconcileAt,
        updatedAt: new Date().toISOString(),
      });
    }
  };

  const getStatus = (): SyncStatus => ({
    running: !stopped,
    serverConnected,
    collectionsWatched: config.collections.length,
    pendingOps: syncer.pendingOps,
    watcherAlive: watcher !== null && !watcher.closed,
    lastSyncAt,
    lastReconcileAt,
  });

  return { stop, getStatus, fileEvents: fileEventBus };
}

function keyByName(
  collections: CollectionConfig[],
): Map<string, CollectionConfig> {
  const map = new Map<string, CollectionConfig>();
  for (const collection of collections) {
    map.set(collection.name, collection);
  }
  return map;
}

function reconcileCollections(
  prev: Config,
  next: Config,
): {
  nextConfig: Config;
  added: CollectionConfig[];
  removed: CollectionConfig[];
} {
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
