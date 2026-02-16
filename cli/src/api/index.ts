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

// Health
export { getDaemonHealth, writeHealthFile } from "./health.js";

export type { DaemonHealth } from "./health.js";

// Client
export { createClient, ApiError } from "./client.js";

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
} from "./client.js";

// Daemon events
export { subscribeDaemonEvents } from "./daemon-events.js";

export type { DaemonFileEvent } from "./daemon-events.js";
