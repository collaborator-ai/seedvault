// Config
export {
  loadConfig,
  saveConfig,
  configExists,
  getConfigPath,
  getConfigDir,
  addCollection,
  removeCollection,
  normalizeConfigCollections,
  defaultCollectionName,
} from "./config.js";

export type {
  Config,
  CollectionConfig,
  AddCollectionResult,
  NormalizeCollectionsResult,
} from "./config.js";

// Service
export {
  getServiceStatus,
  installService,
  uninstallService,
  restartService,
  ensureDaemonRunning,
} from "./service.js";

export type { ServiceStatus } from "./service.js";

// Health
export { getDaemonHealth, writeHealthFile } from "./health.js";

export type { DaemonHealth } from "./health.js";

// Sync
export { startSync } from "./sync.js";

export type { SyncHandle, SyncStatus, SyncOptions } from "./sync.js";

// Daemon API server
export { createDaemonServer } from "../daemon/api.js";

export type { DaemonServerOptions } from "../daemon/api.js";

// Event bus
export { EventBus } from "../daemon/event-bus.js";

export type { Listener, Unsubscribe } from "../daemon/event-bus.js";

// File events
export type { FileEvent } from "../daemon/watcher.js";

// Client
export { createClient, ApiError, parseVaultEvent, matchesFilter } from "@seedvault/sdk";

export type {
  SeedvaultClient,
  FileEntry,
  PutFileOptions,
  SearchResult,
  SearchOptions,
  SearchResponse,
  ActivityEvent,
  ActivityOptions,
  ActivityResponse,
  HealthResponse,
  SubscribeOptions,
  VaultEvent,
  VaultEventType,
  FileUpdatedEvent,
  FileDeletedEvent,
  ActivityVaultEvent,
} from "@seedvault/sdk";

