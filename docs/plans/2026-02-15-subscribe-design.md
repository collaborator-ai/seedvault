# Subscribe Design

Server-side SSE subscription on `SeedvaultClient`.

## `subscribe()` — Server SSE

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

## Files

| File | Change |
|------|--------|
| `cli/src/client.ts` | Add `subscribe()`, `SubscribeOptions`, `VaultEvent` |
| `cli/src/api/client.ts` | Re-export `SubscribeOptions`, `VaultEvent` |
| `cli/src/api/index.ts` | Re-export new APIs |

## Decisions

- **Raw fetch over EventSource**: avoids token-in-URL security issue, no new dependencies
- **Client-side event filtering**: server broadcasts all events; `subscribe()` filters locally based on `SubscribeOptions`
