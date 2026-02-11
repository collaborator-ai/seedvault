---
name: seedvault
version: 0.1.0
description: Pooled markdown sync service. Keep local markdown folders in sync with a central server.
homepage: https://www.seedvault.ai
---

# Seedvault

## File Index

| File | URL |
|------|-----|
| SKILL.md (this file) | `https://www.seedvault.ai/skill.md` |
| install-cli.sh | `https://www.seedvault.ai/install-cli.sh` |
| uninstall-cli.sh | `https://www.seedvault.ai/uninstall-cli.sh` |

## What is Seedvault

Seedvault is a **pooled markdown sync service**. Multiple contributors sync local markdown folders to one central server. Each contributor owns their files (write access); everyone else gets read-only access. Files are plain markdown on disk, indexed by [QMD](https://github.com/tobi/qmd) for hybrid search (BM25 + semantic + LLM re-ranking).

## Install

**Interactive** (humans):
```bash
curl -fsSL https://seedvault.ai/install-cli.sh | bash
```

**Non-interactive** (agents / CI):
```bash
curl -fsSL https://seedvault.ai/install-cli.sh | bash -s -- --no-onboard
sv init --server URL --token TOKEN --contributor-id ID
```

## Core Concepts

- **Vault** — A single Seedvault server deployment. One server, one storage root, one set of API endpoints.
- **Contributor** — Your namespace within the vault. One owner, one write token, one directory on the server. You write to yours, read from everyone's.
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

### Non-interactive setup (first user / operator)
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

### Start syncing (foreground)
```bash
sv start
```

### Start syncing (background)
```bash
sv start -d
```

### Stop the daemon
```bash
sv stop
```

### Check status
```bash
sv status
```
Shows daemon state, configured collections, and server connectivity.

## File Operations (reads from server)

### List files
```bash
sv ls              # All files in your contributor
sv ls notes/       # Files under a prefix
```

### Read a file
```bash
sv cat notes/seedvault.md
```

## Vault Info

### List all contributors
```bash
sv contributors
```

### Generate an invite code (operator only)
```bash
sv invite
```

## Common Agent Workflows

### 1. Set up from scratch with an invite code
```bash
curl -fsSL https://seedvault.ai/install-cli.sh | bash -s -- --no-onboard
sv init --server https://vault.example.com --name agent-notes --invite INVITE_CODE
sv add ~/workspace/notes
sv start -d
```

### 2. Add a directory and start syncing as background daemon
```bash
sv add ~/new-project/docs --name project-docs
sv start -d
```

### 3. Check what files are in the vault
```bash
sv ls
sv ls notes/
```

### 4. Read a specific file
```bash
sv cat notes/seedvault.md
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
curl -fsSL https://seedvault.ai/uninstall-cli.sh | bash
```
