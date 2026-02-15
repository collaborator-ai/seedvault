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
export {
  createClient,
  SeedvaultClient,
  SeedvaultError,
} from "./client.js";

export type {
  SeedvaultClientOptions,
  FileEntry,
  FileContent,
  SearchResult,
  SearchOptions,
  VaultEvent,
  VaultEventType,
  PutFileOptions,
} from "./client.js";
