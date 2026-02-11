import { join, resolve } from "path";
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
  contributorId: string;
  collections: CollectionConfig[];
}

// --- Paths ---

const CONFIG_DIR = join(homedir(), ".config", "seedvault");
const CONFIG_PATH = join(CONFIG_DIR, "config.json");
const PID_PATH = join(CONFIG_DIR, "daemon.pid");

export function getConfigDir(): string {
  return CONFIG_DIR;
}

export function getConfigPath(): string {
  return CONFIG_PATH;
}

export function getPidPath(): string {
  return PID_PATH;
}

// --- Config CRUD ---

function ensureConfigDir(): void {
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

export function addCollection(config: Config, collectionPath: string, name: string): Config {
  // Resolve to absolute path
  const resolved = collectionPath.startsWith("~")
    ? resolve(homedir(), collectionPath.slice(2))  // skip ~/
    : resolve(collectionPath);

  // Check for duplicate name
  if (config.collections.some((f) => f.name === name)) {
    throw new Error(`A collection named '${name}' already exists. Use --name to pick a different name.`);
  }

  // Check for duplicate path
  if (config.collections.some((f) => f.path === resolved)) {
    throw new Error(`Collection path '${resolved}' is already configured.`);
  }

  return {
    ...config,
    collections: [...config.collections, { path: resolved, name }],
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
  const abs = collectionPath.startsWith("~")
    ? join(homedir(), collectionPath.slice(1))
    : collectionPath;
  const base = abs.split("/").filter(Boolean).pop();
  if (!base) throw new Error(`Cannot derive name from path: ${collectionPath}`);
  return base;
}
