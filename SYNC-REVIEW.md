# Seedvault Sync Review — Gap Analysis

**Date:** 2026-02-24
**Scope:** End-to-end sync flow (local → server → web UI), data integrity, SDK correctness
**Codebase version:** as of commit at review time

---

## Executive Summary

Seedvault's sync architecture is straightforward: a chokidar-based watcher detects local `.md` file changes, debounces them, and pushes them through a retry queue to the server. A periodic reconciliation loop catches anything the watcher missed. The server stores content in SQLite with FTS5 indexing, and broadcasts changes via SSE to the web UI.

The design is sound for its intended use case (small-to-medium markdown file collections for a single contributor per device). However, several gaps could cause silent data loss, stale UI state, or sync failures under real-world conditions.

**Critical findings:** 3 | **Important findings:** 10 | **Minor findings:** 9

---

## 1. Local → Server Sync Failures

### CRITICAL-1: Retry queue is in-memory only — crash/restart loses pending operations

**Files:** `client/src/daemon/queue.ts` (entire file), `client/src/daemon/syncer.ts:195`

The `RetryQueue` stores all pending operations in a plain array (`this.items`). The `stop()` method (line 52) just clears the flush timer but does **not** persist pending operations. If the daemon crashes, is killed, or the machine restarts while operations are queued (e.g., during a network outage), all pending changes are silently lost.

The comment on `syncer.ts:195` acknowledges this: *"Pending ops remain in memory for process lifetime only."*

The 5-minute reconciliation loop (`sync.ts`, `DEFAULT_RECONCILE_INTERVAL`) will eventually catch up, but only for files that still exist locally. If a file was deleted locally, queued for deletion on the server, and the daemon crashes before flushing — the server retains a stale file permanently (until the next reconciliation loop compares and re-queues the delete, which it does correctly in `initialSync`).

**Impact:** Data desync after daemon restart during network outage. Deleted files may reappear on server.

**Mitigation:** The reconciliation loop (`sync.ts:199-214`) does run `initialSync()` every 5 minutes, which compares local vs server and re-queues missing deletes. So the window of inconsistency is bounded to 5 minutes after restart, assuming the daemon restarts. This significantly limits the practical impact, but the window still exists.

---

### CRITICAL-2: Race condition between debounced write and file deletion

**File:** `client/src/daemon/syncer.ts:170-193`

When a file is modified and then quickly deleted (within 300ms), the sequence is:

1. `change` event fires → debounce timer set (300ms)
2. `unlink` event fires → pending timer cancelled, DELETE queued immediately

This is handled correctly (lines 180-185 cancel the pending write). However, the **reverse race** is dangerous:

1. File deleted → DELETE queued immediately
2. File recreated (e.g., by an editor doing atomic save: delete + create) → `add` event fires → debounce timer set
3. DELETE flushes from queue before the debounced PUT fires
4. PUT fires 300ms later, uploads the file

This sequence works correctly in the happy path. But consider:

1. File modified → debounce timer set (300ms)
2. File modified again at 200ms → timer reset
3. File deleted at 250ms → timer cancelled, DELETE queued
4. At this point `syncWrite` never fires — correct.

The actual problem: `syncWrite` (line 188) reads the file at debounce-fire time. If the file was **replaced** (not deleted) between the event and the debounce firing, it uploads the **new** content with the **old** event's trigger. This is mostly fine, but the `stat()` call at line 189 will get the new file's timestamps, not the timestamps from when the change event fired. For rapid-fire saves from editors like VS Code that do write-to-temp → rename, the `awaitWriteFinish` option in chokidar (watcher.ts:52-55) should handle this, but it adds another 300ms+ of latency on top of the syncer's own 300ms debounce.

**Impact:** ~600ms total debounce means very rapid file changes (e.g., from scripts writing multiple files) will coalesce, which is generally desired. But it also means the daemon may miss intermediate states. For a sync tool, this is usually acceptable.

---

### CRITICAL-3: `readFile` with `utf-8` encoding silently mangles binary/non-UTF-8 content

**File:** `client/src/daemon/syncer.ts:131, 190`

