import { join, resolve } from "path";
import { homedir } from "os";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";

// --- Types ---

export interface FolderConfig {
  path: string;
  label: string;
}

export interface Config {
  server: string;
  token: string;
  bankId: string;
  folders: FolderConfig[];
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

// --- Folder management ---

export function addFolder(config: Config, folderPath: string, label: string): Config {
  // Resolve to absolute path
  const resolved = folderPath.startsWith("~")
    ? resolve(homedir(), folderPath.slice(2))  // skip ~/
    : resolve(folderPath);

  // Check for duplicate label
  if (config.folders.some((f) => f.label === label)) {
    throw new Error(`A folder with label '${label}' already exists. Use --label to pick a different name.`);
  }

  // Check for duplicate path
  if (config.folders.some((f) => f.path === resolved)) {
    throw new Error(`Folder '${resolved}' is already configured.`);
  }

  return {
    ...config,
    folders: [...config.folders, { path: resolved, label }],
  };
}

export function removeFolder(config: Config, label: string): Config {
  const filtered = config.folders.filter((f) => f.label !== label);
  if (filtered.length === config.folders.length) {
    throw new Error(`No folder with label '${label}' found.`);
  }
  return { ...config, folders: filtered };
}

/** Derive a label from a folder path (its basename) */
export function defaultLabel(folderPath: string): string {
  const abs = folderPath.startsWith("~")
    ? join(homedir(), folderPath.slice(1))
    : folderPath;
  const base = abs.split("/").filter(Boolean).pop();
  if (!base) throw new Error(`Cannot derive label from path: ${folderPath}`);
  return base;
}
