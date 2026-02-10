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
    CREATE TABLE IF NOT EXISTS banks (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      is_operator BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS api_keys (
      id TEXT PRIMARY KEY,
      key_hash TEXT UNIQUE NOT NULL,
      label TEXT NOT NULL,
      bank_id TEXT NOT NULL REFERENCES banks(id),
      created_at TEXT NOT NULL,
      last_used_at TEXT
    );

    CREATE TABLE IF NOT EXISTS invites (
      id TEXT PRIMARY KEY,
      created_by TEXT NOT NULL REFERENCES banks(id),
      created_at TEXT NOT NULL,
      used_at TEXT,
      used_by TEXT REFERENCES banks(id)
    );
  `);

  return db;
}

// --- Banks ---

export interface Bank {
  id: string;
  name: string;
  is_operator: boolean;
  created_at: string;
}

export function createBank(name: string, isOperator: boolean): Bank {
  const id = `bank_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const now = new Date().toISOString();
  getDb()
    .prepare(
      "INSERT INTO banks (id, name, is_operator, created_at) VALUES (?, ?, ?, ?)"
    )
    .run(id, name, isOperator ? 1 : 0, now);
  return { id, name, is_operator: isOperator, created_at: now };
}

export function getBankById(id: string): Bank | null {
  const row = getDb()
    .prepare("SELECT id, name, is_operator, created_at FROM banks WHERE id = ?")
    .get(id) as Bank | null;
  if (row) row.is_operator = Boolean(row.is_operator);
  return row;
}

export function getBankByName(name: string): Bank | null {
  const row = getDb()
    .prepare(
      "SELECT id, name, is_operator, created_at FROM banks WHERE name = ?"
    )
    .get(name) as Bank | null;
  if (row) row.is_operator = Boolean(row.is_operator);
  return row;
}

export function listBanks(): Bank[] {
  const rows = getDb()
    .prepare("SELECT id, name, is_operator, created_at FROM banks ORDER BY created_at ASC")
    .all() as Bank[];
  return rows.map((r) => ({ ...r, is_operator: Boolean(r.is_operator) }));
}

export function hasAnyBank(): boolean {
  const row = getDb()
    .prepare("SELECT COUNT(*) as count FROM banks")
    .get() as { count: number };
  return row.count > 0;
}

// --- API Keys ---

export interface ApiKey {
  id: string;
  key_hash: string;
  label: string;
  bank_id: string;
  created_at: string;
  last_used_at: string | null;
}

export function createApiKey(keyHash: string, label: string, bankId: string): ApiKey {
  const id = `key_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const now = new Date().toISOString();
  getDb()
    .prepare(
      "INSERT INTO api_keys (id, key_hash, label, bank_id, created_at) VALUES (?, ?, ?, ?, ?)"
    )
    .run(id, keyHash, label, bankId, now);
  return { id, key_hash: keyHash, label, bank_id: bankId, created_at: now, last_used_at: null };
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
