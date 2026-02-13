# Seedvault – Design Doc

## Product Context
**Collaborator** is a full-stack agent product — a fork of OpenClaw plus a set of open-source libraries. Seedvault is one of these libraries.

## What Is It
Seedvault is a **pooled markdown sync service**. It keeps markdown files from multiple contributors in sync with a central server, and provides real-time read access to authorized consumers.

## Core Principles
- **Contributor sovereignty:** Each contributor has one owner. Only the owner's daemon can write. Everyone else gets read-only access.
- **Collection-level sync:** Contributors add collections (local folders) to sync. Everything in them syncs. No per-file permissions.
- **SQLite as source of truth:** All content and metadata lives in a single SQLite database. No filesystem mirroring, no external indexers. Full-text search via FTS5.
- **Structured read API:** Dedicated endpoints for reading, listing, and searching files. No shell passthrough — the API is the interface.
- **Open source, self-hostable.** Collaborator runs hosted instances for its users.

---

## Data Model

### Hierarchy

```
Vault (= the server instance)
  └── Contributor (= one ownership boundary)
        └── Collection (= one synced local folder + in-vault collection name)
              └── Files (identified by path within collection)
```

- **Vault:** A single Seedvault deployment. One server, one database, one set of API endpoints. All data — content, auth, metadata — lives in SQLite.
- **Contributor:** A username-identified namespace within the vault. Each contributor has one owner and one or more contributor-scoped tokens. Contributors are the unit of write isolation — no shared contributors.
- **Collection:** A synced local folder within a contributor. Each collection has a local `path` and an in-vault `name` (e.g., `notes`, `work-docs`) that becomes its path prefix within the contributor. `name` defaults to the folder's basename and can be overridden to avoid collisions.
- **Files:** Stored within a collection, identified by relative path (e.g., `notes/seedvault.md`, where `notes` is the collection name). On the server, paths are flat — there's no collection-level API, just file paths prefixed by collection name.

---

## Architecture

### Components

**1. Daemon (client-side)**
- Long-running process installed on any machine with markdown to share
- Watches configured collections (local folders) via filesystem watcher (chokidar)
- On file change: PUTs updated content to server
- On file delete: sends DELETE to server
- Authenticates with a token that has `write` role scoped to its contributor

**2. Server (central)**
- Receives file updates from daemons, stores content and metadata in SQLite
- Exposes structured read endpoints for file content, listing, and search
- Full-text search via SQLite FTS5 — no external indexer
- Pushes change events to connected consumers via SSE
- Bundles a lightweight web UI at `/` for browsing files and viewing content (requires a token)

**3. Consumer (read-side)**
- Any authorized client: AI agents, Collaborator/OpenClaw instance, another service, etc.
- Reads files via `GET /v1/files/:username/*`, lists via `GET /v1/files?prefix=`, searches via `GET /v1/search`
- Connects to SSE stream for real-time change notifications
- Authenticates with a token (vault-wide read access)

### Data Flow

```
[Machine A]              [Server]              [Agent / Consumer]
  Daemon  ---PUT/DELETE--->  Store in
                             SQLite
                               |
                             FTS5 index
                             auto-updated
                               |
                          <---SSE stream---  Consumer
                          ---GET /v1/...-->  (read, list, search)
```

---

## Auth Model

