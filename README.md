# Seedvault – Design Doc

## Product Context
**Collaborator** is a full-stack agent product — a fork of OpenClaw plus a set of open-source libraries. Seedvault is one of these libraries.

## What Is It
Seedvault is a **pooled markdown sync service**. It keeps markdown files from multiple contributors in sync with a central server, and provides real-time read access to authorized consumers.

## Core Principles
- **Bank sovereignty:** Each bank has one owner. Only the owner's daemon can write. Everyone else gets read-only access.
- **Folder-level sync:** Contributors add folders to watch. Everything in them syncs. No per-file permissions.
- **Plain files on disk:** Server stores markdown as-is on the filesystem. Enables direct indexing by [QMD](https://github.com/tobi/qmd) for hybrid search (BM25 + semantic + LLM re-ranking).
- **Open source, self-hostable.** Collaborator runs hosted instances for its users.

---

## Data Model

### Hierarchy

```
Vault (= the server instance)
  └── Bank (= per contributor, one owner)
        └── Collection (= one watched folder, identified by label)
              └── Files (identified by path within collection)
```

- **Vault:** A single Seedvault deployment. One server, one storage root, one set of API endpoints. Auth metadata lives in SQLite; file content lives on the filesystem.
- **Bank:** A contributor's namespace within the vault. Each bank has one owner and one write token. Banks are the unit of write isolation — no shared banks. Each bank maps to a directory on disk.
- **Collection:** A watched folder that the daemon syncs to the server. Each collection has a **label** (e.g., `notes`, `work-docs`) that becomes its path prefix within the bank. The label defaults to the folder's basename. Collections are not a server-side entity — they're a daemon concept that manifests as top-level subdirectories within a bank.
- **Files:** Stored within a collection, identified by a relative path (e.g., `notes/seedvault.md`, where `notes` is the collection label). On the server, paths are flat — there's no collection-level API, just file paths that happen to be prefixed by the collection label.

---

## Architecture

### Components

**1. Daemon (client-side)**
- Long-running process installed on any machine with markdown to share
- Watches configured folders via filesystem watcher (chokidar)
- On file change: PUTs updated content to server
- On file delete: sends DELETE to server
- Authenticates with a token that has `write` role scoped to its bank

**2. Server (central)**
- Receives file updates from daemons, writes them as plain files on disk
- Mirrors bank/path structure: `<storage_root>/<bank_id>/<path>`
- Serves files to authorized consumers via HTTP
- Pushes change events to connected consumers via SSE
- Auth and bank metadata in SQLite; file content on the filesystem

**3. QMD (search/retrieval)**
- [QMD](https://github.com/tobi/qmd) runs alongside the server, indexing the file tree
- Each bank is registered as a QMD collection
- Provides hybrid search: BM25 full-text + vector semantic + LLM re-ranking
- Seedvault's search endpoint delegates to QMD — Seedvault does not own search

**4. Consumer (read-side)**
- Any authorized client: Collaborator/OpenClaw instance, another service, etc.
- Connects to SSE stream for real-time change notifications
- Reads files and queries search via HTTP
- Authenticates with a token that has `read` role (vault-wide access)

### Data Flow

```
[Machine A]              [Server]              [Collaborator]
  Daemon  ---PUT/DELETE--->  Write files        
                             to disk       
                               |           
                             QMD indexes    
                             file tree     
                               |           
                          <---SSE stream---  Consumer
                          ---GET/search--->
```

---

## Auth Model

Single token type (`sv_...`), always scoped to a bank. Every token can write to its own bank and read all banks. Tokens are bearer tokens passed via `Authorization: Bearer <token>` header.

### Permissions

Every token has the same permissions:
- **Write** files to its own bank
- **Read** files from any bank
- **List** banks, search, subscribe to SSE events

The first bank created (via signup without invite) is the **operator**. The operator can generate invite codes for others.

### Token storage

Tokens are SHA-256 hashed before storage. The raw token is returned **once** at creation and never stored.

```sql
api_keys (id, key_hash, label, bank_id, created_at, last_used_at)
```

Every token has a `bank_id` — there are no unscoped tokens.

### Auth check logic

```
POST .../signup                      → no auth (requires invite code, except first user)
POST .../invites                     → operator only
PUT/DELETE .../banks/:bankId/files/* → bank_id matches
GET .../banks/:bankId/files/*       → any valid token
GET .../banks/:bankId/files         → any valid token
GET .../banks                       → any valid token
GET .../events                      → any valid token
GET .../search                      → any valid token
GET /health                         → no auth
```

---

## API Specification

Base URL: `/v1`

### Signup & Invites

#### `POST /v1/signup`
Create a new bank and get a token. The first signup requires no invite. All subsequent signups require an invite code.

**Request body:**
```json
{
  "name": "yiliu-notes",
  "invite": "abc123"
}
```

First user omits `invite`:
```json
{
  "name": "yiliu-notes"
}
```

**Response: `201 Created`**
```json
{
  "bank": {
    "id": "bank_abc123",
    "name": "yiliu-notes",
    "createdAt": "2026-02-10T22:00:00Z"
  },
  "token": "sv_..."
}
```

The bank's directory is created on disk at `<storage_root>/bank_abc123/`, and registered as a QMD collection. The token is returned **once**.

---

#### `POST /v1/invites`
Generate an invite code. Requires operator token (the first user).

**Response: `201 Created`**
```json
{
  "invite": "abc123",
  "createdAt": "2026-02-10T22:00:00Z"
}
```

---

#### `GET /v1/banks`
List all banks in the vault. Requires any valid token.

**Response: `200 OK`**
```json
{
  "banks": [
    {"id": "bank_abc123", "name": "yiliu-notes", "createdAt": "2026-02-10T22:00:00Z"},
    {"id": "bank_def456", "name": "collin-workspace", "createdAt": "2026-02-10T22:30:00Z"}
  ]
}
```

---

#### `GET /health`
Health check. No auth required.

**Response: `200 OK`**
```json
{
  "status": "ok"
}
```

---

### Write (Daemon → Server)

Requires a token scoped to the target bank.

#### `PUT /v1/banks/:bankId/files/*path`
Create or update a file. Path must end in `.md`. The server writes the content to disk at `<storage_root>/<bankId>/<path>`, creating intermediate directories as needed. Uses atomic write (temp file + rename) to prevent partial writes. Max file size: **10 MB**. Concurrent writes to the same bank use last-write-wins.

**Request body:** Raw markdown content.
**Headers:** `Content-Type: text/markdown`

**Response: `200 OK`**
```json
{
  "path": "notes/seedvault.md",
  "size": 2048,
  "modifiedAt": "2026-02-10T22:05:00Z"
}
```

---

#### `DELETE /v1/banks/:bankId/files/*path`
Delete a file from disk. Removes empty parent directories.

**Response: `204 No Content`**

---

### Read (Consumer → Server)

Requires any valid token.

#### `GET /v1/banks/:bankId/files`
List files in a bank. Walks the bank's directory on disk and returns a flat list.

**Query params:**
- `prefix` (optional) — filter to files whose path starts with this prefix

**Response: `200 OK`**
```json
{
  "files": [
    {"path": "notes/seedvault.md", "size": 2048, "modifiedAt": "2026-02-10T22:05:00Z"},
    {"path": "notes/collaborator.md", "size": 1024, "modifiedAt": "2026-02-10T21:00:00Z"}
  ]
}
```

---

#### `GET /v1/banks/:bankId/files/*path`
Read a single file from disk.

**Response: `200 OK`**
**Body:** Raw markdown content.
**Headers:** `Content-Type: text/markdown`

---

#### `GET /v1/search?q=<query>`
Search across all banks in the vault. Delegates to QMD, which indexes the server's file tree.

**Query params:**
- `q` (required) — search query
- `bank` (optional) — limit to a specific bank (maps to QMD collection)
- `limit` (optional, default 10) — max results

**Response: `200 OK`**
```json
{
  "results": [
    {
      "bank": "bank_abc123",
      "path": "notes/seedvault.md",
      "snippet": "Seedvault is a pooled markdown server...",
      "score": 0.92
    }
  ]
}
```

---

### SSE (Server → Consumer)

#### `GET /v1/events`
Opens a Server-Sent Events stream. Requires any valid token. Streams events for all banks.

**Event types:**

```
event: file_updated
data: {"bank":"bank_abc123","path":"notes/seedvault.md","size":2048,"modifiedAt":"2026-02-10T22:05:00Z"}

event: file_deleted
data: {"bank":"bank_abc123","path":"notes/old-idea.md"}
```

Consumer uses these events to trigger local reindexing, cache invalidation, etc.

---

## Storage

### Filesystem (content)

Files are stored as plain markdown on the server's filesystem, mirroring bank and path structure:

```
<storage_root>/
  bank_abc123/           # yiliu's bank
    notes/               # from ~/notes
      seedvault.md
      collaborator.md
    work-docs/           # from ~/work/docs
      api/
        design.md
  bank_def456/           # collin's bank
    memory/              # from ~/memory
      2026-02-10.md
    journal/             # from ~/journal
      MEMORY.md
```

- One directory per bank under the storage root
- Within each bank, each watched folder maps to a labeled subdirectory
- Intermediate directories are created on write and cleaned up on delete
- Atomic writes via temp file + rename

### SQLite (auth & metadata)

A single SQLite database stores bank records and API keys. No file content in the database.

```sql
CREATE TABLE banks (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  is_operator BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TEXT NOT NULL
);

CREATE TABLE api_keys (
  id TEXT PRIMARY KEY,
  key_hash TEXT UNIQUE NOT NULL,
  label TEXT NOT NULL,
  bank_id TEXT NOT NULL REFERENCES banks(id),
  created_at TEXT NOT NULL,
  last_used_at TEXT
);

CREATE TABLE invites (
  id TEXT PRIMARY KEY,
  created_by TEXT NOT NULL REFERENCES banks(id),
  created_at TEXT NOT NULL,
  used_at TEXT,
  used_by TEXT REFERENCES banks(id)
);
```

### QMD (search & retrieval)

[QMD](https://github.com/tobi/qmd) runs alongside the server and indexes the file tree directly. Each bank is a QMD collection:

```bash
qmd collection add <storage_root>/bank_abc123 --name yiliu-notes
qmd collection add <storage_root>/bank_def456 --name collin-workspace
```

QMD provides:
- **BM25 keyword search** via FTS5
- **Semantic vector search** via local embeddings
- **Hybrid search with LLM re-ranking** (query expansion + RRF fusion + re-ranking)

The server triggers `qmd update` after file writes to keep the index current, or QMD can run on a schedule. The search API endpoint proxies to QMD via its CLI or MCP server.

### Path rules

Paths are relative to the bank root. Always forward slashes, never a leading slash.

**Valid paths:**
- `notes/seedvault.md`
- `notes/sub/deep/file.md`
- `MEMORY.md` (root-level file)

**Invalid paths (rejected by server):**
- `/notes/seedvault.md` (leading slash)
- `notes/../etc/passwd` (traversal)
- `notes//seedvault.md` (double slash)
- `` (empty)

The server validates all paths on write **before** touching the filesystem. This is a security boundary — paths map directly to disk.

---

## Daemon Behavior

1. **On startup:** full sync — scan configured folders, PUT any files not yet on server (compare via file listing + mtime)
2. **After startup:** filesystem watcher — PUT on create/modify, DELETE on delete
3. **Reconnect logic:** if server is unreachable, queue changes and retry with backoff
4. **Config:** server URL, token, list of folders to watch

### Configuration

The daemon watches one or more local directories. Each folder has a **label** that becomes its path prefix on the server, preventing collisions between directories.

```json
{
  "server": "https://vault.example.com",
  "token": "sv_...",
  "folders": [
    {"path": "~/notes", "label": "notes"},
    {"path": "~/work/docs", "label": "work-docs"},
    {"path": "~/meetings", "label": "meetings"}
  ]
}
```

**Label defaults to the folder's basename.** When there's no ambiguity, the shorthand works:

```json
{
  "server": "https://vault.example.com",
  "token": "sv_...",
  "folders": ["~/notes", "~/meetings"]
}
```

This auto-labels them `notes` and `meetings`. Explicit labels are only needed when basenames collide (e.g., two directories both named `notes`).

### Path mapping

Each folder's label becomes the top-level prefix for its files on the server:

```
Folder config: {"path": "~/work/docs", "label": "work-docs"}
Local file:    ~/work/docs/api/design.md
Server path:   work-docs/api/design.md

Folder config: {"path": "~/notes"}  (auto-labeled "notes")
Local file:    ~/notes/seedvault.md
Server path:   notes/seedvault.md
```

This mirrors how [QMD](https://github.com/tobi/qmd) handles collections — each watched directory gets a unique label, and files within are identified by `(label, relative_path)`.

### File filtering

- Only syncs files matching `**/*.md`
- Ignores `.git`, `node_modules`, and other common non-content directories

---

## CLI (`sv`)

The `sv` command is the unified CLI for Seedvault — daemon management, folder configuration, and admin operations.

### Installation

```bash
curl -fsSL https://seedvault.ai/install.sh | bash
```

The installer:
1. Detects OS (macOS / Linux)
2. Installs Bun if not present
3. Installs `sv` globally via `bun install -g seedvault`
4. Runs `sv init` interactively if TTY is available

For agents and CI (non-interactive):
```bash
curl -fsSL https://seedvault.ai/install.sh | bash -s -- --no-onboard
sv init --server https://vault.example.com --token sv_...
```

### Commands

**Setup:**
```bash
sv init                          # Interactive first-time setup (server URL, signup/invite)
sv init --server URL --token T   # Non-interactive setup (already have a token)
sv init --server URL --name me --invite CODE  # Non-interactive signup
```

**Folder management:**
```bash
sv add ~/notes                          # Watch a folder (auto-label: "notes")
sv add ~/work/docs --label work-docs    # Watch with explicit label
sv remove notes                         # Stop watching a folder
sv folders                              # List configured folders
```

**Daemon:**
```bash
sv start                   # Start syncing (foreground)
sv start -d                # Start syncing (background daemon)
sv stop                    # Stop the daemon
sv status                  # Show sync status, connected folders, server info
```

**File operations (reads from server):**
```bash
sv ls                      # List all files in your bank
sv ls notes/               # List files under a prefix
sv cat notes/seedvault.md  # Read a file
```

**Vault info:**
```bash
sv banks                   # List all banks in the vault
sv invite                  # Generate an invite code (operator only)
```

### Configuration

Config lives at `~/.config/seedvault/config.json`:

```json
{
  "server": "https://vault.example.com",
  "token": "sv_...",
  "folders": [
    {"path": "/Users/yiliu/notes", "label": "notes"},
    {"path": "/Users/yiliu/work/docs", "label": "work-docs"}
  ]
}
```

---

## Repos & Distribution

### `seedvault` (monorepo)
```
server/     # Server — deploys to Fly.io or self-hosted
cli/        # sv CLI + daemon — published to npm
electron/   # Desktop app — bundles the daemon
```

### Install paths

| User | Install | Sync |
|------|---------|------|
| **Humans (CLI)** | `curl -fsSL https://seedvault.ai/install.sh \| bash` | `sv start` |
| **Humans (desktop)** | Seedvault app (Electron) | Bundled in app |
| **Humans (web)** | Web app | N/A (reads from service directly) |
| **Agents** (OpenClaw, Collaborator, etc.) | Install script, non-interactive | `sv start -d` |
| **Collaborator users** | Built into Collaborator | Built into Collaborator |

All paths talk to the same service API.

## Tech Stack

- **Server:** TypeScript, Hono, Bun, SQLite (via `bun:sqlite` — auth & metadata only)
- **Search:** QMD (indexes the file tree — BM25, vector, re-ranking)
- **CLI/Daemon:** TypeScript, Bun, chokidar (fs watcher)
- **Auth:** Bearer tokens, SHA-256 hashed in SQLite
- **Deployment:** Docker (runs anywhere), Fly.io for hosted instances

---

## Server Deployment

### Configuration

The server is configured entirely via environment variables:

| Env var | Default | Description |
|---------|---------|-------------|
| `PORT` | `3000` | Server listen port |
| `DATA_DIR` | `./data` | Root for all persistent data |

All persistent state lives under `DATA_DIR`:

```
$DATA_DIR/
  seedvault.db          # SQLite (banks, api_keys, invites)
  files/                # File storage root
    bank_abc123/
      notes/
        seedvault.md
    bank_def456/
      ...
```

One directory to mount, one directory to back up.

### Docker

The `Dockerfile` bundles the server, Bun runtime, and QMD. This is the universal deployment unit — runs on Fly.io, any VPS, AWS/GCP, bare metal.

```bash
# Build
docker build -t seedvault .

# Run (mount a volume for persistence)
docker run -p 3000:3000 -v seedvault-data:/data -e DATA_DIR=/data seedvault
```

### Fly.io

```bash
fly launch
fly volumes create seedvault_data --size 10
fly deploy
```

The `fly.toml` mounts the volume at `/data` and sets `DATA_DIR=/data`.

### QMD integration

QMD is installed in the Docker image alongside the server. On startup, the server:

1. Initializes QMD if no index exists
2. Registers each bank's directory as a QMD collection
3. After each file write/delete, triggers `qmd update` to re-index

The search API endpoint (`GET /v1/search`) invokes QMD via its CLI (`qmd search --json`). For better performance, the server can optionally run QMD's MCP HTTP server as a sidecar process and query it directly.

### First boot

On first start with an empty `DATA_DIR`, the server:

1. Creates `DATA_DIR/files/` directory
2. Creates `DATA_DIR/seedvault.db` with schema
3. Initializes QMD index
4. Waits for the first `POST /v1/signup` (no invite required — this becomes the operator)

---

## Error Handling

All error responses use a consistent format:

```json
{
  "error": "Human-readable error message"
}
```

### Status codes

| Code | Meaning |
|------|---------|
| `400` | Bad request — invalid path, missing required field, file too large, path doesn't end in `.md` |
| `401` | Unauthorized — missing or invalid token |
| `403` | Forbidden — token doesn't have permission (e.g., writing to another bank, non-operator generating invites) |
| `404` | Not found — bank or file doesn't exist |
| `409` | Conflict — bank name already taken (on signup) |
| `413` | Payload too large — file exceeds 10 MB |

---

## MVP Scope

**In:**
- Vault with multiple banks (one per contributor)
- Signup with invite system (first user is operator)
- `sv` CLI with daemon, folder management, and vault commands
- Curl-pipe-bash installer (`seedvault.ai/install.sh`)
- PUT/DELETE/GET/list endpoints (bank-scoped)
- SSE event stream
- Bank-scoped token auth (every token writes to its bank, reads all)
- Plain file storage on disk (10 MB max, last-write-wins)
- QMD integration for search
- Health check endpoint

**Out (post-MVP):**
- E2E encryption
- Multi-vault server (multiple vaults per deployment)
- Read-only tokens (consumers without a bank)
- Token revocation
- Bank deletion
- Web UI for vault management
- Version history / file diffing
- Bulk sync optimization (hashing, delta transfer)
- Session-based auth (login flow for web UI)

---

*Started 2026-02-10. Yiliu + Collin.*