Both `initialSync` (line 131) and `syncWrite` (line 190) read files with `readFile(localPath, "utf-8")`. If a `.md` file contains non-UTF-8 byte sequences (e.g., a file was accidentally saved with Latin-1 encoding, or contains embedded binary data), Node/Bun's UTF-8 decoder will replace invalid bytes with U+FFFD (replacement character), **silently corrupting the content** before uploading.

The server also enforces `.md` extension only (validation in `db.ts:108`), so binary files won't be synced. But encoding corruption in text files is a real risk.

**Impact:** Silent content corruption for non-UTF-8 encoded markdown files. The user would not be notified.

---

### IMPORTANT-1: `walkMd` skips all dotfiles/dotdirs, including `.obsidian` references

**File:** `client/src/daemon/syncer.ts:232`

`walkDirRecursive` skips any entry where `entry.name.startsWith(".")`. This is intentional for `.git`, `.DS_Store`, etc. But it also means:
- Files like `.todo.md` or `.private-notes.md` will never sync
- The watcher (`watcher.ts:39`) has the same exclusion

This is a design choice, but it's undocumented and could surprise users.

**Impact:** User confusion when dotfiles don't sync. Low severity since this is consistent between watcher and walker.

---

### IMPORTANT-2: Symlinks are silently skipped

**File:** `client/src/daemon/syncer.ts:235`

`walkDirRecursive` only processes entries where `entry.isFile()` returns true. Symlinks return false for `isFile()` (they return true for `isSymbolicLink()`). So symlinked `.md` files are silently ignored during initial sync and reconciliation.

The watcher (chokidar) **does** follow symlinks by default, so a change to a symlinked file would trigger a watcher event, but the file wouldn't be found by `walkMd` during reconciliation, potentially causing it to be deleted from the server.

**Impact:** Symlinked files may oscillate between being uploaded (via watcher) and deleted (via reconciliation). This is a correctness bug.

---

### IMPORTANT-3: No handling of permission errors during walk

**File:** `client/src/daemon/syncer.ts:228-239`

`walkDirRecursive` does not catch errors from `readdir` or `stat`. If any directory or file is unreadable (permission denied), the entire `walkMd` call throws, which propagates to `syncCollection` and is caught at line 157 with a generic log message. This means a single unreadable file **aborts the entire collection sync**, skipping all remaining files.

**Impact:** One permission-denied file blocks sync of the entire collection.

---

### IMPORTANT-4: Rename detection — renames are delete + create, losing server-side history

**Files:** `client/src/daemon/syncer.ts`, `client/src/daemon/watcher.ts`

File renames produce an `unlink` event followed by an `add` event. The daemon handles this as DELETE old path + PUT new path. This works correctly for sync, but:
- The server has no concept of renames — the old file is deleted and a new one created
- The `created_at` timestamp on the server resets to the new file's ctime
- Activity log shows a delete + create, not a rename

This is a design limitation, not a bug. But it could confuse users reviewing activity.

---

### IMPORTANT-5: Initial sync timestamp comparison uses server `modifiedAt` vs local `mtimeMs`

**File:** `client/src/daemon/syncer.ts:127-130`

```typescript
const serverDate = new Date(serverEntry.modifiedAt).getTime();
const localDate = localFile.mtimeMs;
if (localDate <= serverDate) {
  skipped++;
  continue;
}
```

The server's `modifiedAt` comes from the `originMtime` header sent during the last upload, which is the local file's mtime at upload time. But if the server's clock and client's clock are skewed, or if the file was modified by the web UI (which sets `modifiedAt` to `now`), this comparison can go wrong:

- If a file is edited via the web UI, its `modifiedAt` will be the server's current time
- If the client's clock is behind the server's, the local file's `mtimeMs` will be less than the server's `modifiedAt`, and the local change will be **skipped**

**Impact:** Clock skew between client and server can cause local changes to be silently skipped during initial sync.

---

### MINOR-1: Empty directories are not synced

**Files:** `client/src/daemon/syncer.ts:235`, `server/src/db.ts`

The server only stores files (items table has contributor + path + content). Empty directories cannot be represented. `walkMd` only collects files. This is by design but worth noting — if a user creates an empty collection directory, it won't appear on the server or web UI.

