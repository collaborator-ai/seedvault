# @seedvault/sdk Extraction — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Extract the HTTP client from `@seedvault/cli` into a standalone `@seedvault/sdk` package that CLI, Tauri, and future consumers can import.

**Architecture:** Move `cli/src/client.ts` (types, error class, SSE parser, client factory) into a new `sdk/` workspace member. Remove the `listFiles` username-stripping transform (SDK returns raw server responses). Rewrite CLI imports to point at `@seedvault/sdk`. Update existing integration tests to import from the SDK.

**Tech Stack:** TypeScript, Bun workspace, tsc for build

**Design doc:** `docs/plans/2026-02-20-sdk-extraction-design.md`

---

### Task 1: Scaffold the SDK Package

**Files:**
- Create: `sdk/package.json`
- Create: `sdk/tsconfig.json`
- Modify: `package.json` (root workspace)

**Step 1: Create `sdk/package.json`**

```json
{
  "name": "@seedvault/sdk",
  "version": "0.1.0",
  "type": "module",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    }
  },
  "types": "dist/index.d.ts",
  "files": ["dist"],
  "scripts": {
    "build": "tsc",
    "check": "tsc --noEmit",
    "prepublishOnly": "bun run build"
  },
  "repository": {
    "type": "git",
    "url": "https://github.com/collaborator-ai/seedvault.git",
    "directory": "sdk"
  },
  "devDependencies": {
    "typescript": "^5"
  }
}
```

**Step 2: Create `sdk/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "bundler",
    "strict": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "declaration": true,
    "outDir": "./dist",
    "rootDir": "./src",
    "isolatedModules": true,
    "verbatimModuleSyntax": true
  },
  "include": ["src"],
  "exclude": ["node_modules", "dist"]
}
```

**Step 3: Add SDK to root workspace**

In `package.json` (root), change:
```json
"workspaces": ["server", "cli"]
```
to:
```json
"workspaces": ["server", "cli", "sdk"]
```

**Step 4: Install workspace dependencies**

Run: `cd /Users/yiliu/repos/collab-product/seedvault && bun install`
Expected: SDK linked as workspace package, no errors.

