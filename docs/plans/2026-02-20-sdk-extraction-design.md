# SDK Extraction Design

Extract the HTTP client from `@seedvault/cli` into `@seedvault/sdk` — a standalone, zero-dependency package that any consumer (CLI, Tauri app, future integrations) can import to talk to a Seedvault server.

## Decisions

- **Location:** New `sdk/` workspace member inside `seedvault/` (alongside `server/` and `cli/`)
- **Distribution:** Published to npm as `@seedvault/sdk`
- **API style:** Raw server responses — no ergonomic transforms (consumers add their own)
- **Shared types:** SDK owns all API response/model types; server imports them for handler typing
- **SSE API:** AsyncGenerator with built-in reconnect/backoff; consumers wrap as needed (e.g., React hook)

## Package Structure

```
sdk/
├── src/
│   ├── index.ts       # re-exports (public API)
│   ├── client.ts      # createClient() factory + internal request()
│   ├── types.ts       # all API request/response/model types
│   ├── sse.ts         # parseSSEStream() + subscribe AsyncGenerator
│   └── errors.ts      # ApiError class
├── package.json       # @seedvault/sdk, zero runtime deps
└── tsconfig.json
```

## Public API

```typescript
export { createClient, ApiError }
export type {
  SeedvaultClient,
  MeResponse, SignupResponse, InviteResponse,
  ContributorsResponse, FileWriteResponse, FilesResponse,
  SearchResponse, ActivityResponse, HealthResponse,
  FileEntry, SearchResult, ActivityEvent, VaultEvent,
  PutFileOptions, SearchOptions, ActivityOptions, SubscribeOptions,
}
```

## Consumer Migration

### CLI

- Replaces `client.ts` with imports from `@seedvault/sdk`
- `api/client.ts` becomes a re-export barrel
- `listFiles` username-stripping moves to CLI layer (local wrapper or inline)
- `api/index.ts` keeps exporting config/service/health alongside re-exported SDK types
- No breaking change to `@seedvault/cli` external API
- Adds `"@seedvault/sdk": "workspace:*"` dependency

### Server

- Imports shared model types from `@seedvault/sdk` to type handler responses
- Can happen incrementally — not blocking for initial extraction
- Adds `"@seedvault/sdk": "workspace:*"` dependency

### Tauri App

- Installs `@seedvault/sdk` from npm
- Uses `createClient(serverUrl, token)` directly
- Wraps `subscribe()` AsyncGenerator in a React hook (~10 LOC)

### Root Workspace

```jsonc
// seedvault/package.json
{ "workspaces": ["server", "cli", "sdk"] }
```

Existing `check` script (`bun run --filter '*' check`) picks up the SDK automatically.

## Build & Publish

- `tsc` emits ESM + declarations to `dist/`
- No bundler — zero runtime dependencies, standard APIs only (`fetch`, `ReadableStream`, `TextDecoder`)
- Starts at version `0.1.0`
- Follows existing seedvault semver rules (patch/minor/major per CLAUDE.md)
- Same publish flow as CLI and server (`bun run build && npm publish`)

## Testing

- Unit tests for `parseSSEStream()` (multiline JSON, event filtering, reconnect behavior)
- Unit tests for `ApiError` construction
- Integration tests remain in `seedvault/test/` (existing suite covers end-to-end flows)
- Colocated test files: `sdk/src/*.test.ts`, run via `bun test sdk/`

## Error Handling

- Non-2xx responses throw `ApiError(status, message)`
- SSE reconnects with exponential backoff (1s to 60s) on network errors
- SSE throws `ApiError` on auth failures (4xx) without reconnect
- No retry logic for regular HTTP calls (consumer concern)
- No caching, offline support, or credential management

## What the SDK Does NOT Include

- Config management (CLI concern)
- File watching / sync engine (CLI daemon concern)
- OS service management (CLI daemon concern)
- Retry queues (consumer concern)
- Path transforms like username stripping (consumer concern)
- React hooks or framework bindings (consumer concern)
