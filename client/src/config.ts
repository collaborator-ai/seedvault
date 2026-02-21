import { join, resolve, relative, isAbsolute } from "path";
import { homedir } from "os";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";

// --- Types ---

export interface CollectionConfig {
  path: string;
  name: string;
}

export interface Config {
  server: string;
  token: string;
  username: string;
  collections: CollectionConfig[];
}

export interface AddCollectionResult {
  config: Config;
  removedChildCollections: CollectionConfig[];
}

export interface NormalizeCollectionsResult {
  config: Config;
  removedOverlappingCollections: CollectionConfig[];
}

// --- Paths ---

const CONFIG_DIR = join(homedir(), ".config", "seedvault");
const CONFIG_PATH = join(CONFIG_DIR, "config.json");
const PID_PATH = join(CONFIG_DIR, "daemon.pid");
const DAEMON_LOG_PATH = join(CONFIG_DIR, "daemon.log");
const LAUNCHD_PLIST_PATH = join(homedir(), "Library", "LaunchAgents", "ai.seedvault.daemon.plist");
const SYSTEMD_UNIT_PATH = join(homedir(), ".config", "systemd", "user", "seedvault.service");
const SCHTASKS_XML_PATH = join(CONFIG_DIR, "seedvault-task.xml");

export function getConfigDir(): string {
  return CONFIG_DIR;
}

export function getConfigPath(): string {
  return CONFIG_PATH;
}

export function getPidPath(): string {
  return PID_PATH;
}

export function getDaemonLogPath(): string {
  return DAEMON_LOG_PATH;
}

export function getLaunchdPlistPath(): string {
  return LAUNCHD_PLIST_PATH;
}

export function getSystemdUnitPath(): string {
  return SYSTEMD_UNIT_PATH;
}

export function getSchtasksXmlPath(): string {
  return SCHTASKS_XML_PATH;
}

// --- Config CRUD ---

export function ensureConfigDir(): void {
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true });
  }
}

export function configExists(): boolean {
  return existsSync(CONFIG_PATH);
}

export function loadConfig(): Config {
  if (!existsSync(CONFIG_PATH)) {
    throw new Error(
      `No config found. Run 'sv init' first.\n  Expected: ${CONFIG_PATH}`
    );
  }
  const raw = readFileSync(CONFIG_PATH, "utf-8");
  return JSON.parse(raw) as Config;
}

export function saveConfig(config: Config): void {
  ensureConfigDir();
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n");
}

// --- Collection management ---

function isChildPath(parentPath: string, maybeChildPath: string): boolean {
  const rel = relative(parentPath, maybeChildPath);
  if (rel === "" || rel === ".") return false;
  return !rel.startsWith("..") && !isAbsolute(rel);
}

function pruneOverlappingCollections(collections: CollectionConfig[]): {
  collections: CollectionConfig[];
  removedOverlappingCollections: CollectionConfig[];
} {
  const removedOverlappingCollections: CollectionConfig[] = [];

  // Keep the first occurrence of an identical path.
  const seenPaths = new Set<string>();
  const deduped: CollectionConfig[] = [];
  for (const collection of collections) {
    if (seenPaths.has(collection.path)) {
      removedOverlappingCollections.push(collection);
      continue;
    }
    seenPaths.add(collection.path);
    deduped.push(collection);
  }

  const kept: CollectionConfig[] = [];
  for (const candidate of deduped) {
    const hasParent = deduped.some(
      (other) => other.path !== candidate.path && isChildPath(other.path, candidate.path)
    );
    if (hasParent) {
      removedOverlappingCollections.push(candidate);
    } else {
      kept.push(candidate);
    }
  }

  return { collections: kept, removedOverlappingCollections };
}

export function normalizeConfigCollections(config: Config): NormalizeCollectionsResult {
  const { collections, removedOverlappingCollections } = pruneOverlappingCollections(config.collections);
  if (removedOverlappingCollections.length === 0) {
    return { config, removedOverlappingCollections: [] };
  }
  return {
    config: {
      ...config,
      collections,
    },
    removedOverlappingCollections,
  };
}

export function addCollection(config: Config, collectionPath: string, name: string): AddCollectionResult {
  // Resolve to absolute path
  const resolved = collectionPath.startsWith("~/")
    ? resolve(homedir(), collectionPath.slice(2))
    : resolve(collectionPath);

  // Check for duplicate path
  if (config.collections.some((f) => f.path === resolved)) {
    throw new Error(`Collection path '${resolved}' is already configured.`);
  }

  // Reject adding a nested child under an existing parent collection.
  const parentConflict = config.collections.find((f) => isChildPath(f.path, resolved));
  if (parentConflict) {
    throw new Error(
      `Cannot add '${resolved}' because it is inside existing collection '${parentConflict.name}' (${parentConflict.path}).`
    );
  }

  // If adding a parent path, remove existing child collections first.
  const removedChildCollections = config.collections.filter((f) => isChildPath(resolved, f.path));
  const retainedCollections = config.collections.filter((f) => !isChildPath(resolved, f.path));

  // Check for duplicate name against retained (non-overlapping) collections.
  if (retainedCollections.some((f) => f.name === name)) {
    throw new Error(`A collection named '${name}' already exists. Use --name to pick a different name.`);
  }

  return {
    config: {
      ...config,
      collections: [...retainedCollections, { path: resolved, name }],
    },
    removedChildCollections,
  };
}

export function removeCollection(config: Config, name: string): Config {
  const filtered = config.collections.filter((f) => f.name !== name);
  if (filtered.length === config.collections.length) {
    throw new Error(`No collection named '${name}' found.`);
  }
  return { ...config, collections: filtered };
}

/** Derive a name from a collection path (its basename) */
export function defaultCollectionName(collectionPath: string): string {
  const abs = collectionPath.startsWith("~/")
    ? join(homedir(), collectionPath.slice(2))
    : collectionPath;
  const base = abs.split("/").filter(Boolean).pop();
  if (!base) throw new Error(`Cannot derive name from path: ${collectionPath}`);
  return base;
}