Single token type (`sv_...`), always scoped to a contributor. Every token can write to its own contributor and read all contributors. Tokens are bearer tokens passed via `Authorization: Bearer <token>` header. For SSE connections (where `EventSource` doesn't support custom headers), tokens can also be passed as a `?token=` query parameter.

### Permissions

Every token has the same permissions:
- **Write** files to its own contributor
- **Read** files from any contributor
- **List** contributors, search, subscribe to SSE events

The first contributor created (via signup without invite) is the **operator**. The operator can generate invite codes for others.

### Token storage

Tokens are SHA-256 hashed before storage. The raw token is returned **once** at creation and never stored.

```sql
api_keys (id, key_hash, label, contributor, created_at, last_used_at)
```

Every token has a `contributor` (username) — there are no unscoped tokens.

### Auth check logic

```
POST .../signup                → no auth (requires invite code, except first user)
GET  .../me                    → any valid token (returns token's username)
POST .../invites               → operator only
GET  .../contributors          → any valid token
PUT  .../files/*               → token's username must match path prefix
DELETE .../files/*             → token's username must match path prefix
GET  .../files?prefix=         → any valid token
GET  .../files/:username/*     → any valid token (read file content)
GET  .../search?q=             → any valid token
GET  .../events                → any valid token
GET  /health                   → no auth
```

---

## API Specification

Base URL: `/v1`

### Auth & Admin

#### `POST /v1/signup`
Create a new contributor and get a token. The first signup requires no invite. All subsequent signups require an invite code.

**Request body:**
```json
{
  "name": "yiliu",
  "invite": "abc123"
}
```

First user omits `invite`:
```json
{
  "name": "yiliu"
}
```

**Response: `201 Created`**
```json
{
  "contributor": {
    "username": "yiliu",
    "createdAt": "2026-02-10T22:00:00Z"
  },
  "token": "sv_..."
}
```

The contributor is created in the database. The token is returned **once**.

---

#### `GET /v1/me`
Resolve a token to its contributor. Requires any valid token. Used by the CLI during `sv init` to auto-detect the username from a token.

**Response: `200 OK`**
```json
{
  "username": "yiliu",
  "createdAt": "2026-02-10T22:00:00Z"
}
```

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

#### `GET /health`
Health check. No auth required.

**Response: `200 OK`**
```json
{
  "status": "ok"
}
```

---

#### `GET /v1/contributors`
List all contributors. Requires any valid token.

**Response: `200 OK`**
```json
{
  "contributors": [
    { "username": "yiliu", "createdAt": "2026-02-10T22:00:00Z" },
    { "username": "collin", "createdAt": "2026-02-10T23:00:00Z" }
  ]
}
```

---

### Write (Daemon → Server)

Requires a token scoped to the target contributor. The path's first segment must match the token's username.

#### `PUT /v1/files/*path`
Create or update a file. Full path includes the contributor username prefix (e.g., `yiliu/notes/seedvault.md`). Path must end in `.md`. Max file size: **10 MB**. Concurrent writes use last-write-wins.

The client sends the original file's timestamps via headers. The server preserves these as the canonical `createdAt` and `modifiedAt` — the server is a faithful store, not a timestamp authority. On update, only `modifiedAt` changes; `createdAt` is locked in from the first write.

**Request body:** Raw markdown content.
**Headers:**
- `Content-Type: text/markdown`
- `X-Origin-Ctime: <ISO 8601>` (optional — original file creation time from contributor's device)
- `X-Origin-Mtime: <ISO 8601>` (optional — original file modification time from contributor's device)

**Response: `200 OK`**
```json
{
  "path": "notes/seedvault.md",
  "size": 2048,
  "createdAt": "2026-02-10T22:05:00Z",
  "modifiedAt": "2026-02-10T22:05:00Z"
}
```

---

#### `DELETE /v1/files/*path`
Delete a file from disk. Path includes contributor prefix. Removes empty parent directories.

**Response: `204 No Content`**

---

#### `GET /v1/files?prefix=`
Structured file listing. Returns files under a contributor prefix as JSON. Used by the daemon for initial sync and collection management. Requires any valid token.

**Request:** Query parameter `prefix` is required (e.g., `yiliu/` or `yiliu/notes/`).

**Response: `200 OK`**
```json
{
  "files": [
    {
      "path": "yiliu/notes/seedvault.md",
      "size": 2048,
      "createdAt": "2026-02-10T22:05:00Z",
      "modifiedAt": "2026-02-10T22:05:00Z"
    }
  ]
}
```

---

### Read

Structured read endpoints. Requires any valid token.

#### `GET /v1/files/:username/*path`
Read a file's content. Returns the raw markdown content as plain text.

**Response: `200 OK`**
**Body:** File content as `text/markdown`.

**Response headers:**
- `X-Created-At`: File creation timestamp (ISO 8601)
- `X-Modified-At`: File modification timestamp (ISO 8601)
- `X-Size`: File size in bytes

**Examples:**

```
GET /v1/files/yiliu/notes/seedvault.md
GET /v1/files/collin/memory/2026-02-10.md
```

---

### SSE (Server → Consumer)

#### `GET /v1/events`
Opens a Server-Sent Events stream. Requires any valid token (via `?token=` query param, since EventSource doesn't support custom headers). Streams events for all contributors.

**Event types:**

```
event: connected
data: {}

event: file_updated
data: {"contributor":"yiliu","path":"notes/seedvault.md","size":2048,"createdAt":"2026-02-10T22:05:00Z","modifiedAt":"2026-02-10T22:05:00Z"}

event: file_deleted
data: {"contributor":"yiliu","path":"notes/old-idea.md"}
```

Consumer uses these events to trigger local reindexing, cache invalidation, etc.

---

### Search (FTS5)

#### `GET /v1/search?q=`
Full-text search powered by SQLite FTS5. Requires any valid token.

**Query parameters:**
- `q` (required): Search query
- `contributor` (optional): Restrict to a single contributor
- `limit` (optional): Max results (default 10)

**Response: `200 OK`**
```json
{
  "results": [
    {
      "path": "yiliu/notes/seedvault.md",
      "snippet": "...matching text with <b>highlights</b>...",
      "rank": -1.23
    }
  ]
}
```

---

## Storage

### SQLite (everything)

A single SQLite database stores all data — content, auth, and metadata. No filesystem storage.

```sql
CREATE TABLE contributors (
  username TEXT PRIMARY KEY,
  is_operator BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TEXT NOT NULL
);

CREATE TABLE api_keys (
  id TEXT PRIMARY KEY,
  key_hash TEXT UNIQUE NOT NULL,
  label TEXT NOT NULL,
  contributor TEXT NOT NULL REFERENCES contributors(username),
  created_at TEXT NOT NULL,
  last_used_at TEXT
);

CREATE TABLE invites (
  id TEXT PRIMARY KEY,
  created_by TEXT NOT NULL REFERENCES contributors(username),
  created_at TEXT NOT NULL,
  used_at TEXT,
  used_by TEXT REFERENCES contributors(username)
);

CREATE TABLE items (
  contributor TEXT NOT NULL,
  path TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL,
  modified_at TEXT NOT NULL,
  PRIMARY KEY (contributor, path),
  FOREIGN KEY (contributor) REFERENCES contributors(username)
);

-- FTS5 virtual table for full-text search
CREATE VIRTUAL TABLE items_fts USING fts5(
  path, content,
  content=items, content_rowid=rowid
);
```

- `created_at` and `modified_at` reflect the original file's timestamps from the contributor's device — not server receipt time
- On INSERT, both are set from the client-provided values
- On UPDATE (conflict), only `modified_at` changes; `created_at` is preserved
- If the client can't provide a valid creation time (e.g., Linux without birthtime support), the server falls back to the current time on first insert
- FTS5 index is maintained automatically via triggers on the `items` table

### Path rules

Paths are relative to the contributor root. Always forward slashes, never a leading slash.

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

1. **Startup reconciliation:** runs an initial sync over configured collections (upload newer/missing files, delete remote files that no longer exist locally).
2. **Can start with zero collections:** daemon runs idle and waits for collections to be added.
3. **Live config reload:** daemon polls config and applies collection add/remove changes without restart.
4. **Filesystem watcher:** PUT on create/modify, DELETE on delete for watched collections.
5. **Collection removal behavior:** when a collection is removed while daemon is running, the daemon stops watching it and deletes that collection prefix from the server.
6. **Retry queue:** network failures are queued in memory and retried with backoff. Queue is not persisted across daemon restarts; initial sync reconciles state on restart.

### Configuration

The daemon watches one or more local directories as collections. Each collection has:
- `path`: local folder path on disk
- `name`: in-vault collection name/prefix (defaults to local folder basename)

```json
{
  "server": "https://vault.example.com",
  "token": "sv_...",
  "username": "yiliu",
  "collections": [
    {"path": "~/notes", "name": "notes"},
    {"path": "~/work/docs", "name": "work-docs"},
    {"path": "~/meetings", "name": "meetings"}
  ]
}
```

The `username` is resolved automatically from the token via `GET /v1/me` during `sv init`.

**`name` defaults to the folder basename.** Explicit names are only needed when basenames collide (e.g., two directories both named `notes`).

### Collection overlap policy

Collections must not overlap by path (no parent/child nesting at the same time).

- Adding a **child** collection under an existing parent collection is rejected.
- Adding a **parent** collection removes any already-configured child collections first, then adds the parent.
- If config is edited manually into an overlapping state, daemon normalizes to a non-overlapping set (parents win) and logs a warning.

### Path mapping

Each collection name becomes the top-level prefix for its files on the server:

```
Collection config: {"path": "~/work/docs", "name": "work-docs"}
Local file:    ~/work/docs/api/design.md
Server path:   work-docs/api/design.md

Collection config: {"path": "~/notes"}  (auto-named "notes")
Local file:    ~/notes/seedvault.md
Server path:   notes/seedvault.md
```

Each watched directory gets a unique collection name, and files within are identified by `(collection_name, relative_path)`.

### File filtering

- Only syncs files matching `**/*.md`
- Ignores all dotfiles and dotdirectories (`.git`, `.DS_Store`, `.env`, etc.)
- Ignores `node_modules`
- Ignores temporary files matching `*.tmp.*`

---

## CLI (`sv`)

The `sv` command is the unified CLI for Seedvault — daemon management, collection configuration, and admin operations.

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
sv init --server URL --token T   # Non-interactive setup (username resolved from token)
sv init --server URL --name me --invite CODE  # Non-interactive signup
sv init --force                  # Overwrite existing config
```

**Collection management:**
```bash
sv add ~/notes                         # Add a collection (auto-name: "notes")
sv add ~/work/docs --name work-docs    # Add with explicit collection name; may remove overlapping child collections
sv remove notes                         # Stop watching a collection
sv collections                          # List configured collections
```

**Daemon:**
```bash
sv start                   # Register OS service and start syncing
sv start -f                # Start syncing in foreground (debug)
sv stop                    # Stop daemon and unregister service
sv status                  # Show daemon/config/server status
```

**File operations (reads from server via structured API):**
```bash
sv ls                      # List all contributors
sv ls yiliu/notes/         # List files under a path
sv cat yiliu/notes/seedvault.md  # Read a file
sv grep "search term"      # Full-text search across all contributors
```

**Vault:**
```bash
sv contributors            # List all contributors
sv invite                  # Generate an invite code (operator only)
```

### Configuration

Config lives at `~/.config/seedvault/config.json`:

```json
{
  "server": "https://vault.example.com",
  "token": "sv_...",
  "username": "yiliu",
  "collections": [
    {"path": "/Users/yiliu/notes", "name": "notes"},
    {"path": "/Users/yiliu/work/docs", "name": "work-docs"}
  ]
}
```

---

## Repos & Distribution

### `seedvault` (monorepo)
```
server/     # Server — published to npm, deploys to Fly.io, Docker, or self-hosted (macOS)
cli/        # sv CLI + daemon — published to npm
electron/   # Desktop app — bundles the daemon
```

### Install paths

| User | Install | Sync |
|------|---------|------|
| **Humans (CLI)** | `curl -fsSL https://seedvault.ai/install.sh \| bash` | `sv start` |
| **Humans (desktop)** | Seedvault app (Electron) | Bundled in app |
| **Humans (web)** | Web app | N/A (reads from service directly) |
| **Self-hosted server** | `curl -fsSL https://seedvault.ai/install-server.sh \| bash` | launchd service |
| **Agents** (OpenClaw, Collaborator, etc.) | Install script, non-interactive | `sv start` |
| **Collaborator users** | Built into Collaborator | Built into Collaborator |

All paths talk to the same service API.

## Tech Stack

- **Server:** TypeScript, Hono, Bun, SQLite (via `bun:sqlite` — content, auth, metadata, FTS5 search)
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
| `DATA_DIR` | `~/.seedvault/data` | Root for all persistent data |

All persistent state lives under `DATA_DIR`:

```
$DATA_DIR/
  seedvault.db          # SQLite (everything — content, auth, metadata, FTS5 index)
```

One file to mount, one file to back up.

### Docker

The `Dockerfile` bundles the server and Bun runtime. This is the universal deployment unit — runs on Fly.io, any VPS, AWS/GCP, bare metal.

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

### Self-hosted (macOS)

For running the server on a personal machine (e.g., a Mac Mini) with optional public internet access via Cloudflare Tunnel.

**Install:**
```bash
curl -fsSL https://seedvault.ai/install-server.sh | bash
```

The installer:
1. Installs Bun if not present
2. Installs `@seedvault/server` globally via `bun install -g`
3. Optionally sets up a Cloudflare Tunnel (stable token, quick tunnel, or local only)
4. Registers a `launchd` service (`ai.seedvault.server`) that auto-starts on login and restarts on crash

Data is stored at `~/.seedvault/data`, logs at `~/.seedvault/server.log`.

**Options:**
```bash
# Non-interactive with quick tunnel (random URL, changes on restart)
curl -fsSL https://seedvault.ai/install-server.sh | bash -s -- --tunnel=quick

# Non-interactive with tunnel token (stable URL)
curl -fsSL https://seedvault.ai/install-server.sh | bash -s -- --tunnel-token=<TOKEN>

# Local only, custom port
curl -fsSL https://seedvault.ai/install-server.sh | bash -s -- --no-tunnel --port=8080

# Update server to latest version (preserves tunnel config)
curl -fsSL https://seedvault.ai/install-server.sh | bash -s -- --update
```

**Management:**
```bash
launchctl list ai.seedvault.server    # Check status
tail -f ~/.seedvault/server.log       # View logs
curl http://localhost:3000/health     # Verify it's running
```

**Uninstall:**
```bash
curl -fsSL https://seedvault.ai/uninstall-server.sh | bash
```

The uninstaller stops the server and tunnel services, removes the package, and prompts before deleting data. Pass `--remove-data` to delete `~/.seedvault/` non-interactively.

### Search

Full-text search is built into the server via SQLite FTS5. The FTS index is maintained automatically via database triggers — no external indexer or scheduled updates.

### First boot

On first start with an empty `DATA_DIR`, the server:

1. Creates `DATA_DIR/seedvault.db` with schema (including FTS5 tables and triggers)
2. Waits for the first `POST /v1/signup` (no invite required — this becomes the operator)

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
| `403` | Forbidden — token doesn't have permission (e.g., writing to another contributor, non-operator generating invites) |
| `404` | Not found — contributor or file doesn't exist |
| `409` | Conflict — contributor name already taken (on signup) |
| `413` | Payload too large — file exceeds 10 MB |

---

## MVP Scope

**In:**
- Vault with multiple contributors (one per contributor)
- Signup with invite system (first user is operator)
- `sv` CLI with daemon, collection management, and vault commands
- Curl-pipe-bash installer (`seedvault.ai/install.sh`)
- Structured read endpoints (`GET /v1/files/:username/*`, `GET /v1/files?prefix=`)
- Write endpoints (`PUT`/`DELETE /v1/files/*`)
- Full-text search via SQLite FTS5
- SSE event stream
- Contributor-scoped token auth (every token writes to its contributor, reads all)
- SQLite storage (content + metadata, 10 MB max per file, last-write-wins)
- Health check endpoint

**Out (post-MVP):**
- E2E encryption
- Multi-vault server (multiple vaults per deployment)
- Read-only tokens (consumers without a contributor)
- Token revocation
- Contributor deletion
- Web UI for vault management
- Version history / file diffing
- Bulk sync optimization (hashing, delta transfer)
- Session-based auth (login flow for web UI)

---

## Open Issues

### Daemon resilience on machine restarts

The sync daemon stops and does not reliably restart when the host machine reboots, particularly on OpenClaw instances. This needs to be guarded against at multiple levels:

1. **OS service layer**: The launchd plist (macOS) and systemd unit (Linux) should be configured with aggressive restart policies — `KeepAlive`/`Restart=always` with bounded retry windows, not just `RunAtLoad`.
2. **Process supervision**: The daemon itself should detect when it's supposed to be running (e.g., a sentinel file or config flag) and have a self-healing check — a periodic cron/timer that verifies the daemon is alive and restarts it if not.
3. **Startup ordering**: On machines where the server and daemon coexist, the daemon may start before the network or server is ready. The daemon needs a startup backoff that waits for server reachability before entering the sync loop, rather than crashing on first connection failure.
4. **Health monitoring**: `sv status` should detect "should be running but isn't" and offer `sv start` as a recovery action. Agents running on the machine should be able to self-heal by checking `sv status` and restarting if needed.

---

*Started 2026-02-10. Yiliu + Collin.*
