# Agent Architecture: Docker Volumes + Seedvault

## Overview

When running AI agents in containers (OpenClaw, Collaborator, etc.), the recommended architecture uses **Docker volumes** for local storage with **Seedvault as the source of truth** for persistent files.

## Why Not Bind Mounts?

Bind mounts (`-v /host/path:/container/path`) seem convenient for development but have fundamental issues:

1. **inotify doesn't work** — File watchers break when mounting through VM layers (Docker Desktop, OrbStack, etc.). This affects hot-reload, sync daemons, and any file-watching functionality.

2. **Not portable** — Bind mounts assume a specific host directory structure. Containers can't move between machines.

3. **No cloud equivalent** — In production (AWS, Fly.io, etc.), there's no host filesystem to mount.

## Recommended Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     Seedvault (Cloud)                        │
│                   Source of Truth for Files                  │
└─────────────────────────────────────────────────────────────┘
                              ▲
                              │ sync
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                    Agent Container                           │
│  ┌─────────────────────────────────────────────────────┐    │
│  │              Docker Volume: /workspace               │    │
│  │                                                      │    │
│  │  • Local cache of synced files                      │    │
│  │  • inotify works natively                           │    │
│  │  • Daemon watches for changes                       │    │
│  │  • Syncs bidirectionally with Seedvault             │    │
│  └─────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────┘
```

### Key Points

1. **Docker volume for workspace** — Files live inside Docker's storage, not on the host. inotify works perfectly.

2. **Seedvault as source of truth** — The vault contains the canonical version of all files. Local copies are caches.

3. **Bidirectional sync** — The Seedvault daemon syncs changes both ways:
   - Local changes → Vault (agent writes)
   - Vault changes → Local (other contributors' writes)

4. **Portable** — Containers can run anywhere. Spin up a new container, sync from Seedvault, resume work.

5. **Collaborative** — Multiple agents share the same vault. Changes propagate via Seedvault, not filesystem.

## Docker Configuration

### Creating a Volume

```bash
docker volume create agent-workspace
```

### Running with Volume

```bash
docker run -d \
  -v agent-workspace:/home/node/.openclaw/workspace \
  --name my-agent \
  openclaw/agent
```

### Accessing Files

Files in Docker volumes aren't directly accessible from the host. Access them via:

1. **Seedvault** — `sv sh "cat contributor/path/file.md"` or the web UI
2. **Docker exec** — `docker exec my-agent cat /workspace/file.md`
3. **Docker cp** — `docker cp my-agent:/workspace/file.md ./local-copy.md`

## Migration from Bind Mounts

1. Create a Docker volume
2. Copy existing files into the volume
3. Update container configuration to use volume instead of bind mount
4. Configure Seedvault daemon to sync the volume contents
5. Access files via Seedvault instead of host filesystem

## OpenClaw Configuration

OpenClaw's `docker-setup.sh` supports a `OPENCLAW_HOME_VOLUME` environment variable, but currently still overlays bind mounts on top. For full Docker volume support with working inotify:

### Option 1: Modify docker-compose.yml

```yaml
services:
  openclaw-gateway:
    image: openclaw/openclaw
    volumes:
      # Config from host (read-only, rarely changes)
      - ${OPENCLAW_CONFIG_DIR}:/home/node/.openclaw/config:ro
      # Workspace as Docker volume (inotify works!)
      - openclaw-workspace:/home/node/.openclaw/workspace

volumes:
  openclaw-workspace:
```

### Option 2: Pure Docker Volume Mode

For cloud deployments where no host access is needed:

```yaml
services:
  openclaw-gateway:
    image: openclaw/openclaw
    volumes:
      - openclaw-data:/home/node/.openclaw  # Everything in volume

volumes:
  openclaw-data:
```

Initial config can be injected via environment variables or copied in during image build.

### Seedvault Integration

With Docker volumes, the Seedvault daemon works natively:

```bash
# Inside the container
sv add /home/node/.openclaw/workspace/memory
sv start -f  # inotify works!
```

Files sync to the vault and are accessible from anywhere via `sv sh` or the web UI.

## Benefits

| Aspect | Bind Mount | Docker Volume + Seedvault |
|--------|-----------|---------------------------|
| inotify | ❌ Broken via VM | ✅ Works natively |
| Portability | ❌ Host-dependent | ✅ Runs anywhere |
| Cloud-ready | ❌ No equivalent | ✅ Same architecture |
| Collaboration | ❌ Single machine | ✅ Multi-agent via vault |
| Persistence | ⚠️ Tied to host | ✅ Vault is durable |
| Direct host access | ✅ Yes | ❌ Via Seedvault/docker |

## Summary

For production agent deployments, use Docker volumes with Seedvault sync. The vault becomes your distributed filesystem, and local container storage is just a performant cache with working file watchers.
