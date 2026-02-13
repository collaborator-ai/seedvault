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
      is_admin BOOLEAN NOT NULL DEFAULT FALSE,
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

    CREATE TABLE IF NOT EXISTS items (
      contributor TEXT NOT NULL,
      path TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL,
      modified_at TEXT NOT NULL,
      PRIMARY KEY (contributor, path),
      FOREIGN KEY (contributor) REFERENCES contributors(username)
    );
  `);

  // FTS5 virtual table (cannot use IF NOT EXISTS, so check first)
  const hasFts = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='items_fts'"
    )
    .get();
  if (!hasFts) {
    db.exec(`
      CREATE VIRTUAL TABLE items_fts USING fts5(
        path, content, content=items, content_rowid=rowid
      );

      CREATE TRIGGER items_ai AFTER INSERT ON items BEGIN
        INSERT INTO items_fts(rowid, path, content)
        VALUES (new.rowid, new.path, new.content);
      END;

      CREATE TRIGGER items_ad AFTER DELETE ON items BEGIN
        INSERT INTO items_fts(items_fts, rowid, path, content)
        VALUES ('delete', old.rowid, old.path, old.content);
      END;

      CREATE TRIGGER items_au AFTER UPDATE ON items BEGIN
        INSERT INTO items_fts(items_fts, rowid, path, content)
        VALUES ('delete', old.rowid, old.path, old.content);
        INSERT INTO items_fts(rowid, path, content)
        VALUES (new.rowid, new.path, new.content);
      END;
    `);
  }

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
  if (
    !/^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(username) &&
    !/^[a-z0-9]$/.test(username)
  ) {
    return "Username must be lowercase alphanumeric with hyphens, starting and ending with alphanumeric";
  }
  return null;
}

// --- Path validation ---

export function validatePath(filePath: string): string | null {
  if (!filePath || filePath.length === 0) {
    return "Path cannot be empty";
  }
  if (filePath.startsWith("/")) {
    return "Path cannot start with /";
  }
  if (filePath.includes("\\")) {
    return "Path cannot contain backslashes";
  }
  if (filePath.includes("//")) {
    return "Path cannot contain double slashes";
  }
  if (!filePath.endsWith(".md")) {
    return "Path must end in .md";
  }
  const segments = filePath.split("/");
  for (const seg of segments) {
    if (seg === "." || seg === "..") {
      return "Path cannot contain . or .. segments";
    }
    if (seg.length === 0) {
      return "Path cannot contain empty segments";
    }
  }
  return null;
}

// --- Contributors ---

export interface Contributor {
  username: string;
  is_admin: boolean;
  created_at: string;
}

export function createContributor(
  username: string,
  isAdmin: boolean
): Contributor {
  const now = new Date().toISOString();
  getDb()
    .prepare(
      "INSERT INTO contributors (username, is_admin, created_at) VALUES (?, ?, ?)"
    )
    .run(username, isAdmin ? 1 : 0, now);
  return { username, is_admin: isAdmin, created_at: now };
}

export function getContributor(username: string): Contributor | null {
  const row = getDb()
    .prepare(
      "SELECT username, is_admin, created_at FROM contributors WHERE username = ?"
    )
    .get(username) as Contributor | null;
  if (row) row.is_admin = Boolean(row.is_admin);
  return row;
}

export function listContributors(): Contributor[] {
  const rows = getDb()
    .prepare(
      "SELECT username, is_admin, created_at FROM contributors ORDER BY created_at ASC"
    )
    .all() as Contributor[];
  return rows.map((r) => ({ ...r, is_admin: Boolean(r.is_admin) }));
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

export function createApiKey(
  keyHash: string,
  label: string,
  contributor: string
): ApiKey {
  const id = `key_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const now = new Date().toISOString();
  getDb()
    .prepare(
      "INSERT INTO api_keys (id, key_hash, label, contributor, created_at) VALUES (?, ?, ?, ?, ?)"
    )
    .run(id, keyHash, label, contributor, now);
  return {
    id,
    key_hash: keyHash,
    label,
    contributor,
    created_at: now,
    last_used_at: null,
  };
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
  return {
    id,
    created_by: createdBy,
    created_at: now,
    used_at: null,
    used_by: null,
  };
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

// --- Items ---

