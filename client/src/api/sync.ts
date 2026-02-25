import type { FSWatcher } from "chokidar";
import {
  normalizeConfigCollections,
  type CollectionConfig,
  type Config,
} from "../config.js";
import { createClient } from "../client.js";
import { createWatcher, type FileEvent } from "../daemon/watcher.js";
import { Syncer } from "../daemon/syncer.js";
import { writeHealthFile } from "./health.js";

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
  reloadConfig(config: Config): Promise<void>;
}

export interface SyncOptions {
  config: Config;
  configDir?: string;
  onLog?: (msg: string) => void;
  onError?: (error: Error) => void;
  onSyncComplete?: (stats: {
    uploaded: number;
    skipped: number;
    deleted: number;
  }) => void;
  reconcileInterval?: number;
  healthInterval?: number;
  enableHealthFile?: boolean;
}

const DEFAULT_RECONCILE_INTERVAL = 5 * 60 * 1000;
const DEFAULT_HEALTH_INTERVAL = 5000;

export async function startSync(
  options: SyncOptions,
): Promise<SyncHandle> {
  const {
    configDir,
    onLog,
    onError,
    onSyncComplete,
    reconcileInterval = DEFAULT_RECONCILE_INTERVAL,
    healthInterval = DEFAULT_HEALTH_INTERVAL,
    enableHealthFile = true,
  } = options;

  const log = onLog ?? (() => {});

  const initial = normalizeConfigCollections(options.config);
  let config = initial.config;

  let client = createClient(config.server, config.token);

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

  maybeLogOverlapWarning(initial.removedOverlappingCollections);

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
  let reloading = false;
  const MAX_WATCHER_RETRIES = 3;
  let watcherRetries = 0;

  const updateHealth = () => {
    if (!enableHealthFile) return;
    writeHealthFile(
      {
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
      },
      configDir,
    );
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
    onSyncComplete?.({ uploaded, skipped, deleted });
    updateHealth();
  } catch (e: unknown) {
    log(`Initial sync failed: ${(e as Error).message}`);
    log("Will continue watching for changes...");
    serverConnected = false;
    updateHealth();
  }

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
        onError?.(error);
        if (!reloading && watcherRetries < MAX_WATCHER_RETRIES) {
          watcherRetries++;
          log(
            `Attempting to rebuild watcher ` +
            `(${watcherRetries}/${MAX_WATCHER_RETRIES})...`,
          );
          void rebuildWatcher(config.collections);
        } else if (watcherRetries >= MAX_WATCHER_RETRIES) {
          log(
            "Max watcher rebuild attempts reached. " +
            "File watching stopped.",
          );
        }
      },
    );
    watcherRetries = 0;
    log(
      `Watching ${collections.length} collection(s): ` +
      `${collections.map((f) => f.name).join(", ")}`,
    );
  };

  await rebuildWatcher(config.collections);

  const reloadConfig = async (
    nextConfig: Config,
  ): Promise<void> => {
    if (reloading) return;
    reloading = true;

    try {
      const normalized = normalizeConfigCollections(nextConfig);
      maybeLogOverlapWarning(normalized.removedOverlappingCollections);

      const incoming = normalized.config;

      const coreChanged =
        incoming.server !== config.server ||
        incoming.token !== config.token ||
        incoming.username !== config.username;

      if (!coreChanged) {
        const { nextConfig: reconciledConfig, added, removed } =
          reconcileCollections(config, incoming);
        if (added.length === 0 && removed.length === 0) return;

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
        return;
      }

      log("Config changed, reinitializing...");
      if (config.server !== incoming.server) {
        log(
          `  Server: ${config.server} -> ${incoming.server}`,
        );
      }
      if (config.username !== incoming.username) {
        log(
          `  Username: ${config.username} -> ${incoming.username}`,
        );
      }
      if (config.token !== incoming.token) {
        log(`  Token: updated`);
      }

      syncer.stop();

      client = createClient(incoming.server, incoming.token);
      config = incoming;

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
        onSyncComplete?.({ uploaded, skipped, deleted });
      }
    } catch (e: unknown) {
      log(`Failed to reload config: ${(e as Error).message}`);
    } finally {
      reloading = false;
    }
  };

  const healthTimer = setInterval(() => {
    if (watcher?.closed && !reloading) {
      log("Watchdog: watcher closed unexpectedly, rebuilding...");
      void rebuildWatcher(config.collections);
    }
    updateHealth();
  }, healthInterval);

  const reconcile = async (): Promise<void> => {
    if (reloading || config.collections.length === 0) return;
    try {
      const { uploaded, skipped, deleted } =
        await syncer.initialSync();
      lastReconcileAt = new Date().toISOString();
      if (uploaded > 0 || deleted > 0) {
        log(
          `Reconciliation: ${uploaded} uploaded, ${deleted} deleted`,
        );
        lastSyncAt = lastReconcileAt;
        onSyncComplete?.({ uploaded, skipped, deleted });
      }
      updateHealth();
    } catch (e: unknown) {
      log(`Reconciliation failed: ${(e as Error).message}`);
    }
  };

  const reconcileTimer = setInterval(
    () => void reconcile(),
    reconcileInterval,
  );

  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;

    clearInterval(healthTimer);
    clearInterval(reconcileTimer);
    if (watcher) await watcher.close();
    syncer.stop();

    if (enableHealthFile) {
      writeHealthFile(
        {
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
        },
        configDir,
      );
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

  return { stop, getStatus, reloadConfig };
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
