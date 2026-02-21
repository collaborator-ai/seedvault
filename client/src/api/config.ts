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
} from "../config.js";

export type {
  Config,
  CollectionConfig,
  AddCollectionResult,
  NormalizeCollectionsResult,
} from "../config.js";
