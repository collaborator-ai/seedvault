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
} from "./client.js";
