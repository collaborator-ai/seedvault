import { Database } from "bun:sqlite";
import { randomUUID } from "crypto";

let db: Database;

export function getDb(): Database {
  if (!db) throw new Error("Database not initialized. Call initDb() first.");
  return db;
}

export function initDb(dbPath: string): Database {
  db = new Database(dbPath, { create: true });
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");

  db.exec(`
    CREATE TABLE IF NOT EXISTS contributors (
      username TEXT PRIMARY KEY,
      is_operator BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS api_keys (
      id TEXT PRIMARY KEY,
      key_hash TEXT UNIQUE NOT NULL,
      label TEXT NOT NULL,
      contributor TEXT NOT NULL REFERENCES contributors(username),
      created_at TEXT NOT NULL,
      last_used_at TEXT
    );

    CREATE TABLE IF NOT EXISTS invites (
      id TEXT PRIMARY KEY,
      created_by TEXT NOT NULL REFERENCES contributors(username),
      created_at TEXT NOT NULL,
      used_at TEXT,
      used_by TEXT REFERENCES contributors(username)
    );
  `);

  return db;
}

// --- Username validation ---

export function validateUsername(username: string): string | null {
  if (!username || username.length === 0) {
    return "Username is required";
  }
  if (username.length > 63) {
    return "Username must be 63 characters or fewer";
  }
  if (!/^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(username) && !/^[a-z0-9]$/.test(username)) {
    return "Username must be lowercase alphanumeric with hyphens, starting and ending with alphanumeric";
  }
  return null;
}

// --- Contributors ---

export interface Contributor {
  username: string;
  is_operator: boolean;
  created_at: string;
}

export function createContributor(username: string, isOperator: boolean): Contributor {
  const now = new Date().toISOString();
  getDb()
    .prepare(
      "INSERT INTO contributors (username, is_operator, created_at) VALUES (?, ?, ?)"
    )
    .run(username, isOperator ? 1 : 0, now);
  return { username, is_operator: isOperator, created_at: now };
}

export function getContributor(username: string): Contributor | null {
  const row = getDb()
    .prepare("SELECT username, is_operator, created_at FROM contributors WHERE username = ?")
    .get(username) as Contributor | null;
  if (row) row.is_operator = Boolean(row.is_operator);
  return row;
}

export function listContributors(): Contributor[] {
  const rows = getDb()
    .prepare("SELECT username, is_operator, created_at FROM contributors ORDER BY created_at ASC")
    .all() as Contributor[];
  return rows.map((r) => ({ ...r, is_operator: Boolean(r.is_operator) }));
}

export function hasAnyContributor(): boolean {
  const row = getDb()
    .prepare("SELECT COUNT(*) as count FROM contributors")
    .get() as { count: number };
  return row.count > 0;
}

// --- API Keys ---

export interface ApiKey {
  id: string;
  key_hash: string;
  label: string;
  contributor: string;
  created_at: string;
  last_used_at: string | null;
}

export function createApiKey(keyHash: string, label: string, contributor: string): ApiKey {
  const id = `key_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const now = new Date().toISOString();
  getDb()
    .prepare(
      "INSERT INTO api_keys (id, key_hash, label, contributor, created_at) VALUES (?, ?, ?, ?, ?)"
    )
    .run(id, keyHash, label, contributor, now);
  return { id, key_hash: keyHash, label, contributor, created_at: now, last_used_at: null };
}

export function getApiKeyByHash(keyHash: string): ApiKey | null {
  return getDb()
    .prepare("SELECT * FROM api_keys WHERE key_hash = ?")
    .get(keyHash) as ApiKey | null;
}

export function touchApiKey(id: string): void {
  getDb()
    .prepare("UPDATE api_keys SET last_used_at = ? WHERE id = ?")
    .run(new Date().toISOString(), id);
}

// --- Invites ---

export interface Invite {
  id: string;
  created_by: string;
  created_at: string;
  used_at: string | null;
  used_by: string | null;
}

export function createInvite(createdBy: string): Invite {
  const id = randomUUID().replace(/-/g, "").slice(0, 12);
  const now = new Date().toISOString();
  getDb()
    .prepare(
      "INSERT INTO invites (id, created_by, created_at) VALUES (?, ?, ?)"
    )
    .run(id, createdBy, now);
  return { id, created_by: createdBy, created_at: now, used_at: null, used_by: null };
}

export function getInvite(id: string): Invite | null {
  return getDb()
    .prepare("SELECT * FROM invites WHERE id = ?")
    .get(id) as Invite | null;
}

export function markInviteUsed(id: string, usedBy: string): void {
  getDb()
    .prepare("UPDATE invites SET used_at = ?, used_by = ? WHERE id = ?")
    .run(new Date().toISOString(), usedBy, id);
}