**Step 5: Verify `tsc --noEmit` runs (will fail — no source files yet, that's OK)**

Run: `cd /Users/yiliu/repos/collab-product/seedvault/sdk && bun run check`
Expected: Error about no input files (src/ doesn't exist yet). Confirms tsconfig is valid.

**Step 6: Commit**

```bash
git add sdk/package.json sdk/tsconfig.json package.json bun.lock
git commit -m "feat(sdk): scaffold @seedvault/sdk package"
```

---

### Task 2: Create SDK Source Files from CLI's client.ts

Split `cli/src/client.ts` (408 lines) into 4 focused SDK source files. The content is a reorganization — not a rewrite.

**Files:**
- Create: `sdk/src/errors.ts`
- Create: `sdk/src/types.ts`
- Create: `sdk/src/sse.ts`
- Create: `sdk/src/client.ts`
- Create: `sdk/src/index.ts`

**Step 1: Create `sdk/src/errors.ts`**

Extract `ApiError` class from `cli/src/client.ts:135-142`.

```typescript
export class ApiError extends Error {
  public status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}
```

**Step 2: Create `sdk/src/types.ts`**

Extract all interfaces from `cli/src/client.ts:36-131`. These are copied verbatim — no changes.

```typescript
export interface MeResponse {
  username: string;
  createdAt: string;
}

export interface SignupResponse {
  contributor: { username: string; createdAt: string };
  token: string;
}

export interface InviteResponse {
  invite: string;
  createdAt: string;
}

export interface ContributorsResponse {
  contributors: Array<{ username: string; createdAt: string }>;
}

export interface FileWriteResponse {
  path: string;
  size: number;
  createdAt: string;
  modifiedAt: string;
}

export interface FileEntry {
  path: string;
  size: number;
  createdAt: string;
  modifiedAt: string;
}

export interface PutFileOptions {
  originCtime?: string;
  originMtime?: string;
}

export interface FilesResponse {
  files: FileEntry[];
}

export interface SearchOptions {
  contributor?: string;
  limit?: number;
}

export interface SearchResult {
  contributor: string;
  path: string;
  snippet: string;
  rank: number;
}

export interface SearchResponse {
  results: SearchResult[];
}

export interface ActivityEvent {
  id: string;
  contributor: string;
  action: string;
  detail: string | null;
  created_at: string;
}

export interface ActivityOptions {
  contributor?: string;
  action?: string;
  limit?: number;
}

export interface ActivityResponse {
  events: ActivityEvent[];
}

export interface HealthResponse {
  status: string;
}

export interface SubscribeOptions {
  /** Filter to a specific contributor. Omit for all. */
  contributor?: string;
  /** Filter to specific actions. Omit for all. */
  actions?: Array<"file_write" | "file_delete">;
}

export interface VaultEvent {
  id: string;
  action: "file_write" | "file_delete";
  contributor: string;
  path: string;
  timestamp: string;
}
```

**Step 3: Create `sdk/src/sse.ts`**

Extract SSE helpers from `cli/src/client.ts:152-227`. Import `VaultEvent` and `SubscribeOptions` from `types.ts`.

```typescript
import type { VaultEvent, SubscribeOptions } from "./types.js";

/** Map server SSE event names to VaultEvent action names */
const SSE_ACTION_MAP: Record<string, "file_write" | "file_delete"> = {
  file_updated: "file_write",
  file_deleted: "file_delete",
};

export async function* parseSSEStream(
  body: ReadableStream<Uint8Array>,
  opts: SubscribeOptions | undefined,
  controller: AbortController,
): AsyncGenerator<VaultEvent> {
  const decoder = new TextDecoder();
  const reader = body.getReader();
  let buffer = "";
  let eventType = "";
  let dataLines: string[] = [];

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop()!;

      for (const line of lines) {
        if (line.startsWith("event: ")) {
          eventType = line.slice(7).trim();
        } else if (line.startsWith("data: ")) {
          dataLines.push(line.slice(6));
        } else if (line === "" && eventType && dataLines.length > 0) {
          const action = SSE_ACTION_MAP[eventType];
          if (action) {
            let data: Record<string, unknown>;
            try {
              data = JSON.parse(dataLines.join("\n"));
            } catch {
              eventType = "";
              dataLines = [];
              continue;
            }
            const event: VaultEvent = {
              id: (data.id as string) ?? "",
              action,
              contributor: (data.contributor as string) ?? "",
              path: (data.path as string) ?? "",
              timestamp:
                (data.modifiedAt as string) ??
                (data.created_at as string) ??
                new Date().toISOString(),
            };

            const passContributor =
              !opts?.contributor ||
              event.contributor === opts.contributor;
            const passAction =
              !opts?.actions ||
              opts.actions.includes(event.action);

            if (passContributor && passAction) {
              yield event;
            }
          }
          eventType = "";
          dataLines = [];
        } else if (line === "") {
          eventType = "";
          dataLines = [];
        }
      }
    }
  } finally {
    reader.releaseLock();
    controller.abort();
  }
}
```

**Step 4: Create `sdk/src/client.ts`**

Extract `createClient`, `encodePath`, and `request` from `cli/src/client.ts:146-407`. Import types from `types.ts`, `ApiError` from `errors.ts`, `parseSSEStream` from `sse.ts`.

Key change from CLI version: the `listFiles` method returns **raw server paths** — remove the username-stripping transform at lines 320-327.

```typescript
import { ApiError } from "./errors.js";
import { parseSSEStream } from "./sse.js";
import type {
  MeResponse,
  SignupResponse,
  InviteResponse,
  ContributorsResponse,
  FileWriteResponse,
  FilesResponse,
  PutFileOptions,
  SearchOptions,
  SearchResponse,
  ActivityOptions,
  ActivityResponse,
  HealthResponse,
  SubscribeOptions,
  VaultEvent,
} from "./types.js";

export interface SeedvaultClient {
  /** GET /v1/me — resolve token to username */
  me(): Promise<MeResponse>;
  /** POST /v1/signup */
  signup(name: string, invite?: string): Promise<SignupResponse>;
  /** POST /v1/invites */
  createInvite(): Promise<InviteResponse>;
  /** GET /v1/contributors */
  listContributors(): Promise<ContributorsResponse>;
  /** DELETE /v1/contributors/:username */
  deleteContributor(username: string): Promise<void>;
  /** PUT /v1/files/:username/* */
  putFile(
    username: string,
    path: string,
    content: string,
    opts?: PutFileOptions,
  ): Promise<FileWriteResponse>;
  /** DELETE /v1/files/:username/* */
  deleteFile(username: string, path: string): Promise<void>;
  /** GET /v1/files?prefix=... */
  listFiles(prefix: string): Promise<FilesResponse>;
  /** GET /v1/files/:username/*path */
  getFile(username: string, path: string): Promise<string>;
  /** GET /v1/search?q=&contributor=&limit= */
  search(query: string, opts?: SearchOptions): Promise<SearchResponse>;
  /** GET /v1/activity?contributor=&action=&limit= */
  listActivity(opts?: ActivityOptions): Promise<ActivityResponse>;
  /** GET /health */
  health(): Promise<HealthResponse>;
  /** GET /v1/events — subscribe to real-time SSE events */
  subscribe(opts?: SubscribeOptions): AsyncGenerator<VaultEvent>;
}

/** Encode each path segment individually, preserving slashes */
function encodePath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

export function createClient(
  serverUrl: string,
  token?: string,
): SeedvaultClient {
  const base = serverUrl.replace(/\/+$/, "");

  async function request(
    method: string,
    path: string,
    opts: {
      body?: string;
      contentType?: string;
      auth?: boolean;
      extraHeaders?: Record<string, string>;
    } = {},
  ): Promise<Response> {
    const headers: Record<string, string> = {};
    if (opts.auth !== false && token) {
      headers["Authorization"] = `Bearer ${token}`;
    }
    if (opts.contentType) {
      headers["Content-Type"] = opts.contentType;
    }
    if (opts.extraHeaders) {
      Object.assign(headers, opts.extraHeaders);
    }

    const res = await fetch(`${base}${path}`, {
      method,
      headers,
      body: opts.body,
    });

    if (!res.ok) {
      let msg: string;
      try {
        const json = (await res.json()) as { error?: string };
        msg = json.error || res.statusText;
      } catch {
        msg = res.statusText;
      }
      throw new ApiError(res.status, msg);
    }

    return res;
  }

  return {
    async me(): Promise<MeResponse> {
      const res = await request("GET", "/v1/me");
      return res.json();
    },

    async signup(
      name: string,
      invite?: string,
    ): Promise<SignupResponse> {
      const body: Record<string, string> = { name };
      if (invite) body.invite = invite;
      const res = await request("POST", "/v1/signup", {
        body: JSON.stringify(body),
        contentType: "application/json",
        auth: false,
      });
      return res.json();
    },

    async createInvite(): Promise<InviteResponse> {
      const res = await request("POST", "/v1/invites");
      return res.json();
    },

    async listContributors(): Promise<ContributorsResponse> {
      const res = await request("GET", "/v1/contributors");
      return res.json();
    },

    async deleteContributor(username: string): Promise<void> {
      await request(
        "DELETE",
        `/v1/contributors/${encodeURIComponent(username)}`,
      );
    },

    async putFile(
      username: string,
      path: string,
      content: string,
      opts?: PutFileOptions,
    ): Promise<FileWriteResponse> {
      const extraHeaders: Record<string, string> = {};
      if (opts?.originCtime)
        extraHeaders["X-Origin-Ctime"] = opts.originCtime;
      if (opts?.originMtime)
        extraHeaders["X-Origin-Mtime"] = opts.originMtime;
      const res = await request(
        "PUT",
        `/v1/files/${username}/${encodePath(path)}`,
        {
          body: content,
          contentType: "text/markdown",
          extraHeaders:
            Object.keys(extraHeaders).length > 0
              ? extraHeaders
              : undefined,
        },
      );
      return res.json();
    },

    async deleteFile(username: string, path: string): Promise<void> {
      await request(
        "DELETE",
        `/v1/files/${username}/${encodePath(path)}`,
      );
    },

    async listFiles(prefix: string): Promise<FilesResponse> {
      const qs = `?prefix=${encodeURIComponent(prefix)}`;
      const res = await request("GET", `/v1/files${qs}`);
      return res.json();
    },

    async getFile(username: string, path: string): Promise<string> {
      const res = await request(
        "GET",
        `/v1/files/${username}/${encodePath(path)}`,
      );
      return res.text();
    },

    async search(
      query: string,
      opts?: SearchOptions,
    ): Promise<SearchResponse> {
      const params = new URLSearchParams({ q: query });
      if (opts?.contributor)
        params.set("contributor", opts.contributor);
      if (opts?.limit) params.set("limit", String(opts.limit));
      const res = await request("GET", `/v1/search?${params}`);
      return res.json();
    },

    async listActivity(
      opts?: ActivityOptions,
    ): Promise<ActivityResponse> {
      const params = new URLSearchParams();
      if (opts?.contributor)
        params.set("contributor", opts.contributor);
      if (opts?.action) params.set("action", opts.action);
      if (opts?.limit) params.set("limit", String(opts.limit));
      const qs = params.toString();
      const res = await request(
        "GET",
        `/v1/activity${qs ? `?${qs}` : ""}`,
      );
      return res.json();
    },

    async health(): Promise<HealthResponse> {
      const res = await request("GET", "/health", { auth: false });
      return res.json();
    },

    async *subscribe(
      opts?: SubscribeOptions,
    ): AsyncGenerator<VaultEvent> {
      const MAX_BACKOFF = 60_000;
      let backoff = 1_000;

      while (true) {
        const controller = new AbortController();
        let res: Response;

        try {
          const headers: Record<string, string> = {};
          if (token) {
            headers["Authorization"] = `Bearer ${token}`;
          }

          res = await fetch(`${base}/v1/events`, {
            headers,
            signal: controller.signal,
          });

          if (!res.ok) {
            throw new ApiError(res.status, res.statusText);
          }
        } catch {
          if (controller.signal.aborted) return;
          await new Promise((r) => setTimeout(r, backoff));
          backoff = Math.min(backoff * 2, MAX_BACKOFF);
          continue;
        }

        backoff = 1_000;

        try {
          yield* parseSSEStream(res.body!, opts, controller);
        } catch {
          if (controller.signal.aborted) return;
          await new Promise((r) => setTimeout(r, backoff));
          backoff = Math.min(backoff * 2, MAX_BACKOFF);
          continue;
        }

        // Stream ended without error (server closed) — reconnect
        if (controller.signal.aborted) return;
        await new Promise((r) => setTimeout(r, backoff));
        backoff = Math.min(backoff * 2, MAX_BACKOFF);
      }
    },
  };
}
```

Note the `listFiles` signature change: the old CLI version was `listFiles(username, prefix?)` and built the full prefix internally while stripping the username back off the results. The SDK version is `listFiles(prefix)` — caller passes the full prefix string (e.g., `"alice/"` or `"alice/notes/"`), and gets raw server paths back. This is a cleaner API that matches the server's `GET /v1/files?prefix=` directly.

**Step 5: Create `sdk/src/index.ts`**

```typescript
export { createClient, type SeedvaultClient } from "./client.js";
export { ApiError } from "./errors.js";
export type {
  MeResponse,
  SignupResponse,
  InviteResponse,
  ContributorsResponse,
  FileWriteResponse,
  FileEntry,
  PutFileOptions,
  FilesResponse,
  SearchOptions,
  SearchResult,
  SearchResponse,
  ActivityEvent,
  ActivityOptions,
  ActivityResponse,
  HealthResponse,
  SubscribeOptions,
  VaultEvent,
} from "./types.js";
```

**Step 6: Verify SDK type-checks**

Run: `cd /Users/yiliu/repos/collab-product/seedvault/sdk && bun run check`
Expected: Clean — no errors or warnings.

**Step 7: Verify SDK builds**

Run: `cd /Users/yiliu/repos/collab-product/seedvault/sdk && bun run build`
Expected: `dist/` populated with `.js` and `.d.ts` files.

**Step 8: Commit**

```bash
git add sdk/src/
git commit -m "feat(sdk): add client, types, SSE parser, and error class"
```

---

### Task 3: Migrate CLI to Import from SDK

Replace CLI's `client.ts` with re-exports from `@seedvault/sdk`. Adapt `listFiles` call sites to handle raw paths.

**Files:**
- Modify: `cli/package.json` (add SDK dependency)
- Rewrite: `cli/src/client.ts` (re-export barrel from SDK)
- Modify: `cli/src/api/client.ts` (point at SDK)
- Modify: `cli/src/api/index.ts` (point at SDK for client exports)
- Modify: `cli/src/commands/ls.ts` (adapt listFiles call)
- Modify: `cli/src/commands/kick.ts` (adapt listFiles call)
- Modify: `cli/src/daemon/syncer.ts` (adapt listFiles calls)

**Step 1: Add SDK dependency to CLI**

In `cli/package.json`, add to `dependencies`:
```json
"@seedvault/sdk": "workspace:*"
```

Run: `cd /Users/yiliu/repos/collab-product/seedvault && bun install`

**Step 2: Rewrite `cli/src/client.ts` as a re-export barrel**

Replace the entire file with:

```typescript
/**
 * Re-exports from @seedvault/sdk.
 *
 * CLI commands import from this file for convenience.
 * The actual client implementation lives in @seedvault/sdk.
 */
export {
  createClient,
  ApiError,
  type SeedvaultClient,
  type MeResponse,
  type SignupResponse,
  type InviteResponse,
  type ContributorsResponse,
  type FileWriteResponse,
  type FileEntry,
  type PutFileOptions,
  type FilesResponse,
  type SearchOptions,
  type SearchResult,
  type SearchResponse,
  type ActivityEvent,
  type ActivityOptions,
  type ActivityResponse,
  type HealthResponse,
  type SubscribeOptions,
  type VaultEvent,
} from "@seedvault/sdk";
```

**Step 3: Rewrite `cli/src/api/client.ts`**

Replace with:

```typescript
export {
  createClient,
  ApiError,
  type SeedvaultClient,
  type FileEntry,
  type PutFileOptions,
  type SearchResult,
  type SearchOptions,
  type SearchResponse,
  type ActivityEvent,
  type ActivityOptions,
  type ActivityResponse,
  type HealthResponse,
  type SubscribeOptions,
  type VaultEvent,
} from "@seedvault/sdk";
```

**Step 4: Update `cli/src/api/index.ts` client section**

Change the Client section (lines 37-53) from importing `"./client.js"` to importing `"@seedvault/sdk"`:

```typescript
// Client
export { createClient, ApiError } from "@seedvault/sdk";

export type {
  SeedvaultClient,
  FileEntry,
  PutFileOptions,
  SearchResult,
  SearchOptions,
  SearchResponse,
  ActivityEvent,
  ActivityOptions,
  ActivityResponse,
  HealthResponse,
  SubscribeOptions,
  VaultEvent,
} from "@seedvault/sdk";
```

**Step 5: Adapt `cli/src/commands/ls.ts` for raw paths**

The SDK's `listFiles(prefix)` now takes a full prefix and returns raw server paths. Change line 27:

Old:
```typescript
const { files } = await client.listFiles(username, prefix);
```

New:
```typescript
const fullPrefix = prefix ? `${username}/${prefix}` : `${username}/`;
const { files } = await client.listFiles(fullPrefix);
```

The `f.path` values now include the username prefix (e.g., `"alice/notes/hello.md"`). Since `ls` prints paths, strip the username prefix before printing. Change lines 28-30:

Old:
```typescript
for (const f of files) {
  console.log(f.path);
}
```

New:
```typescript
const stripPrefix = `${username}/`;
for (const f of files) {
  const display = f.path.startsWith(stripPrefix)
    ? f.path.slice(stripPrefix.length)
    : f.path;
  console.log(display);
}
```

**Step 6: Adapt `cli/src/commands/kick.ts` for raw paths**

Find the `listFiles` call (around line 30):

Old:
```typescript
const { files } = await client.listFiles(username);
```

New:
```typescript
const { files } = await client.listFiles(`${username}/`);
```

The `files.length` count is used for confirmation — path format doesn't matter here.

**Step 7: Adapt `cli/src/daemon/syncer.ts` for raw paths**

The syncer has 4 `listFiles` calls. All follow the same pattern — change from `(username, prefix?)` to `(fullPrefix)` and strip the username prefix from results.

Add a helper at the top of the class (or as a module-level function):

```typescript
/** Strip the username/ prefix from server paths for local comparison */
function stripUserPrefix(
  files: FileEntry[],
  username: string,
): FileEntry[] {
  const prefix = `${username}/`;
  return files.map((f) => ({
    ...f,
    path: f.path.startsWith(prefix)
      ? f.path.slice(prefix.length)
      : f.path,
  }));
}
```

Then update each call site:

1. `purgeOrphans` (around line 77):
   ```typescript
   // Old: await this.client.listFiles(this.username);
   const { files: raw } = await this.client.listFiles(`${this.username}/`);
   const allServerFiles = stripUserPrefix(raw, this.username);
   ```

2. `syncCollection` first call (around line 122):
   ```typescript
   // Old: await this.client.listFiles(this.username, collection.name + "/");
   const { files: raw } = await this.client.listFiles(
     `${this.username}/${collection.name}/`,
   );
   const serverFiles = stripUserPrefix(raw, this.username);
   ```

3. The other `listFiles` calls in the same file follow the same pattern.

**Step 8: Verify CLI type-checks**

Run: `cd /Users/yiliu/repos/collab-product/seedvault/cli && bun run check`
Expected: Clean — no errors or warnings.

**Step 9: Commit**

```bash
git add cli/
git commit -m "refactor(cli): import client from @seedvault/sdk"
```

---

### Task 4: Update Existing Tests to Import from SDK

4 test files import from `../cli/src/client.js`. Update them to import from the SDK.

**Files:**
- Modify: `test/subscribe.test.ts`
- Modify: `test/auth-and-access.test.ts`
- Modify: `test/integration.test.ts`
- Modify: `test/queue.test.ts`

**Step 1: Update imports in all 4 test files**

In each file, change imports from `"../cli/src/client.js"` to `"../sdk/src/index.js"`:

`test/subscribe.test.ts` line 2:
```typescript
// Old: import { createClient, type VaultEvent } from "../cli/src/client.js";
import { createClient, type VaultEvent } from "../sdk/src/index.js";
```

`test/auth-and-access.test.ts` line ~21:
```typescript
// Old: import { ... } from "../cli/src/client.js";
import { ... } from "../sdk/src/index.js";
```

`test/integration.test.ts` line ~22:
```typescript
// Old: import { createClient, type SeedvaultClient, ApiError } from "../cli/src/client.js";
import { createClient, type SeedvaultClient, ApiError } from "../sdk/src/index.js";
```

`test/queue.test.ts` line ~3:
```typescript
// Old: import { ApiError } from "../cli/src/client.js";
import { ApiError } from "../sdk/src/index.js";
```

**Step 2: Update test `listFiles` calls for new signature**

Check each test file for `listFiles` calls and update from `(username, prefix?)` to `(fullPrefix)`. The integration/auth tests likely call `listFiles` — update the arguments and adjust assertions for raw (non-stripped) paths.

Read each test file carefully before editing. The exact changes depend on how tests use `listFiles`.

**Step 3: Run all tests**

Run: `cd /Users/yiliu/repos/collab-product/seedvault && bun test test/`
Expected: All tests pass.

**Step 4: Run full workspace type-check**

Run: `cd /Users/yiliu/repos/collab-product/seedvault && bun run check`
Expected: Clean across SDK, CLI, and server.

**Step 5: Commit**

```bash
git add test/
git commit -m "test: update imports to use @seedvault/sdk"
```

---

### Task 5: Clean Up CLI's Original client.ts

Now that the CLI re-exports from the SDK and all tests import from the SDK, the CLI's `client.ts` is just a barrel file. Verify nothing imports the old implementation directly, then confirm the re-export barrel is minimal and correct.

**Files:**
- Verify: `cli/src/client.ts` (should be the re-export barrel from Task 3)

**Step 1: Verify no stale imports remain**

Run: `cd /Users/yiliu/repos/collab-product/seedvault && rg 'from.*["\x27]\.\./client\.js["\x27]' cli/src/`

Confirm all CLI command files still import from `"../client.js"` (which is the re-export barrel) — this is fine and expected. The barrel re-exports from `@seedvault/sdk`.

**Step 2: Run full test suite one more time**

Run: `cd /Users/yiliu/repos/collab-product/seedvault && bun test test/`
Expected: All pass.

**Step 3: Run full workspace check**

Run: `cd /Users/yiliu/repos/collab-product/seedvault && bun run check`
Expected: Clean.

**Step 4: Verify SDK builds clean**

Run: `cd /Users/yiliu/repos/collab-product/seedvault/sdk && bun run build && ls dist/`
Expected: `client.js`, `client.d.ts`, `errors.js`, `errors.d.ts`, `index.js`, `index.d.ts`, `sse.js`, `sse.d.ts`, `types.js`, `types.d.ts`

**Step 5: Final commit (if any cleanup was needed)**

```bash
git add -A
git commit -m "chore: clean up after SDK extraction"
```

---

### Task Summary

| Task | What | Key Risk |
|------|------|----------|
| 1 | Scaffold SDK package | None — boilerplate |
| 2 | Create SDK source files | `listFiles` signature change — must match server API exactly |
| 3 | Migrate CLI imports | Syncer has 4 `listFiles` call sites that need path adaptation |
| 4 | Update test imports | Tests may assert on stripped paths — need to update expectations |
| 5 | Clean up and verify | None — verification only |