export interface Item {
  contributor: string;
  path: string;
  content: string;
  created_at: string;
  modified_at: string;
}

export interface ItemEntry {
  path: string;
  size: number;
  created_at: string;
  modified_at: string;
}

export interface SearchResult {
  contributor: string;
  path: string;
  snippet: string;
  rank: number;
}

/**
 * Resolve origin ctime with fallback chain:
 * valid ctime → mtime → now.
 * A ctime is invalid if missing or epoch (birthtimeMs=0 on Linux/Docker).
 */
export function validateOriginCtime(
  originCtime: string | undefined,
  originMtime: string | undefined
): string {
  if (originCtime) {
    const ms = new Date(originCtime).getTime();
    // Treat epoch (0) or invalid dates as missing
    if (ms > 0 && !isNaN(ms)) return originCtime;
  }
  if (originMtime) {
    const ms = new Date(originMtime).getTime();
    if (ms > 0 && !isNaN(ms)) return originMtime;
  }
  return new Date().toISOString();
}

const MAX_CONTENT_SIZE = 10 * 1024 * 1024; // 10 MB

export function upsertItem(
  contributor: string,
  path: string,
  content: string,
  originCtime?: string,
  originMtime?: string
): Item {
  if (Buffer.byteLength(content) > MAX_CONTENT_SIZE) {
    throw new ItemTooLargeError(Buffer.byteLength(content));
  }

  const now = new Date().toISOString();
  const createdAt = validateOriginCtime(originCtime, originMtime);
  const modifiedAt = originMtime || now;

  getDb()
    .prepare(
      `INSERT INTO items (contributor, path, content, created_at, modified_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (contributor, path) DO UPDATE SET
         content = excluded.content,
         modified_at = excluded.modified_at`
    )
    .run(contributor, path, content, createdAt, modifiedAt);

  return getItem(contributor, path)!;
}

export function getItem(contributor: string, path: string): Item | null {
  return getDb()
    .prepare(
      "SELECT contributor, path, content, created_at, modified_at FROM items WHERE contributor = ? AND path = ?"
    )
    .get(contributor, path) as Item | null;
}

export function listItems(
  contributor: string,
  prefix?: string
): ItemEntry[] {
  let rows: Array<{
    path: string;
    size: number;
    created_at: string;
    modified_at: string;
  }>;
  if (prefix) {
    rows = getDb()
      .prepare(
        `SELECT path, length(content) as size, created_at, modified_at
         FROM items WHERE contributor = ? AND path LIKE ?
         ORDER BY modified_at DESC`
      )
      .all(contributor, prefix + "%") as typeof rows;
  } else {
    rows = getDb()
      .prepare(
        `SELECT path, length(content) as size, created_at, modified_at
         FROM items WHERE contributor = ?
         ORDER BY modified_at DESC`
      )
      .all(contributor) as typeof rows;
  }
  return rows;
}

export function deleteItem(contributor: string, path: string): boolean {
  const result = getDb()
    .prepare("DELETE FROM items WHERE contributor = ? AND path = ?")
    .run(contributor, path);
  return result.changes > 0;
}

export function searchItems(
  query: string,
  contributor?: string,
  limit = 10
): SearchResult[] {
  if (contributor) {
    return getDb()
      .prepare(
        `SELECT i.contributor, i.path,
                snippet(items_fts, 1, '<b>', '</b>', '...', 32) as snippet,
                rank
         FROM items_fts
         JOIN items i ON items_fts.rowid = i.rowid
         WHERE items_fts MATCH ?
           AND i.contributor = ?
         ORDER BY rank
         LIMIT ?`
      )
      .all(query, contributor, limit) as SearchResult[];
  }
  return getDb()
    .prepare(
      `SELECT i.contributor, i.path,
              snippet(items_fts, 1, '<b>', '</b>', '...', 32) as snippet,
              rank
       FROM items_fts
       JOIN items i ON items_fts.rowid = i.rowid
       WHERE items_fts MATCH ?
       ORDER BY rank
       LIMIT ?`
    )
    .all(query, limit) as SearchResult[];
}

// --- Custom errors ---

export class ItemTooLargeError extends Error {
  public size: number;
  constructor(size: number) {
    super(`Content too large: ${size} bytes (max ${MAX_CONTENT_SIZE})`);
    this.name = "ItemTooLargeError";
    this.size = size;
  }
}