---

### MINOR-2: Files with `.tmp.` in their name are ignored by watcher but not by walker

**File:** `client/src/daemon/watcher.ts:40` vs `client/src/daemon/syncer.ts:228-239`

The watcher ignores files matching `.tmp.` in any segment. But `walkDirRecursive` only skips dotfiles and `node_modules`. So during initial sync/reconciliation, a file like `notes.tmp.md` would be uploaded, but subsequent changes would be ignored by the watcher.

**Impact:** Inconsistent behavior between initial sync and live watching for `.tmp.` files.

---

### MINOR-3: `awaitWriteFinish` adds latency and may not work for all editors

**File:** `client/src/daemon/watcher.ts:52-55`

The `stabilityThreshold: 300` with `pollInterval: 100` means chokidar waits for 300ms of no file size changes before emitting the event. Combined with the syncer's own 300ms debounce, the minimum latency from save to upload is ~600ms. For editors that write large files slowly (e.g., over a network mount), this threshold might fire prematurely.

---

## 2. Server → Web UI Display Failures

### CRITICAL (addressed as IMPORTANT due to Web UI being non-critical path): SSE has no event IDs, so reconnection replays nothing

**Files:** `server/src/sse.ts`, `server/src/routes.ts:185-209`

The SSE implementation does not include `id:` fields in events. The browser's `EventSource` auto-reconnects on disconnect, but without `Last-Event-ID`, it cannot resume from where it left off. Any events that occurred during the disconnect window are silently lost.

The web UI partially mitigates this because `file_updated` events trigger a full re-fetch of the file listing (via `scheduleContributorReload`). But there's a window where:

1. SSE disconnects
2. File is updated on server
3. SSE reconnects
4. No `file_updated` event is received for the change that happened during disconnect
5. UI shows stale data until the next change triggers a refresh

### IMPORTANT-6: No full refresh on SSE reconnection

**File:** `server/src/index.html` (JS, ~line 540+)

The `EventSource.onerror` handler is empty:
```javascript
evtSource.onerror = () => {
    // EventSource auto-reconnects
};
```

On reconnection, the UI should perform a full refresh of the file list and currently-displayed file to catch any events missed during the disconnect. Currently it does nothing, relying on future events to trigger updates.

**Impact:** Stale UI state after network interruptions until the next file change.

---

### IMPORTANT-7: File content displayed via `innerHTML` with DOMPurify, but path/title use `textContent`/`escapeHtml` inconsistently

**File:** `server/src/index.html`

The markdown rendering pipeline is:
1. `gray-matter` parses frontmatter
2. `marked` renders markdown to HTML
3. `DOMPurify.sanitize` cleans the HTML
4. Result is assigned to `contentEl.innerHTML`

This is safe for the content body. But in the file tree rendering (`renderTree` function), file names are inserted via string concatenation into `innerHTML`:
```javascript
row.innerHTML = '...<i class="ph ph-file-text"></i> ' + key + '</span>...'
```

