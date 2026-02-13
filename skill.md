---
name: seedvault
version: 0.2.0
description: Pooled markdown sync service. Keep local markdown folders in sync with a central server.
homepage: https://www.seedvault.ai
---

# Seedvault

## File Index

| File | URL |
|------|-----|
| SKILL.md (this file) | `https://raw.githubusercontent.com/collaborator-ai/seedvault/main/skill.md` |
| install-cli.sh | `https://raw.githubusercontent.com/collaborator-ai/seedvault/main/install-cli.sh` |
| uninstall-cli.sh | `https://raw.githubusercontent.com/collaborator-ai/seedvault/main/uninstall-cli.sh` |

## What is Seedvault

Seedvault is a **pooled markdown sync service**. Multiple contributors sync local markdown folders to one central server. Each contributor owns their files (write access); everyone else gets read-only access. Files are stored in SQLite with FTS5 full-text search.

## Install

**Interactive** (humans):
```bash
curl -fsSL https://raw.githubusercontent.com/collaborator-ai/seedvault/main/install-cli.sh | bash
```

**Non-interactive** (agents / CI):
```bash
curl -fsSL https://raw.githubusercontent.com/collaborator-ai/seedvault/main/install-cli.sh | bash -s -- --no-onboard
sv init --server URL --token TOKEN --contributor-id ID
```

## Core Concepts

- **Vault** — A single Seedvault server deployment. One server, one SQLite database, one set of API endpoints.
- **Contributor** — Your namespace within the vault. One owner, one write token. You write to yours, read from everyone's.
- **Collection** — A local folder you sync. Maps to a named prefix on the server (e.g., `~/notes` → `notes/` on server). Name defaults to the folder basename.
- **Token** — `sv_...` bearer token, scoped to your contributor. Created at signup. Grants write access to your contributor and read access to all contributors.

## Setup

### Interactive setup (first time)
```bash
sv init
```
Prompts for server URL, then walks through signup or existing-token flow.

### Non-interactive setup (existing token)
```bash
sv init --server https://vault.example.com --token sv_abc123 --contributor-id contributor_xyz
```

### Non-interactive setup (signup with invite)
```bash
sv init --server https://vault.example.com --name my-notes --invite INVITE_CODE
```

### Non-interactive setup (first user / admin)
```bash
sv init --server https://vault.example.com --name my-notes
```

## Collection Management

### Add a collection
```bash
sv add ~/notes                       # Auto-named "notes"
sv add ~/work/docs --name work-docs  # Explicit name
```

### Remove a collection
```bash
sv remove notes
```

### List collections
```bash
sv collections
```

## Daemon

### Start syncing
```bash
sv start
```
Registers an OS service (launchd on macOS, systemd on Linux, Task Scheduler on Windows) that auto-restarts on crash and starts on login.

### Start syncing in foreground (debug)
```bash
sv start -f
```

### Stop the daemon
```bash
sv stop
```
Stops the daemon and unregisters the OS service.

### Check status
```bash
sv status
```
Shows service state (launchd/systemd/Task Scheduler), configured collections, and server connectivity.

## File Operations

### List contributors or files
```bash
sv ls                          # List all contributors
sv ls yiliu                    # List a contributor's files
sv ls yiliu/notes/             # List files under a prefix
```

### Read files
```bash
sv cat yiliu/notes/seedvault.md
```

### Search
```bash
sv grep "search term"                          # Search all content
sv grep "API design" --contributor yiliu        # Filter by contributor
sv grep "query" --limit 5                       # Limit results
```

### HTTP API (direct)

Read a file:
```bash
curl -s https://vault.example.com/v1/files/yiliu/notes/seedvault.md \
  -H "Authorization: Bearer sv_..."
```

Search:
```bash
curl -s "https://vault.example.com/v1/search?q=context&contributor=yiliu" \
  -H "Authorization: Bearer sv_..."
```

## Vault Info

### List all contributors
```bash
sv contributors
```

### Generate an invite code (admin only)
```bash
sv invite
```

## Common Agent Workflows

### 1. Set up from scratch with an invite code
```bash
curl -fsSL https://raw.githubusercontent.com/collaborator-ai/seedvault/main/install-cli.sh | bash -s -- --no-onboard
sv init --server https://vault.example.com --name agent-notes --invite INVITE_CODE
sv add ~/workspace/notes
sv start
```

### 2. Add a directory and start syncing
```bash
sv add ~/new-project/docs --name project-docs
sv start
```

### 3. Browse the vault
```bash
sv ls                              # See all contributors
sv ls yiliu/notes/                 # Browse someone's files
sv cat yiliu/notes/seedvault.md    # Read a file
sv grep "query"                    # Search everything
```

### 4. Read a specific file (HTTP)
```bash
curl -s https://vault.example.com/v1/files/yiliu/notes/seedvault.md \
  -H "Authorization: Bearer sv_..."
```

## Configuration

Config file: `~/.config/seedvault/config.json`

```json
{
  "server": "https://vault.example.com",
  "token": "sv_...",
  "contributorId": "contributor_abc123",
  "collections": [
    { "path": "/Users/you/notes", "name": "notes" },
    { "path": "/Users/you/work/docs", "name": "work-docs" }
  ]
}
```

## Version
```bash
sv --version
```

## Uninstall
```bash
curl -fsSL https://raw.githubusercontent.com/collaborator-ai/seedvault/main/uninstall-cli.sh | bash
```
