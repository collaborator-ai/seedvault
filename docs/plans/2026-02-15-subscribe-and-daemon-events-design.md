# Subscribe & Daemon Events Design

Two new real-time event APIs for `@seedvault/cli`: server-side SSE subscription on `SeedvaultClient` and local daemon file-change events over a Unix domain socket.

## 6.1: `subscribe()` — Server SSE

### Interface

```typescript
interface SubscribeOptions {
  /** Filter to a specific contributor. Omit for all. */
  contributor?: string;
  /** Filter to specific actions. Omit for all. */
  actions?: Array<"file_write" | "file_delete">;
}

interface VaultEvent {
  id: string;
  action: "file_write" | "file_delete";
  contributor: string;
  path: string;
  timestamp: string; // ISO 8601
}
```

New method on `SeedvaultClient`:

```typescript
subscribe(opts?: SubscribeOptions): AsyncGenerator<VaultEvent>
```

### Implementation

- Uses `fetch` with `Authorization: Bearer` header to connect to `GET /v1/events`
- Parses the SSE text/event-stream format manually (accumulate `event:`/`data:` lines, emit on blank line)
- Maps server event names to spec names: `file_updated` -> `file_write`, `file_deleted` -> `file_delete`
- Ignores `activity`, `connected`, and keepalive events
- Applies client-side filtering for `contributor` and `actions` options
- Reconnects on disconnect with exponential backoff: 1s initial, 2x growth, 60s cap
- No replay on reconnect (sync service handles catch-up separately)
- Caller terminates by breaking out of `for await` loop; generator cleanup aborts the fetch via `AbortController`

### Why raw fetch over EventSource

`EventSource` doesn't support custom `Authorization` headers. The server's HTML UI works around this with `?token=` query params, but exposing tokens in URLs is a security concern for programmatic clients. Raw fetch with streaming body avoids this and matches the existing HTTP pattern in `client.ts`.

## 6.2: Daemon Local Events

### Transport

Unix domain socket at `~/.config/seedvault/daemon.sock`. Newline-delimited JSON (NDJSON).

### Event format

```json
{"action":"file_write","path":"notes/design.md","collection":"notes","timestamp":"2026-02-15T10:30:00Z"}
{"action":"file_delete","path":"notes/old.md","collection":"notes","timestamp":"2026-02-15T10:30:01Z"}
{"action":"dir_delete","path":"notes/archive","collection":"notes","timestamp":"2026-02-15T10:30:02Z"}
```

### Protocol

- Client connects to socket
- Daemon streams events as they occur (after chokidar's debounce)
- Pure push, no request/response
- If client disconnects, daemon doesn't buffer; client re-syncs on reconnect via `listFiles()`

### Event mapping from chokidar

| Chokidar event | Action | Notes |
|----------------|--------|-------|
| `add` | `file_write` | New file detected |
| `change` | `file_write` | File content changed |
| `unlink` | `file_delete` | File removed |
| `unlinkDir` | `dir_delete` | Directory removed |

### Daemon side (`cli/src/daemon/socket.ts`)

- Creates Unix socket server at `~/.config/seedvault/daemon.sock`
- Removes stale socket file on startup
- Tracks connected clients in a `Set<net.Socket>`
- Exposes `broadcastEvent(event)` to push NDJSON to all connected clients
- Silently drops write errors (client disconnected)
- Cleans up socket file on daemon shutdown

### Consumer API (`cli/src/api/daemon-events.ts`)

```typescript
interface DaemonFileEvent {
  action: "file_write" | "file_delete" | "dir_delete";
  path: string;
  collection: string;
  timestamp: string; // ISO 8601
}

function subscribeDaemonEvents(): AsyncGenerator<DaemonFileEvent>
```

- Connects via Node `net.connect` (works in both Bun and Node)
- Parses NDJSON (buffer incoming data, split on newlines, JSON.parse each line)
- Yields `DaemonFileEvent` objects
- Generator cleanup closes the socket
- No reconnection logic (consumer handles re-sync)

## Files

| File | Change |
|------|--------|
| `cli/src/client.ts` | Add `subscribe()`, `SubscribeOptions`, `VaultEvent` |
| `cli/src/daemon/socket.ts` | New: Unix socket server for daemon |
| `cli/src/commands/start.ts` | Wire up socket server, broadcast events, cleanup on shutdown |
| `cli/src/api/daemon-events.ts` | New: `subscribeDaemonEvents()` consumer API |
| `cli/src/api/client.ts` | Re-export `SubscribeOptions`, `VaultEvent` |
| `cli/src/api/index.ts` | Re-export new APIs from both modules |
| `cli/package.json` | Add `./daemon-events` subpath export |

## Decisions

- **Raw fetch over EventSource**: avoids token-in-URL security issue, no new dependencies
- **Node `net` module over Bun-native sockets**: keeps consumer API portable (importable from Node)
- **Client-side event filtering**: server broadcasts all events; `subscribe()` filters locally based on `SubscribeOptions`
- **No reconnection on daemon socket**: spec says client re-syncs via `listFiles()` on reconnect
- **`dir_delete` action added**: extends spec's two actions to three, covering chokidar's `unlinkDir`