The `key` here is a path segment from the server. If a file path contains HTML-special characters like `<` or `"`, this could break the tree rendering (though not a true XSS risk since the server validates paths — they must end in `.md` and can't contain `\`). However, a filename like `notes<script>.md` would break the HTML structure.

**Impact:** Broken file tree rendering for files with HTML special characters in names. Not a security issue due to server-side path validation, but a display bug.

---

### IMPORTANT-8: Web UI loads entire file content into memory

**File:** `server/src/index.html`, `server/src/routes.ts:164-180`

The server allows files up to 10MB (`MAX_CONTENT_SIZE` in `db.ts:258`). The web UI fetches the entire file content and renders it as markdown. For very large files (e.g., 5-10MB of markdown), this could freeze the browser tab due to:
- `marked.parse()` on a massive string
- `DOMPurify.sanitize()` on the resulting HTML
- DOM insertion of thousands of elements

There's no pagination, truncation, or lazy loading.

**Impact:** Browser tab freeze/crash for very large markdown files.

---

### IMPORTANT-9: Web UI uses `localStorage` for token storage

**File:** `server/src/index.html` (JS)

The API token is stored in `localStorage.getItem("sv-token")`. This is accessible to any JavaScript running on the same origin, making it vulnerable to XSS. The DOMPurify sanitization mitigates this for markdown content, but if a bypass is found, the token is exposed.

Additionally, the SSE connection passes the token as a query parameter:
```javascript
evtSource = new EventSource("/v1/events?token=" + encodeURIComponent(token));
```

This means the token appears in server access logs and potentially in browser history.

**Impact:** Token exposure via query strings in logs. Standard concern for SSE auth.

---

### MINOR-4: `CSS.escape` used for querySelector but not universally available

**File:** `server/src/index.html` (JS, `markActiveRow` function)

```javascript
const active = filesEl.querySelector(
    '.tree-row[data-contributor="' + CSS.escape(activeContributor) + '"]...'
);
```

`CSS.escape` is well-supported in modern browsers, but if a very old browser is used, this will throw. Minor concern.

---

### MINOR-5: Activity modal fetches 1000 events at once

**File:** `server/src/index.html` (JS, `ACTIVITY_PAGE_SIZE = 1000`)

The activity modal loads 1000 events per page. Each event includes a diff (up to 5KB). This could mean fetching up to 5MB of JSON in one request, potentially slow on mobile connections.

---

### MINOR-6: `morphdom` used for file tree but no keying on file entries

**File:** `server/src/index.html` (JS, `loadSelectedContributor`)

The `morphdom` call uses `node.dataset?.key` for keying. This is set on `<li>` elements via `li.dataset.key = nodePath`. This should work correctly for tree diffing. However, the `getNodeKey` function returns empty string for nodes without a key, which means morphdom may not correctly match nodes that lack the `key` attribute (e.g., the inner `<div>` and `<span>` elements).

---

## 3. Server-Side Data Integrity

### IMPORTANT-10: No transaction wrapping for upsert + activity log + SSE broadcast

**File:** `server/src/routes.ts:130-170`

The file write handler does:
1. `getItem()` — read existing content (for diff)
2. `upsertItem()` — write new content
3. `createActivityEvent()` — log activity
4. `broadcast()` — SSE notification

Steps 2 and 3 are separate SQL statements without a transaction. If the server crashes between step 2 and 3, the file is updated but no activity event is logged. This is a minor consistency issue.

More importantly, there's **no locking or transaction isolation** between concurrent writes to the same file. Two concurrent PUT requests for the same path will both:
1. Read the existing content (both get the same `existing`)
2. Upsert (last writer wins via SQLite's `ON CONFLICT DO UPDATE`)
3. Compute diff against the (now stale) `existing` content

The diff in the activity log for the second write will be computed against the original content, not the first write's content. The final file state is correct (last writer wins), but the activity log's diff is misleading.

**Impact:** Activity log diffs may be incorrect under concurrent writes. File content itself is safe (SQLite serializes writes).

---

### IMPORTANT-11: `deleteContributor` is not transactional

**File:** `server/src/db.ts:152-162`

```typescript
export function deleteContributor(username: string): boolean {
  const d = getDb();
  d.prepare("DELETE FROM activity WHERE contributor = ?").run(username);
  d.prepare("DELETE FROM items WHERE contributor = ?").run(username);
  d.prepare("DELETE FROM api_keys WHERE contributor = ?").run(username);
  // ...
  d.prepare("DELETE FROM contributors WHERE username = ?").run(username);
  return true;
}
```

This performs 5+ separate DELETE statements without wrapping them in a transaction. If the server crashes mid-deletion, the database will be in an inconsistent state (e.g., items deleted but contributor record still exists, or api_keys deleted but items remain).

**Impact:** Partial contributor deletion on crash. The contributor may be left in an inconsistent state.

---

### IMPORTANT-12: FTS5 index can become inconsistent

**File:** `server/src/db.ts:57-78`

The FTS5 content-sync triggers (`items_ai`, `items_ad`, `items_au`) keep the FTS index in sync with the `items` table. However, if these triggers were to fail (e.g., FTS index corruption), subsequent searches would return stale or incorrect results with no error surfaced to the user.

Additionally, the FTS5 `content=items` means the FTS table doesn't store its own copy of the content — it relies on the `items` table via `content_rowid=rowid`. If the SQLite rowid changes (which shouldn't happen in normal operation but could after a `VACUUM`), the FTS index would break.

**Impact:** Low probability, but FTS corruption would silently break search.

---

### MINOR-7: `searchItems` passes user input directly to FTS5 MATCH

**File:** `server/src/db.ts:292-293`

```typescript
WHERE items_fts MATCH ?
```

FTS5 MATCH accepts a query syntax (e.g., `AND`, `OR`, `NOT`, `NEAR`, column filters). If a user passes a malformed FTS5 query (e.g., an unmatched quote), SQLite will throw an error. The routes handler doesn't catch this specifically:

```typescript
// routes.ts search handler has no try/catch
const results = searchItems(q, contributorParam, limit);
return c.json({ results });
```

This would result in a 500 error returned to the client.

**Impact:** Unhandled FTS5 syntax errors cause 500 responses. Not a data integrity issue, but a usability bug.

---

### MINOR-8: `listItems` uses `LIKE` with unescaped prefix

**File:** `server/src/db.ts:278`

```typescript
.all(contributor, prefix + "%") as typeof rows;
```

If the prefix contains SQL LIKE wildcards (`%` or `_`), the query will match unintended paths. For example, a prefix of `notes_` would match `notes_/file.md` but also `notesX/file.md` due to `_` being a single-character wildcard.

In practice, the prefix comes from the collection name which is validated, but the server-side path validation (`validatePath`) doesn't check for `%` or `_` characters.

**Impact:** Unlikely in practice due to path validation, but technically incorrect.

---

## 4. SDK Correctness

### IMPORTANT-13: `putFile` doesn't encode username in URL path

**File:** `sdk/src/client.ts:131`

```typescript
const res = await request(
    "PUT",
    `/v1/files/${username}/${encodePath(path)}`,
    ...
);
```

The `username` is inserted directly into the URL without `encodeURIComponent`. If a username contained URL-special characters (e.g., spaces, `#`, `?`), the URL would be malformed. The server validates usernames to be lowercase alphanumeric with hyphens (`/^[a-z0-9][a-z0-9-]*[a-z0-9]$/`), so this is currently safe, but it's a latent bug if validation rules change.

The same applies to `deleteFile` (line 142), `getFile` (line 150).

**Impact:** Safe due to server-side validation, but fragile if username rules change.

---

### IMPORTANT-14: SDK `subscribe()` doesn't reset backoff on successful stream read

**File:** `sdk/src/client.ts:188-219`

```typescript
backoff = 1_000;  // Reset after successful connection

try {
    yield* parseSSEStream(res.body!, opts, controller);
} catch {
    ...
    backoff = Math.min(backoff * 2, MAX_BACKOFF);
    continue;
}

// Stream ended without error — reconnect
...
backoff = Math.min(backoff * 2, MAX_BACKOFF);
```

When the stream ends without error (server closed the connection gracefully), the backoff **increases**. This means repeated clean disconnects (e.g., server deploying) will ramp up the reconnection delay to 60 seconds. The backoff is only reset on successful connection (line 195), not on successful data reception.

**Impact:** Reconnection delay increases even for clean server restarts. Users may see up to 60s of staleness after a server deployment.

---

### MINOR-9: `parseSSEStream` doesn't handle `data:` lines without the space

**File:** `sdk/src/sse.ts:19-20`

Per the SSE spec, `data:hello` (no space after colon) is valid and equivalent to `data: hello`. The parser only checks for `line.startsWith("data: ")`, so `data:hello` would be ignored.

Similarly, `event:type` (no space) is valid but would not be parsed by `line.startsWith("event: ")`.

**Impact:** Non-conformant SSE parsing. The Seedvault server always includes the space, so this only matters for compatibility with other SSE servers.

---

## 5. Cross-Cutting Concerns

### Design Observation: No conflict resolution

The system is designed as a push-only sync (local → server). There's no mechanism for:
- Server → local sync (pulling changes made via another client or the web UI)
- Conflict detection when two clients modify the same file
- Last-writer-wins is the implicit policy, with no notification to the losing writer

This is acknowledged in the design but worth noting for users who expect bidirectional sync.

### Design Observation: Reconciliation interval is hardcoded

The 5-minute reconciliation interval (`DEFAULT_RECONCILE_INTERVAL = 5 * 60 * 1000` in `sync.ts`) is not configurable. For use cases with unreliable file watchers (e.g., network-mounted filesystems where inotify doesn't work), users might want a shorter interval.

### Design Observation: SQLite WAL mode is good

The server correctly uses `PRAGMA journal_mode = WAL` (`db.ts:12`), which allows concurrent reads during writes. This is the right choice for a web server with SSE connections reading while the API writes.

---

## Summary Table

| ID | Severity | Area | Summary |
|----|----------|------|---------|
| CRITICAL-1 | Critical | Client/Queue | In-memory retry queue loses ops on crash |
| CRITICAL-2 | Critical | Client/Syncer | Race condition edge cases in debounce timing |
| CRITICAL-3 | Critical | Client/Syncer | UTF-8 readFile silently corrupts non-UTF-8 content |
| IMPORTANT-1 | Important | Client/Syncer | Dotfiles silently excluded (undocumented) |
| IMPORTANT-2 | Important | Client/Syncer | Symlinks silently skipped, causes oscillation with watcher |
| IMPORTANT-3 | Important | Client/Syncer | One permission error aborts entire collection sync |
| IMPORTANT-4 | Important | Client/Syncer | Renames lose server-side history |
| IMPORTANT-5 | Important | Client/Syncer | Clock skew can cause local changes to be skipped |
| IMPORTANT-6 | Important | Web UI/SSE | No full refresh on SSE reconnection |
| IMPORTANT-7 | Important | Web UI | File names not HTML-escaped in tree rendering |
| IMPORTANT-8 | Important | Web UI | Large files can freeze browser |
| IMPORTANT-9 | Important | Web UI/Auth | Token in localStorage and query strings |
| IMPORTANT-10 | Important | Server/DB | No transaction wrapping for write + activity log |
| IMPORTANT-11 | Important | Server/DB | deleteContributor not transactional |
| IMPORTANT-12 | Important | Server/DB | FTS5 index corruption risk |
| IMPORTANT-13 | Important | SDK | Username not URL-encoded in API paths |
| IMPORTANT-14 | Important | SDK/SSE | Backoff increases on clean disconnects |
| MINOR-1 | Minor | Client | Empty directories not represented |
| MINOR-2 | Minor | Client | `.tmp.` filter inconsistent between watcher and walker |
| MINOR-3 | Minor | Client | 600ms minimum sync latency |
| MINOR-4 | Minor | Web UI | CSS.escape browser compat |
| MINOR-5 | Minor | Web UI | 1000 activity events per page |
| MINOR-6 | Minor | Web UI | morphdom keying for inner nodes |
| MINOR-7 | Minor | Server | FTS5 query syntax errors cause 500 |
| MINOR-8 | Minor | Server | LIKE wildcards in prefix query |
| MINOR-9 | Minor | SDK | SSE parser non-spec-compliant for no-space format |

---

## Recommended Priority Fixes

1. **Persist the retry queue to disk** (CRITICAL-1) — write pending ops to a JSON file in the config dir, reload on startup
2. **Wrap `deleteContributor` in a transaction** (IMPORTANT-11) — trivial fix with `db.transaction()`
3. **Add error handling in `walkDirRecursive`** (IMPORTANT-3) — catch per-entry errors, log and continue
4. **Refresh UI on SSE reconnect** (IMPORTANT-6) — add a `loadSelectedContributor` call in the `onerror` handler after reconnection
5. **HTML-escape file names in tree** (IMPORTANT-7) — use `escapeHtml(key)` in `renderTree`
6. **Handle symlinks in walker** (IMPORTANT-2) — use `stat` instead of `lstat` or explicitly resolve symlinks
7. **Add try/catch around FTS5 search** (MINOR-7) — return 400 for malformed queries
8. **Reset backoff on successful stream data** (IMPORTANT-14) — track last successful event time
