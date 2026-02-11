# Running Seedvault in Docker Containers

## The Problem

When running the Seedvault daemon in a Docker container with **bind mounts** (files mounted from the host), the file watcher doesn't work. This is because inotify events don't propagate through the VM filesystem layer (Docker Desktop, OrbStack, etc.).

## The Solution

Use **Docker volumes** instead of bind mounts for the workspace. Docker volumes store files inside the VM's native filesystem, where inotify works normally.

### Bind Mount (broken)
```bash
# inotify doesn't work — watcher misses file changes
docker run -v /host/path:/workspace ...
```

### Docker Volume (works)
```bash
# inotify works — watcher sees all changes
docker volume create workspace
docker run -v workspace:/workspace ...
```

## OpenClaw Configuration

For OpenClaw containers, use a Docker volume for the workspace:

```yaml
services:
  openclaw-gateway:
    image: openclaw/openclaw
    volumes:
      - openclaw-workspace:/home/node/.openclaw/workspace

volumes:
  openclaw-workspace:
```

With this setup, `sv start` works normally — chokidar receives inotify events and syncs file changes to the vault.

## Accessing Files

Files in Docker volumes aren't directly accessible from the host. Access them via:

- **Seedvault**: `sv sh "cat hyperbot/memory/file.md"`
- **Docker exec**: `docker exec container cat /workspace/file.md`
- **Docker cp**: `docker cp container:/workspace/file.md ./`

## Summary

| Mount Type | inotify | Seedvault Daemon |
|------------|---------|------------------|
| Bind mount | ❌ Broken | ❌ Misses changes |
| Docker volume | ✅ Works | ✅ Works |

Use Docker volumes for containers that need file watching.
