# Collaborator Electron App Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build an Electron desktop app that combines a local-first markdown editor, a Seedvault vault browser, and an OpenClaw AI chat panel into a single "Collaborator" experience.

**Architecture:** The app is a thin Electron shell with React renderer. Local files are read/written directly on the filesystem; remote contributor files come from the Seedvault HTTP API. Chat connects to OpenClaw via WebSocket. The bundled `@seedvault/cli` daemon runs as a managed child process for syncing local files to the server. All network/filesystem access goes through Electron main process IPC — the renderer is fully sandboxed.

**Tech Stack:** Electron 38+, React 19, Vite 7, BlockNote 0.46, Tailwind 4, Mantine, TypeScript 5.7+, vitest

**Repo:** Standalone repo at `/Users/yiliu/repos/collaborator` (sibling to `seedvault/` and `openclaw/`). Pulls in `@seedvault/cli` as an npm dependency for daemon management.

**Reference codebases:**
- `/Users/yiliu/repos/seedvault` — Seedvault server (HTTP API, SSE, auth model)
- `/Users/yiliu/repos/seedvault3` — UI design reference (BlockNote editor, multi-window Electron patterns)
- `/Users/yiliu/repos/openclaw` — OpenClaw gateway (WebSocket protocol, JSON-RPC frames)

**Key files to study before starting:**
- `seedvault/server/src/routes.ts` — Seedvault API endpoints
- `seedvault/server/src/sse.ts` — SSE event format
- `seedvault/cli/src/client.ts` — Seedvault HTTP client (reuse patterns)
- `seedvault3/src/windows/viewer/src/components/Editor.tsx` — BlockNote integration reference
- `openclaw/src/gateway/` — WebSocket protocol (connect, auth, frames)

---

## Task 1: Project Scaffolding

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `tsconfig.node.json`
- Create: `tsconfig.web.json`
- Create: `electron.vite.config.ts`
- Create: `src/main/index.ts`
- Create: `src/preload/index.ts`
- Create: `src/renderer/index.html`
- Create: `src/renderer/src/main.tsx`
- Create: `src/renderer/src/App.tsx`

> This is a standalone repo at `/Users/yiliu/repos/collaborator`. It depends on `@seedvault/cli` via npm for daemon management.

**Step 1: Initialize the project**

```bash
mkdir -p /Users/yiliu/repos/collaborator/src/{main,preload,renderer/src}
cd /Users/yiliu/repos/collaborator
git init
```

Create `package.json`:

```json
{
  "name": "collaborator",
  "version": "0.1.0",
  "type": "module",
  "main": "dist/main/index.js",
  "scripts": {
    "dev": "electron-vite dev",
    "build": "electron-vite build",
    "preview": "electron-vite preview",
    "test": "vitest run",
    "test:watch": "vitest",
    "lint": "oxlint src/",
    "typecheck": "tsc --noEmit"
  }
}
```

**Step 2: Install dependencies**

```bash
# Look up current stable versions before running. Pin exact versions.
pnpm add electron electron-vite react react-dom @mantine/core @blocknote/core @blocknote/react @blocknote/mantine @tabler/icons-react @seedvault/cli chokidar ws yaml
pnpm add -D typescript vite @vitejs/plugin-react vitest @testing-library/react @testing-library/jest-dom jsdom oxlint @types/react @types/react-dom @types/ws
```

Note: `@seedvault/cli` is used for daemon management (spawning `sv start`/`sv stop`). The binary path is resolved from the installed package.

**Step 3: Create TypeScript configs**

`tsconfig.json` — project root references:
```json
{
  "files": [],
  "references": [
    { "path": "./tsconfig.node.json" },
    { "path": "./tsconfig.web.json" }
  ]
}
```

`tsconfig.node.json` — main + preload (Node environment):
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "noImplicitOverride": true,
    "verbatimModuleSyntax": true,
    "isolatedModules": true,
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src/main/**/*", "src/preload/**/*"]
}
```

`tsconfig.web.json` — renderer (browser environment):
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "noImplicitOverride": true,
    "verbatimModuleSyntax": true,
    "isolatedModules": true,
    "outDir": "dist",
    "rootDir": "src/renderer"
  },
  "include": ["src/renderer/**/*"]
}
```

**Step 4: Create electron-vite config**

`electron.vite.config.ts`:
```ts
import { defineConfig } from "electron-vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  main: {
    build: {
      outDir: "dist/main",
    },
  },
  preload: {
    build: {
      outDir: "dist/preload",
    },
  },
  renderer: {
    plugins: [react()],
    build: {
      outDir: "dist/renderer",
    },
  },
});
```

**Step 5: Create main process entry**

`src/main/index.ts`:
```ts
import { app, BrowserWindow } from "electron";
import path from "node:path";

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.js"),
      sandbox: true,
      contextIsolation: true,
    },
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    win.loadFile(path.join(__dirname, "../renderer/index.html"));
  }

  return win;
}

app.whenReady().then(() => {
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
```

**Step 6: Create preload script**

`src/preload/index.ts`:
```ts
import { contextBridge } from "electron";

contextBridge.exposeInMainWorld("collaborator", {
  platform: process.platform,
});
```

**Step 7: Create renderer entry**

`src/renderer/index.html`:
```html
<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Collaborator</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="./src/main.tsx"></script>
  </body>
</html>
```

`src/renderer/src/main.tsx`:
```tsx
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";

const root = document.getElementById("root");
if (!root) throw new Error("Root element not found");
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
```

`src/renderer/src/App.tsx`:
```tsx
export function App() {
  return <div>Collaborator</div>;
}
```

**Step 8: Verify it runs**

```bash
cd /Users/yiliu/repos/collaborator
pnpm run dev
```

Expected: Electron window opens showing "Collaborator".

**Step 9: Commit**

```bash
git add -A
git commit -m "feat: scaffold Electron + React + Vite app"
```

---

## Task 2: IPC Layer & Shared Types

**Files:**
- Create: `src/shared/types.ts`
- Create: `src/shared/ipc-channels.ts`
- Modify: `src/preload/index.ts`
- Create: `src/renderer/src/types.ts`

> Defines the typed IPC contract between main and renderer. Every operation the renderer needs goes through these channels.

**Step 1: Define shared types**

`src/shared/types.ts`:
```ts
/** A file in the vault, regardless of source */
export interface VaultItem {
  /** Unique path within the vault: "contributor/path/to/file.md" */
  path: string;
  /** The contributor who owns this file */
  contributor: string;
  /** File title (from frontmatter or filename) */
  title: string;
  /** Raw markdown content */
  content: string;
  /** Whether the current user owns this file (editable) */
  owned: boolean;
  /** Last modified timestamp (ISO string) */
  modified: string;
  /** Created timestamp (ISO string) */
  created: string;
}

/** Tree node for the vault browser */
export interface FileTreeNode {
  name: string;
  path: string;
  type: "file" | "directory" | "contributor";
  children?: FileTreeNode[];
  owned: boolean;
}

/** Chat message in the OpenClaw conversation */
export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  timestamp: string;
}

/** App configuration */
export interface CollaboratorConfig {
  seedvaultUrl: string;
  seedvaultToken: string;
  openclawUrl: string;
  openclawToken: string;
  localDirs: string[];
  contributor: string;
}

/** Connection status for external services */
export type ConnectionStatus = "connected" | "connecting" | "disconnected" | "error";
```

**Step 2: Define IPC channels**

`src/shared/ipc-channels.ts`:
```ts
export const IPC = {
  // Local files
  FILES_LIST_LOCAL: "files:list-local",
  FILES_READ: "files:read",
  FILES_WRITE: "files:write",
  FILES_WATCH_EVENTS: "files:watch-events",

  // Seedvault remote
  VAULT_LIST_REMOTE: "vault:list-remote",
  VAULT_READ_REMOTE: "vault:read-remote",
  VAULT_SEARCH: "vault:search",
  VAULT_SSE_EVENTS: "vault:sse-events",
  VAULT_STATUS: "vault:status",

  // OpenClaw
  CHAT_SEND: "chat:send",
  CHAT_HISTORY: "chat:history",
  CHAT_EVENTS: "chat:events",
  CHAT_STATUS: "chat:status",

  // Config
  CONFIG_GET: "config:get",
  CONFIG_SET: "config:set",

  // Daemon
  DAEMON_STATUS: "daemon:status",
  DAEMON_START: "daemon:start",
  DAEMON_STOP: "daemon:stop",
} as const;
```

**Step 3: Update preload with typed API**

`src/preload/index.ts`:
```ts
import { contextBridge, ipcRenderer } from "electron";
import { IPC } from "../shared/ipc-channels";
import type { CollaboratorConfig, ChatMessage, VaultItem, FileTreeNode } from "../shared/types";

const api = {
  platform: process.platform,

  // Local files
  listLocalFiles: (): Promise<FileTreeNode[]> =>
    ipcRenderer.invoke(IPC.FILES_LIST_LOCAL),
  readFile: (path: string): Promise<VaultItem> =>
    ipcRenderer.invoke(IPC.FILES_READ, path),
  writeFile: (path: string, content: string): Promise<void> =>
    ipcRenderer.invoke(IPC.FILES_WRITE, path, content),
  onFileChange: (callback: (path: string) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, path: string) => callback(path);
    ipcRenderer.on(IPC.FILES_WATCH_EVENTS, handler);
    return () => ipcRenderer.removeListener(IPC.FILES_WATCH_EVENTS, handler);
  },

  // Seedvault remote
  listRemoteFiles: (): Promise<FileTreeNode[]> =>
    ipcRenderer.invoke(IPC.VAULT_LIST_REMOTE),
  readRemoteFile: (path: string): Promise<VaultItem> =>
    ipcRenderer.invoke(IPC.VAULT_READ_REMOTE, path),
  searchVault: (query: string): Promise<VaultItem[]> =>
    ipcRenderer.invoke(IPC.VAULT_SEARCH, query),
  onVaultEvent: (callback: (event: { type: string; path: string }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: { type: string; path: string }) =>
      callback(data);
    ipcRenderer.on(IPC.VAULT_SSE_EVENTS, handler);
    return () => ipcRenderer.removeListener(IPC.VAULT_SSE_EVENTS, handler);
  },
  getVaultStatus: (): Promise<string> =>
    ipcRenderer.invoke(IPC.VAULT_STATUS),

  // OpenClaw chat
  sendMessage: (text: string): Promise<void> =>
    ipcRenderer.invoke(IPC.CHAT_SEND, text),
  getChatHistory: (sessionId: string): Promise<ChatMessage[]> =>
    ipcRenderer.invoke(IPC.CHAT_HISTORY, sessionId),
  onChatEvent: (callback: (msg: ChatMessage) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, msg: ChatMessage) => callback(msg);
    ipcRenderer.on(IPC.CHAT_EVENTS, handler);
    return () => ipcRenderer.removeListener(IPC.CHAT_EVENTS, handler);
  },
  getChatStatus: (): Promise<string> =>
    ipcRenderer.invoke(IPC.CHAT_STATUS),

  // Config
  getConfig: (): Promise<CollaboratorConfig> =>
    ipcRenderer.invoke(IPC.CONFIG_GET),
  setConfig: (config: Partial<CollaboratorConfig>): Promise<void> =>
    ipcRenderer.invoke(IPC.CONFIG_SET, config),
};

export type CollaboratorAPI = typeof api;

contextBridge.exposeInMainWorld("collaborator", api);
```

**Step 4: Create renderer type declaration**

`src/renderer/src/types.ts`:
```ts
import type { CollaboratorAPI } from "../../preload/index";

declare global {
  interface Window {
    collaborator: CollaboratorAPI;
  }
}
```

**Step 5: Verify typecheck passes**

```bash
pnpm run typecheck
```

Expected: No errors.

**Step 6: Commit**

```bash
git add src/shared/ src/preload/ src/renderer/src/types.ts
git commit -m "feat: add typed IPC layer and shared types"
```

---

## Task 3: Local File Operations (Main Process)

**Files:**
- Create: `src/main/ipc/files.ts`
- Create: `tests/main/files.test.ts`
- Modify: `src/main/index.ts`

> Implements reading, writing, and watching local markdown files. The main process scans configured directories and builds a file tree. Writes go directly to the filesystem; the Seedvault CLI daemon handles sync.

**Step 1: Write the failing test for listing local files**

`tests/main/files.test.ts`:
```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { listLocalFiles, readLocalFile, writeLocalFile } from "../../src/main/ipc/files";

describe("listLocalFiles", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "collaborator-test-"));
    writeFileSync(join(tempDir, "note.md"), "---\ntitle: Test Note\n---\n# Hello");
    mkdirSync(join(tempDir, "subfolder"));
    writeFileSync(join(tempDir, "subfolder", "nested.md"), "# Nested");
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("returns a tree of markdown files", async () => {
    const tree = await listLocalFiles([tempDir], "testuser");
    expect(tree).toHaveLength(1);
    const root = tree[0]!;
    expect(root.type).toBe("directory");
    expect(root.owned).toBe(true);

    const files = root.children?.filter((c) => c.type === "file") ?? [];
    expect(files).toHaveLength(1);
    expect(files[0]!.name).toBe("note.md");

    const dirs = root.children?.filter((c) => c.type === "directory") ?? [];
    expect(dirs).toHaveLength(1);
    expect(dirs[0]!.children).toHaveLength(1);
  });

  it("ignores non-markdown files", async () => {
    writeFileSync(join(tempDir, "image.png"), "fake png");
    const tree = await listLocalFiles([tempDir], "testuser");
    const root = tree[0]!;
    const allFiles = root.children?.filter((c) => c.type === "file") ?? [];
    expect(allFiles.every((f) => f.name.endsWith(".md"))).toBe(true);
  });
});

describe("readLocalFile", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "collaborator-test-"));
    writeFileSync(
      join(tempDir, "note.md"),
      "---\ntitle: My Note\n---\n# Content\n\nBody text here.",
    );
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("reads file and parses frontmatter", async () => {
    const item = await readLocalFile(join(tempDir, "note.md"), "testuser");
    expect(item.title).toBe("My Note");
    expect(item.content).toContain("# Content");
    expect(item.owned).toBe(true);
    expect(item.contributor).toBe("testuser");
  });
});

describe("writeLocalFile", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "collaborator-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("writes content to file on disk", async () => {
    const filePath = join(tempDir, "new.md");
    await writeLocalFile(filePath, "---\ntitle: New\n---\n# New File");

    const item = await readLocalFile(filePath, "testuser");
    expect(item.title).toBe("New");
    expect(item.content).toContain("# New File");
  });
});
```

**Step 2: Run test to verify it fails**

```bash
cd /Users/yiliu/repos/collaborator
pnpm run test -- tests/main/files.test.ts
```

Expected: FAIL — module `../../src/main/ipc/files` not found.

**Step 3: Implement local file operations**

`src/main/ipc/files.ts`:
```ts
import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join, basename, extname, relative } from "node:path";
import type { VaultItem, FileTreeNode } from "../../shared/types";

/** Parse YAML frontmatter from markdown content */
function parseFrontmatter(raw: string): { title: string; content: string } {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) return { title: "", content: raw };

  const yaml = match[1] ?? "";
  const content = match[2] ?? "";
  const titleMatch = yaml.match(/^title:\s*["']?(.+?)["']?\s*$/m);
  return {
    title: titleMatch?.[1] ?? "",
    content,
  };
}

/** Recursively scan a directory for markdown files */
function scanDir(dirPath: string, contributor: string): FileTreeNode {
  const entries = readdirSync(dirPath, { withFileTypes: true });
  const children: FileTreeNode[] = [];

  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;

    const fullPath = join(dirPath, entry.name);

    if (entry.isDirectory()) {
      const subtree = scanDir(fullPath, contributor);
      if (subtree.children && subtree.children.length > 0) {
        children.push(subtree);
      }
    } else if (entry.isFile() && extname(entry.name) === ".md") {
      children.push({
        name: entry.name,
        path: fullPath,
        type: "file",
        owned: true,
      });
    }
  }

  return {
    name: basename(dirPath),
    path: dirPath,
    type: "directory",
    children,
    owned: true,
  };
}

export async function listLocalFiles(
  dirs: string[],
  contributor: string,
): Promise<FileTreeNode[]> {
  return dirs.map((dir) => scanDir(dir, contributor));
}

export async function readLocalFile(
  filePath: string,
  contributor: string,
): Promise<VaultItem> {
  const raw = readFileSync(filePath, "utf-8");
  const stat = statSync(filePath);
  const { title, content } = parseFrontmatter(raw);

  return {
    path: filePath,
    contributor,
    title: title || basename(filePath, ".md"),
    content: raw,
    owned: true,
    modified: stat.mtime.toISOString(),
    created: stat.birthtime.toISOString(),
  };
}

export async function writeLocalFile(
  filePath: string,
  content: string,
): Promise<void> {
  writeFileSync(filePath, content, "utf-8");
}
```

**Step 4: Run tests to verify they pass**

```bash
pnpm run test -- tests/main/files.test.ts
```

Expected: All tests PASS.

**Step 5: Register IPC handlers in main process**

Modify `src/main/index.ts` — add after `app.whenReady().then`:

```ts
import { ipcMain } from "electron";
import { IPC } from "../shared/ipc-channels";
import { listLocalFiles, readLocalFile, writeLocalFile } from "./ipc/files";

// Placeholder config — will be replaced by config system in Task 9
const config = {
  localDirs: [] as string[],
  contributor: "",
};

function registerFileHandlers(): void {
  ipcMain.handle(IPC.FILES_LIST_LOCAL, () =>
    listLocalFiles(config.localDirs, config.contributor),
  );

  ipcMain.handle(IPC.FILES_READ, (_event, path: string) =>
    readLocalFile(path, config.contributor),
  );

  ipcMain.handle(IPC.FILES_WRITE, (_event, path: string, content: string) =>
    writeLocalFile(path, content),
  );
}
```

Call `registerFileHandlers()` inside `app.whenReady().then(...)` before `createWindow()`.

**Step 6: Commit**

```bash
git addsrc/main/ipc/files.ts collaborator/tests/main/files.test.ts collaborator/src/main/index.ts
git commit -m "feat: local file read/write/list with frontmatter parsing"
```

---

## Task 4: File Watcher

**Files:**
- Create: `src/main/ipc/watcher.ts`
- Create: `tests/main/watcher.test.ts`
- Modify: `src/main/index.ts`

> Watches local directories for changes and pushes events to the renderer via IPC.

**Step 1: Write the failing test**

`tests/main/watcher.test.ts`:
```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createWatcher } from "../../src/main/ipc/watcher";

describe("createWatcher", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "collaborator-watch-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("emits change events when a markdown file is modified", async () => {
    const events: string[] = [];
    const watcher = createWatcher([tempDir], (path) => events.push(path));

    // Wait for watcher to be ready
    await new Promise<void>((resolve) => watcher.on("ready", resolve));

    writeFileSync(join(tempDir, "new.md"), "# New file");

    // Give chokidar time to detect the change
    await new Promise((resolve) => setTimeout(resolve, 500));

    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events[0]).toContain("new.md");

    await watcher.close();
  });

  it("ignores non-markdown files", async () => {
    const events: string[] = [];
    const watcher = createWatcher([tempDir], (path) => events.push(path));

    await new Promise<void>((resolve) => watcher.on("ready", resolve));

    writeFileSync(join(tempDir, "image.png"), "fake");

    await new Promise((resolve) => setTimeout(resolve, 500));

    expect(events).toHaveLength(0);

    await watcher.close();
  });
});
```

**Step 2: Run test to verify it fails**

```bash
pnpm run test -- tests/main/watcher.test.ts
```

Expected: FAIL — module not found.

**Step 3: Implement watcher**

`src/main/ipc/watcher.ts`:
```ts
import { watch, type FSWatcher } from "chokidar";

export function createWatcher(
  dirs: string[],
  onChange: (path: string) => void,
): FSWatcher {
  const watcher = watch(dirs, {
    ignored: (path) => {
      // Allow directories (so chokidar descends into them)
      // Only allow .md files
      if (path.includes(".")) {
        return !path.endsWith(".md");
      }
      return false;
    },
    persistent: true,
    ignoreInitial: true,
  });

  watcher.on("add", onChange);
  watcher.on("change", onChange);
  watcher.on("unlink", onChange);

  return watcher;
}
```

**Step 4: Run tests to verify they pass**

```bash
pnpm run test -- tests/main/watcher.test.ts
```

Expected: All tests PASS.

**Step 5: Wire watcher into main process**

Add to `src/main/index.ts` inside `app.whenReady()`:

```ts
import { createWatcher } from "./ipc/watcher";

// After registerFileHandlers():
let watcher: ReturnType<typeof createWatcher> | null = null;

function startFileWatcher(win: BrowserWindow): void {
  if (config.localDirs.length === 0) return;

  watcher = createWatcher(config.localDirs, (path) => {
    win.webContents.send(IPC.FILES_WATCH_EVENTS, path);
  });
}
```

Call `startFileWatcher(win)` after `createWindow()`.

**Step 6: Commit**

```bash
git addsrc/main/ipc/watcher.ts collaborator/tests/main/watcher.test.ts collaborator/src/main/index.ts
git commit -m "feat: file watcher for local markdown changes"
```

---

## Task 5: Seedvault API Client (Main Process)

**Files:**
- Create: `src/main/ipc/seedvault.ts`
- Create: `tests/main/seedvault.test.ts`
- Modify: `src/main/index.ts`

> HTTP client for fetching remote contributor files and subscribing to SSE events. Reference `seedvault/cli/src/client.ts` for API patterns.

**Step 1: Write the failing test**

`tests/main/seedvault.test.ts`:
```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { SeedvaultClient } from "../../src/main/ipc/seedvault";

// These tests run against a mock — no real server needed
// Real integration tests would require a running Seedvault server

describe("SeedvaultClient", () => {
  it("constructs with URL and token", () => {
    const client = new SeedvaultClient("http://localhost:3000", "sv_test123");
    expect(client).toBeDefined();
  });

  it("builds correct file listing URL", () => {
    const client = new SeedvaultClient("http://localhost:3000", "sv_test123");
    expect(client.filesUrl("")).toBe("http://localhost:3000/v1/files");
    expect(client.filesUrl("alice")).toBe("http://localhost:3000/v1/files?prefix=alice");
  });

  it("builds correct search URL", () => {
    const client = new SeedvaultClient("http://localhost:3000", "sv_test123");
    expect(client.searchUrl("hello world")).toBe(
      "http://localhost:3000/v1/search?q=hello%20world",
    );
  });

  it("builds correct SSE URL", () => {
    const client = new SeedvaultClient("http://localhost:3000", "sv_test123");
    expect(client.eventsUrl()).toBe("http://localhost:3000/v1/events");
  });
});
```

**Step 2: Run test to verify it fails**

```bash
pnpm run test -- tests/main/seedvault.test.ts
```

Expected: FAIL — module not found.

**Step 3: Implement Seedvault client**

`src/main/ipc/seedvault.ts`:
```ts
import type { VaultItem, FileTreeNode } from "../../shared/types";

export class SeedvaultClient {
  private baseUrl: string;
  private token: string;
  private abortController: AbortController | null = null;

  constructor(baseUrl: string, token: string) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.token = token;
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.token}`,
    };
  }

  filesUrl(prefix: string): string {
    const base = `${this.baseUrl}/v1/files`;
    return prefix ? `${base}?prefix=${prefix}` : base;
  }

  searchUrl(query: string): string {
    return `${this.baseUrl}/v1/search?q=${encodeURIComponent(query)}`;
  }

  eventsUrl(): string {
    return `${this.baseUrl}/v1/events`;
  }

  async listFiles(prefix: string = ""): Promise<FileTreeNode[]> {
    const res = await fetch(this.filesUrl(prefix), { headers: this.headers() });
    if (!res.ok) throw new Error(`Seedvault list failed: ${res.status}`);

    const items: Array<{ path: string; contributor: string }> = await res.json();
    return this.buildTree(items);
  }

  async readFile(path: string): Promise<VaultItem> {
    const url = `${this.baseUrl}/v1/files/${path}`;
    const res = await fetch(url, { headers: this.headers() });
    if (!res.ok) throw new Error(`Seedvault read failed: ${res.status}`);

    const contentType = res.headers.get("content-type") ?? "";
    const content = await res.text();
    const contributor = path.split("/")[0] ?? "";

    return {
      path,
      contributor,
      title: path.split("/").pop()?.replace(".md", "") ?? "",
      content,
      owned: false,
      modified: res.headers.get("last-modified") ?? new Date().toISOString(),
      created: res.headers.get("x-created") ?? new Date().toISOString(),
    };
  }

  async search(query: string): Promise<VaultItem[]> {
    const res = await fetch(this.searchUrl(query), { headers: this.headers() });
    if (!res.ok) throw new Error(`Seedvault search failed: ${res.status}`);
    return res.json();
  }

  /** Subscribe to SSE events. Calls onEvent for each event. Returns cleanup function. */
  subscribeToEvents(
    onEvent: (event: { type: string; path: string }) => void,
    onError?: (error: Error) => void,
  ): () => void {
    this.abortController = new AbortController();

    const connect = async () => {
      try {
        const res = await fetch(this.eventsUrl(), {
          headers: { ...this.headers(), Accept: "text/event-stream" },
          signal: this.abortController!.signal,
        });

        if (!res.ok || !res.body) {
          onError?.(new Error(`SSE connection failed: ${res.status}`));
          return;
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";

          for (const line of lines) {
            if (line.startsWith("data: ")) {
              try {
                const data = JSON.parse(line.slice(6));
                onEvent(data);
              } catch {
                // Skip malformed events
              }
            }
          }
        }
      } catch (err) {
        if (err instanceof Error && err.name !== "AbortError") {
          onError?.(err);
        }
      }
    };

    connect();

    return () => {
      this.abortController?.abort();
      this.abortController = null;
    };
  }

  /** Build a contributor-grouped tree from flat file listing */
  private buildTree(
    items: Array<{ path: string; contributor: string }>,
  ): FileTreeNode[] {
    const byContributor = new Map<string, FileTreeNode[]>();

    for (const item of items) {
      const parts = item.path.split("/");
      const contributor = parts[0] ?? "";
      const fileName = parts.slice(1).join("/");

      if (!byContributor.has(contributor)) {
        byContributor.set(contributor, []);
      }

      byContributor.get(contributor)!.push({
        name: fileName,
        path: item.path,
        type: "file",
        owned: false,
      });
    }

    return Array.from(byContributor.entries()).map(([name, children]) => ({
      name,
      path: name,
      type: "contributor" as const,
      children,
      owned: false,
    }));
  }
}
```

**Step 4: Run tests to verify they pass**

```bash
pnpm run test -- tests/main/seedvault.test.ts
```

Expected: All tests PASS.

**Step 5: Register IPC handlers**

Add to `src/main/index.ts`:

```ts
import { SeedvaultClient } from "./ipc/seedvault";

let seedvaultClient: SeedvaultClient | null = null;

function registerVaultHandlers(win: BrowserWindow): void {
  ipcMain.handle(IPC.VAULT_LIST_REMOTE, () =>
    seedvaultClient?.listFiles() ?? [],
  );

  ipcMain.handle(IPC.VAULT_READ_REMOTE, (_event, path: string) =>
    seedvaultClient?.readFile(path),
  );

  ipcMain.handle(IPC.VAULT_SEARCH, (_event, query: string) =>
    seedvaultClient?.search(query) ?? [],
  );
}

function connectToSeedvault(win: BrowserWindow): void {
  if (!config.seedvaultUrl || !config.seedvaultToken) return;

  seedvaultClient = new SeedvaultClient(config.seedvaultUrl, config.seedvaultToken);

  seedvaultClient.subscribeToEvents(
    (event) => win.webContents.send(IPC.VAULT_SSE_EVENTS, event),
    (error) => console.error("SSE error:", error.message),
  );
}
```

**Step 6: Commit**

```bash
git addsrc/main/ipc/seedvault.ts collaborator/tests/main/seedvault.test.ts collaborator/src/main/index.ts
git commit -m "feat: Seedvault API client with SSE subscription"
```

---

## Task 6: OpenClaw WebSocket Client (Main Process)

**Files:**
- Create: `src/main/ipc/openclaw.ts`
- Create: `tests/main/openclaw.test.ts`
- Modify: `src/main/index.ts`

> WebSocket client that connects to OpenClaw gateway, handles the nonce-based auth handshake, and exposes chat send/receive. Reference `openclaw/src/gateway/` for the protocol.

**Step 1: Write the failing test**

`tests/main/openclaw.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import {
  buildConnectFrame,
  buildChatSendFrame,
  parseFrame,
  type GatewayFrame,
} from "../../src/main/ipc/openclaw";

describe("OpenClaw frame builders", () => {
  it("builds a connect frame with token auth", () => {
    const frame = buildConnectFrame("test-token-123", "nonce-abc");
    expect(frame.type).toBe("request");
    expect(frame.method).toBe("connect");
    expect(frame.params.token).toBe("test-token-123");
    expect(frame.params.client).toBe("collaborator");
  });

  it("builds a chat.send frame", () => {
    const frame = buildChatSendFrame("session-1", "Hello AI");
    expect(frame.type).toBe("request");
    expect(frame.method).toBe("chat.send");
    expect(frame.params.sessionId).toBe("session-1");
    expect(frame.params.text).toBe("Hello AI");
  });

  it("parses an event frame", () => {
    const raw = JSON.stringify({
      type: "event",
      event: "chat.message",
      payload: { sessionId: "s1", text: "Hi there", role: "assistant" },
    });
    const frame = parseFrame(raw);
    expect(frame.type).toBe("event");
    expect(frame.event).toBe("chat.message");
    expect(frame.payload.text).toBe("Hi there");
  });

  it("parses a response frame", () => {
    const raw = JSON.stringify({
      type: "response",
      id: "req-1",
      result: { ok: true },
    });
    const frame = parseFrame(raw);
    expect(frame.type).toBe("response");
    expect(frame.id).toBe("req-1");
  });
});
```

**Step 2: Run test to verify it fails**

```bash
pnpm run test -- tests/main/openclaw.test.ts
```

Expected: FAIL — module not found.

**Step 3: Implement OpenClaw client**

`src/main/ipc/openclaw.ts`:
```ts
import WebSocket from "ws";
import { randomUUID } from "node:crypto";
import type { ChatMessage } from "../../shared/types";

export interface GatewayFrame {
  type: "request" | "response" | "event";
  id?: string;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
  event?: string;
  payload?: Record<string, unknown>;
}

export function buildConnectFrame(
  token: string,
  nonce: string,
): GatewayFrame & { type: "request"; method: "connect"; params: Record<string, unknown> } {
  return {
    type: "request",
    id: randomUUID(),
    method: "connect",
    params: {
      client: "collaborator",
      token,
      nonce,
      role: "user",
    },
  };
}

export function buildChatSendFrame(
  sessionId: string,
  text: string,
): GatewayFrame & { type: "request"; method: "chat.send"; params: Record<string, unknown> } {
  return {
    type: "request",
    id: randomUUID(),
    method: "chat.send",
    params: { sessionId, text },
  };
}

export function parseFrame(raw: string): GatewayFrame {
  return JSON.parse(raw) as GatewayFrame;
}

type EventCallback = (event: string, payload: Record<string, unknown>) => void;
type StatusCallback = (status: string) => void;

export class OpenClawClient {
  private ws: WebSocket | null = null;
  private url: string;
  private token: string;
  private pendingRequests = new Map<string, {
    resolve: (result: Record<string, unknown>) => void;
    reject: (error: Error) => void;
  }>();
  private onEvent: EventCallback;
  private onStatus: StatusCallback;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    url: string,
    token: string,
    onEvent: EventCallback,
    onStatus: StatusCallback,
  ) {
    this.url = url;
    this.token = token;
    this.onEvent = onEvent;
    this.onStatus = onStatus;
  }

  connect(): void {
    this.onStatus("connecting");
    this.ws = new WebSocket(this.url);

    this.ws.on("open", () => {
      // Wait for connect.challenge event from gateway
    });

    this.ws.on("message", (data) => {
      const frame = parseFrame(data.toString());
      this.handleFrame(frame);
    });

    this.ws.on("close", () => {
      this.onStatus("disconnected");
      this.scheduleReconnect();
    });

    this.ws.on("error", (err) => {
      this.onStatus("error");
      console.error("OpenClaw WebSocket error:", err.message);
    });
  }

  private handleFrame(frame: GatewayFrame): void {
    if (frame.type === "event" && frame.event === "connect.challenge") {
      // Respond with auth
      const nonce = (frame.payload as { nonce?: string })?.nonce ?? "";
      const connectFrame = buildConnectFrame(this.token, nonce);
      this.send(connectFrame);
      return;
    }

    if (frame.type === "response" && frame.id) {
      const pending = this.pendingRequests.get(frame.id);
      if (pending) {
        this.pendingRequests.delete(frame.id);
        if (frame.error) {
          pending.reject(new Error(frame.error.message));
        } else {
          pending.resolve(frame.result ?? {});
        }
      }

      // Check if this is the connect response
      if (frame.result && "methods" in frame.result) {
        this.onStatus("connected");
      }
      return;
    }

    if (frame.type === "event" && frame.event) {
      this.onEvent(frame.event, frame.payload ?? {});
    }
  }

  async request(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const id = randomUUID();
    const frame: GatewayFrame = { type: "request", id, method, params };

    return new Promise((resolve, reject) => {
      this.pendingRequests.set(id, { resolve, reject });
      this.send(frame);
    });
  }

  async sendChatMessage(sessionId: string, text: string): Promise<void> {
    await this.request("chat.send", { sessionId, text });
  }

  async getChatHistory(sessionId: string): Promise<ChatMessage[]> {
    const result = await this.request("chat.history", { sessionId });
    return (result.messages as ChatMessage[]) ?? [];
  }

  private send(frame: GatewayFrame): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(frame));
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, 3000);
  }

  disconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.ws?.close();
    this.ws = null;
  }
}
```

**Step 4: Run tests to verify they pass**

```bash
pnpm run test -- tests/main/openclaw.test.ts
```

Expected: All tests PASS.

**Step 5: Register IPC handlers**

Add to `src/main/index.ts`:

```ts
import { OpenClawClient } from "./ipc/openclaw";

let openclawClient: OpenClawClient | null = null;

function registerChatHandlers(): void {
  ipcMain.handle(IPC.CHAT_SEND, (_event, text: string) =>
    openclawClient?.sendChatMessage("main", text),
  );

  ipcMain.handle(IPC.CHAT_HISTORY, (_event, sessionId: string) =>
    openclawClient?.getChatHistory(sessionId) ?? [],
  );

  ipcMain.handle(IPC.CHAT_STATUS, () =>
    openclawClient ? "connected" : "disconnected",
  );
}

function connectToOpenClaw(win: BrowserWindow): void {
  if (!config.openclawUrl || !config.openclawToken) return;

  openclawClient = new OpenClawClient(
    config.openclawUrl,
    config.openclawToken,
    (event, payload) => {
      if (event.startsWith("chat.")) {
        win.webContents.send(IPC.CHAT_EVENTS, payload);
      }
    },
    (status) => {
      win.webContents.send(IPC.CHAT_STATUS, status);
    },
  );

  openclawClient.connect();
}
```

**Step 6: Commit**

```bash
git addsrc/main/ipc/openclaw.ts collaborator/tests/main/openclaw.test.ts collaborator/src/main/index.ts
git commit -m "feat: OpenClaw WebSocket client with auth handshake"
```

---

## Task 7: App Layout & Vault Browser UI

**Files:**
- Create: `src/renderer/src/components/Layout.tsx`
- Create: `src/renderer/src/components/VaultBrowser/FileTree.tsx`
- Create: `src/renderer/src/components/VaultBrowser/VaultBrowser.tsx`
- Create: `src/renderer/src/hooks/useFiles.ts`
- Create: `tests/renderer/FileTree.test.tsx`
- Modify: `src/renderer/src/App.tsx`

> The three-panel layout: vault browser (left), editor (center), chat (right). This task builds the layout shell and the vault browser with file tree.

**Step 1: Write the failing test for FileTree**

`tests/renderer/FileTree.test.tsx`:
```tsx
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { FileTree } from "../../src/renderer/src/components/VaultBrowser/FileTree";
import type { FileTreeNode } from "../../src/shared/types";

const mockTree: FileTreeNode[] = [
  {
    name: "My Notes",
    path: "/home/user/notes",
    type: "directory",
    owned: true,
    children: [
      { name: "todo.md", path: "/home/user/notes/todo.md", type: "file", owned: true },
      { name: "ideas.md", path: "/home/user/notes/ideas.md", type: "file", owned: true },
    ],
  },
  {
    name: "ai-agent",
    path: "ai-agent",
    type: "contributor",
    owned: false,
    children: [
      { name: "summary.md", path: "ai-agent/summary.md", type: "file", owned: false },
    ],
  },
];

describe("FileTree", () => {
  it("renders local and remote sections", () => {
    render(<FileTree nodes={mockTree} onSelect={() => {}} selectedPath="" />);
    expect(screen.getByText("My Notes")).toBeDefined();
    expect(screen.getByText("ai-agent")).toBeDefined();
  });

  it("renders file names", () => {
    render(<FileTree nodes={mockTree} onSelect={() => {}} selectedPath="" />);
    expect(screen.getByText("todo.md")).toBeDefined();
    expect(screen.getByText("summary.md")).toBeDefined();
  });
});
```

**Step 2: Run test to verify it fails**

```bash
pnpm run test -- tests/renderer/FileTree.test.tsx
```

Expected: FAIL — module not found.

**Step 3: Implement FileTree component**

`src/renderer/src/components/VaultBrowser/FileTree.tsx`:
```tsx
import { useState } from "react";
import type { FileTreeNode } from "../../../../shared/types";

interface FileTreeProps {
  nodes: FileTreeNode[];
  onSelect: (path: string, owned: boolean) => void;
  selectedPath: string;
}

function TreeNode({
  node,
  depth,
  onSelect,
  selectedPath,
}: {
  node: FileTreeNode;
  depth: number;
  onSelect: (path: string, owned: boolean) => void;
  selectedPath: string;
}) {
  const [expanded, setExpanded] = useState(true);
  const isSelected = node.path === selectedPath;
  const hasChildren = node.children && node.children.length > 0;
  const isExpandable = node.type === "directory" || node.type === "contributor";

  return (
    <div>
      <button
        type="button"
        onClick={() => {
          if (isExpandable) {
            setExpanded(!expanded);
          } else {
            onSelect(node.path, node.owned);
          }
        }}
        className={`
          w-full text-left px-2 py-1 text-sm flex items-center gap-1 rounded
          ${isSelected ? "bg-stone-200" : "hover:bg-stone-100"}
        `}
        style={{ paddingLeft: `${depth * 16 + 8}px` }}
      >
        {isExpandable && (
          <span className="text-xs text-stone-400">
            {expanded ? "\u25BE" : "\u25B8"}
          </span>
        )}
        {!isExpandable && <span className="text-xs text-stone-400 ml-3">{"\u00B7"}</span>}
        <span className={node.owned ? "text-stone-800" : "text-stone-500"}>
          {node.name}
        </span>
      </button>
      {expanded && hasChildren && (
        <div>
          {node.children!.map((child) => (
            <TreeNode
              key={child.path}
              node={child}
              depth={depth + 1}
              onSelect={onSelect}
              selectedPath={selectedPath}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export function FileTree({ nodes, onSelect, selectedPath }: FileTreeProps) {
  return (
    <div className="py-2">
      {nodes.map((node) => (
        <TreeNode
          key={node.path}
          node={node}
          depth={0}
          onSelect={onSelect}
          selectedPath={selectedPath}
        />
      ))}
    </div>
  );
}
```

**Step 4: Implement VaultBrowser (container)**

`src/renderer/src/components/VaultBrowser/VaultBrowser.tsx`:
```tsx
import { FileTree } from "./FileTree";
import type { FileTreeNode } from "../../../../shared/types";

interface VaultBrowserProps {
  localFiles: FileTreeNode[];
  remoteFiles: FileTreeNode[];
  selectedPath: string;
  onSelect: (path: string, owned: boolean) => void;
}

export function VaultBrowser({
  localFiles,
  remoteFiles,
  selectedPath,
  onSelect,
}: VaultBrowserProps) {
  return (
    <div className="h-full overflow-y-auto border-r border-stone-200 bg-stone-50">
      {localFiles.length > 0 && (
        <div>
          <div className="px-3 py-2 text-xs font-medium text-stone-400 uppercase tracking-wider">
            Your Files
          </div>
          <FileTree nodes={localFiles} onSelect={onSelect} selectedPath={selectedPath} />
        </div>
      )}
      {remoteFiles.length > 0 && (
        <div>
          <div className="px-3 py-2 text-xs font-medium text-stone-400 uppercase tracking-wider mt-4">
            Contributors
          </div>
          <FileTree nodes={remoteFiles} onSelect={onSelect} selectedPath={selectedPath} />
        </div>
      )}
    </div>
  );
}
```

**Step 5: Implement useFiles hook**

`src/renderer/src/hooks/useFiles.ts`:
```tsx
import { useState, useEffect, useCallback } from "react";
import type { FileTreeNode, VaultItem } from "../../../shared/types";

export function useFiles() {
  const [localFiles, setLocalFiles] = useState<FileTreeNode[]>([]);
  const [remoteFiles, setRemoteFiles] = useState<FileTreeNode[]>([]);
  const [selectedItem, setSelectedItem] = useState<VaultItem | null>(null);
  const [selectedPath, setSelectedPath] = useState("");

  const refreshLocal = useCallback(async () => {
    const files = await window.collaborator.listLocalFiles();
    setLocalFiles(files);
  }, []);

  const refreshRemote = useCallback(async () => {
    const files = await window.collaborator.listRemoteFiles();
    setRemoteFiles(files);
  }, []);

  const selectFile = useCallback(async (path: string, owned: boolean) => {
    setSelectedPath(path);
    const item = owned
      ? await window.collaborator.readFile(path)
      : await window.collaborator.readRemoteFile(path);
    setSelectedItem(item);
  }, []);

  const saveFile = useCallback(async (path: string, content: string) => {
    await window.collaborator.writeFile(path, content);
  }, []);

  useEffect(() => {
    refreshLocal();
    refreshRemote();
  }, [refreshLocal, refreshRemote]);

  // Listen for local file changes
  useEffect(() => {
    const cleanup = window.collaborator.onFileChange(() => {
      refreshLocal();
    });
    return cleanup;
  }, [refreshLocal]);

  // Listen for remote vault events (SSE)
  useEffect(() => {
    const cleanup = window.collaborator.onVaultEvent(() => {
      refreshRemote();
    });
    return cleanup;
  }, [refreshRemote]);

  return {
    localFiles,
    remoteFiles,
    selectedItem,
    selectedPath,
    selectFile,
    saveFile,
    refreshLocal,
    refreshRemote,
  };
}
```

**Step 6: Create Layout and update App**

`src/renderer/src/components/Layout.tsx`:
```tsx
import type { ReactNode } from "react";

interface LayoutProps {
  sidebar: ReactNode;
  main: ReactNode;
  chat: ReactNode;
}

export function Layout({ sidebar, main, chat }: LayoutProps) {
  return (
    <div className="h-screen flex bg-white">
      <div className="w-64 flex-shrink-0">{sidebar}</div>
      <div className="flex-1 min-w-0">{main}</div>
      <div className="w-80 flex-shrink-0 border-l border-stone-200">{chat}</div>
    </div>
  );
}
```

Update `src/renderer/src/App.tsx`:
```tsx
import { Layout } from "./components/Layout";
import { VaultBrowser } from "./components/VaultBrowser/VaultBrowser";
import { useFiles } from "./hooks/useFiles";

export function App() {
  const {
    localFiles,
    remoteFiles,
    selectedItem,
    selectedPath,
    selectFile,
  } = useFiles();

  return (
    <Layout
      sidebar={
        <VaultBrowser
          localFiles={localFiles}
          remoteFiles={remoteFiles}
          selectedPath={selectedPath}
          onSelect={selectFile}
        />
      }
      main={
        <div className="h-full flex items-center justify-center text-stone-400">
          {selectedItem ? selectedItem.title : "Select a file"}
        </div>
      }
      chat={
        <div className="h-full flex items-center justify-center text-stone-400">
          Chat
        </div>
      }
    />
  );
}
```

**Step 7: Run tests**

```bash
pnpm run test -- tests/renderer/FileTree.test.tsx
```

Expected: All tests PASS.

**Step 8: Commit**

```bash
git addsrc/renderer/ collaborator/tests/renderer/
git commit -m "feat: three-panel layout with vault browser and file tree"
```

---

## Task 8: BlockNote Editor Component

**Files:**
- Create: `src/renderer/src/components/Editor/Editor.tsx`
- Create: `tests/renderer/Editor.test.tsx`
- Modify: `src/renderer/src/App.tsx`

> BlockNote editor that renders markdown, supports editing for owned files, and is read-only for remote files. Reference `seedvault3/src/windows/viewer/src/components/Editor.tsx` for BlockNote patterns.

**Step 1: Write the failing test**

`tests/renderer/Editor.test.tsx`:
```tsx
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { Editor } from "../../src/renderer/src/components/Editor/Editor";

describe("Editor", () => {
  it("renders placeholder when no item is selected", () => {
    render(<Editor item={null} onSave={() => {}} />);
    expect(screen.getByText("Select a file to view")).toBeDefined();
  });

  it("renders item title", () => {
    render(
      <Editor
        item={{
          path: "test.md",
          contributor: "user",
          title: "Test Note",
          content: "# Hello",
          owned: true,
          modified: new Date().toISOString(),
          created: new Date().toISOString(),
        }}
        onSave={() => {}}
      />,
    );
    expect(screen.getByText("Test Note")).toBeDefined();
  });
});
```

**Step 2: Run test to verify it fails**

```bash
pnpm run test -- tests/renderer/Editor.test.tsx
```

Expected: FAIL — module not found.

**Step 3: Implement Editor component**

`src/renderer/src/components/Editor/Editor.tsx`:
```tsx
import { useEffect, useMemo } from "react";
import { useCreateBlockNote } from "@blocknote/react";
import { BlockNoteView } from "@blocknote/mantine";
import "@blocknote/mantine/style.css";
import type { VaultItem } from "../../../../shared/types";

interface EditorProps {
  item: VaultItem | null;
  onSave: (path: string, content: string) => void;
}

export function Editor({ item, onSave }: EditorProps) {
  const editor = useCreateBlockNote();

  // Load content when item changes
  useEffect(() => {
    if (!item || !editor) return;

    async function loadContent() {
      const blocks = await editor.tryParseMarkdownToBlocks(item!.content);
      editor.replaceBlocks(editor.document, blocks);
    }

    loadContent();
  }, [item?.path, editor]);

  // Auto-save on change for owned files
  useEffect(() => {
    if (!item?.owned || !editor) return;

    const handleChange = async () => {
      const markdown = await editor.blocksToMarkdownLossy(editor.document);
      onSave(item.path, markdown);
    };

    // Debounce saves
    let timer: ReturnType<typeof setTimeout>;
    const debouncedSave = () => {
      clearTimeout(timer);
      timer = setTimeout(handleChange, 1000);
    };

    editor.onEditorContentChange(debouncedSave);

    return () => {
      clearTimeout(timer);
    };
  }, [item?.path, item?.owned, editor, onSave]);

  if (!item) {
    return (
      <div className="h-full flex items-center justify-center text-stone-400">
        Select a file to view
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col">
      <div className="px-6 py-4 border-b border-stone-200">
        <h1 className="text-lg font-medium text-stone-800">{item.title}</h1>
        <div className="text-xs text-stone-400 mt-1">
          {item.contributor}
          {!item.owned && " (read-only)"}
        </div>
      </div>
      <div className="flex-1 overflow-y-auto px-6 py-4">
        <BlockNoteView
          editor={editor}
          editable={item.owned}
          theme="light"
        />
      </div>
    </div>
  );
}
```

**Step 4: Run tests**

```bash
pnpm run test -- tests/renderer/Editor.test.tsx
```

Expected: All tests PASS.

**Step 5: Wire editor into App**

Update `src/renderer/src/App.tsx` — replace the main placeholder:

```tsx
import { Editor } from "./components/Editor/Editor";

// In the Layout, replace the main prop:
main={
  <Editor
    item={selectedItem}
    onSave={saveFile}
  />
}
```

**Step 6: Commit**

```bash
git addsrc/renderer/src/components/Editor/ collaborator/tests/renderer/Editor.test.tsx collaborator/src/renderer/src/App.tsx
git commit -m "feat: BlockNote editor with edit/read-only modes"
```

---

## Task 9: Chat Panel UI

**Files:**
- Create: `src/renderer/src/components/Chat/ChatPanel.tsx`
- Create: `src/renderer/src/components/Chat/MessageList.tsx`
- Create: `src/renderer/src/hooks/useChat.ts`
- Create: `tests/renderer/ChatPanel.test.tsx`
- Modify: `src/renderer/src/App.tsx`

> Chat panel connected to OpenClaw. Shows conversation thread, input box, connection status, and proactive AI messages.

**Step 1: Write the failing test**

`tests/renderer/ChatPanel.test.tsx`:
```tsx
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { MessageList } from "../../src/renderer/src/components/Chat/MessageList";
import type { ChatMessage } from "../../src/shared/types";

const messages: ChatMessage[] = [
  { id: "1", role: "user", text: "Hello", timestamp: new Date().toISOString() },
  { id: "2", role: "assistant", text: "Hi there!", timestamp: new Date().toISOString() },
];

describe("MessageList", () => {
  it("renders messages", () => {
    render(<MessageList messages={messages} />);
    expect(screen.getByText("Hello")).toBeDefined();
    expect(screen.getByText("Hi there!")).toBeDefined();
  });

  it("renders empty state", () => {
    render(<MessageList messages={[]} />);
    expect(screen.getByText("No messages yet")).toBeDefined();
  });
});
```

**Step 2: Run test to verify it fails**

```bash
pnpm run test -- tests/renderer/ChatPanel.test.tsx
```

Expected: FAIL — module not found.

**Step 3: Implement MessageList**

`src/renderer/src/components/Chat/MessageList.tsx`:
```tsx
import type { ChatMessage } from "../../../../shared/types";

interface MessageListProps {
  messages: ChatMessage[];
}

export function MessageList({ messages }: MessageListProps) {
  if (messages.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center text-stone-400 text-sm">
        No messages yet
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
      {messages.map((msg) => (
        <div
          key={msg.id}
          className={`text-sm ${
            msg.role === "user"
              ? "text-stone-800"
              : "text-stone-600 bg-stone-50 rounded-lg px-3 py-2"
          }`}
        >
          {msg.text}
        </div>
      ))}
    </div>
  );
}
```

**Step 4: Implement ChatPanel**

`src/renderer/src/components/Chat/ChatPanel.tsx`:
```tsx
import { useState, useRef, useEffect } from "react";
import { MessageList } from "./MessageList";
import type { ChatMessage, ConnectionStatus } from "../../../../shared/types";

interface ChatPanelProps {
  messages: ChatMessage[];
  status: ConnectionStatus;
  onSend: (text: string) => void;
}

export function ChatPanel({ messages, status, onSend }: ChatPanelProps) {
  const [input, setInput] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length]);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const text = input.trim();
    if (!text) return;
    onSend(text);
    setInput("");
  }

  return (
    <div className="h-full flex flex-col bg-white">
      <div className="px-4 py-3 border-b border-stone-200 flex items-center justify-between">
        <span className="text-sm font-medium text-stone-700">Chat</span>
        <span
          className={`text-xs ${
            status === "connected"
              ? "text-green-600"
              : status === "connecting"
                ? "text-amber-500"
                : "text-stone-400"
          }`}
        >
          {status}
        </span>
      </div>

      <MessageList messages={messages} />
      <div ref={bottomRef} />

      <form onSubmit={handleSubmit} className="px-4 py-3 border-t border-stone-200">
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={status === "connected" ? "Message..." : "Connecting..."}
          disabled={status !== "connected"}
          className="w-full px-3 py-2 text-sm border border-stone-200 rounded-lg focus:outline-none focus:border-stone-400"
        />
      </form>
    </div>
  );
}
```

**Step 5: Implement useChat hook**

`src/renderer/src/hooks/useChat.ts`:
```tsx
import { useState, useEffect, useCallback } from "react";
import type { ChatMessage, ConnectionStatus } from "../../../shared/types";

export function useChat() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [status, setStatus] = useState<ConnectionStatus>("disconnected");

  const sendMessage = useCallback(async (text: string) => {
    const userMsg: ChatMessage = {
      id: crypto.randomUUID(),
      role: "user",
      text,
      timestamp: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, userMsg]);
    await window.collaborator.sendMessage(text);
  }, []);

  useEffect(() => {
    const cleanup = window.collaborator.onChatEvent((msg) => {
      setMessages((prev) => [...prev, msg]);
    });
    return cleanup;
  }, []);

  useEffect(() => {
    window.collaborator.getChatStatus().then((s) =>
      setStatus(s as ConnectionStatus),
    );
  }, []);

  return { messages, status, sendMessage };
}
```

**Step 6: Wire chat into App**

Update `src/renderer/src/App.tsx`:

```tsx
import { ChatPanel } from "./components/Chat/ChatPanel";
import { useChat } from "./hooks/useChat";

// Inside App():
const { messages, status, sendMessage } = useChat();

// In Layout, replace chat prop:
chat={
  <ChatPanel
    messages={messages}
    status={status}
    onSend={sendMessage}
  />
}
```

**Step 7: Run tests**

```bash
pnpm run test -- tests/renderer/ChatPanel.test.tsx
```

Expected: All tests PASS.

**Step 8: Commit**

```bash
git addsrc/renderer/src/components/Chat/ collaborator/src/renderer/src/hooks/useChat.ts collaborator/tests/renderer/ChatPanel.test.tsx collaborator/src/renderer/src/App.tsx
git commit -m "feat: chat panel with OpenClaw message display and input"
```

---

## Task 10: Configuration & Settings

**Files:**
- Create: `src/main/ipc/config.ts`
- Create: `tests/main/config.test.ts`
- Create: `src/renderer/src/components/Settings.tsx`
- Modify: `src/main/index.ts`

> Persists app configuration (Seedvault URL, OpenClaw URL, auth tokens, local dirs) to a JSON file in `~/.collaborator/config.json`. Settings UI lets the user configure connections.

**Step 1: Write the failing test**

`tests/main/config.test.ts`:
```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig, saveConfig } from "../../src/main/ipc/config";
import type { CollaboratorConfig } from "../../src/shared/types";

describe("config", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "collaborator-config-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("returns defaults when no config file exists", () => {
    const config = loadConfig(join(tempDir, "config.json"));
    expect(config.seedvaultUrl).toBe("");
    expect(config.localDirs).toEqual([]);
  });

  it("saves and loads config", () => {
    const configPath = join(tempDir, "config.json");
    const data: CollaboratorConfig = {
      seedvaultUrl: "http://localhost:3000",
      seedvaultToken: "sv_test",
      openclawUrl: "ws://localhost:18789",
      openclawToken: "oc_test",
      localDirs: ["/home/user/notes"],
      contributor: "testuser",
    };

    saveConfig(configPath, data);
    const loaded = loadConfig(configPath);

    expect(loaded.seedvaultUrl).toBe("http://localhost:3000");
    expect(loaded.openclawUrl).toBe("ws://localhost:18789");
    expect(loaded.localDirs).toEqual(["/home/user/notes"]);
  });

  it("merges partial updates", () => {
    const configPath = join(tempDir, "config.json");
    saveConfig(configPath, {
      seedvaultUrl: "http://old",
      seedvaultToken: "old",
      openclawUrl: "",
      openclawToken: "",
      localDirs: [],
      contributor: "",
    });

    saveConfig(configPath, { seedvaultUrl: "http://new" } as CollaboratorConfig);
    const loaded = loadConfig(configPath);
    expect(loaded.seedvaultUrl).toBe("http://new");
    expect(loaded.seedvaultToken).toBe("old");
  });
});
```

**Step 2: Run test to verify it fails**

```bash
pnpm run test -- tests/main/config.test.ts
```

Expected: FAIL — module not found.

**Step 3: Implement config module**

`src/main/ipc/config.ts`:
```ts
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import type { CollaboratorConfig } from "../../shared/types";

const DEFAULTS: CollaboratorConfig = {
  seedvaultUrl: "",
  seedvaultToken: "",
  openclawUrl: "",
  openclawToken: "",
  localDirs: [],
  contributor: "",
};

export function loadConfig(configPath: string): CollaboratorConfig {
  if (!existsSync(configPath)) return { ...DEFAULTS };

  try {
    const raw = readFileSync(configPath, "utf-8");
    const parsed = JSON.parse(raw) as Partial<CollaboratorConfig>;
    return { ...DEFAULTS, ...parsed };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveConfig(
  configPath: string,
  updates: Partial<CollaboratorConfig>,
): void {
  const dir = dirname(configPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const existing = loadConfig(configPath);
  const merged = { ...existing, ...updates };
  writeFileSync(configPath, JSON.stringify(merged, null, 2), "utf-8");
}
```

**Step 4: Run tests**

```bash
pnpm run test -- tests/main/config.test.ts
```

Expected: All tests PASS.

**Step 5: Create Settings UI**

`src/renderer/src/components/Settings.tsx`:
```tsx
import { useState, useEffect } from "react";
import type { CollaboratorConfig } from "../../../shared/types";

interface SettingsProps {
  open: boolean;
  onClose: () => void;
}

export function Settings({ open, onClose }: SettingsProps) {
  const [config, setConfig] = useState<CollaboratorConfig | null>(null);

  useEffect(() => {
    if (open) {
      window.collaborator.getConfig().then(setConfig);
    }
  }, [open]);

  if (!open || !config) return null;

  async function handleSave() {
    if (!config) return;
    await window.collaborator.setConfig(config);
    onClose();
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-white rounded-xl shadow-lg w-[480px] p-6">
        <h2 className="text-lg font-medium text-stone-800 mb-4">Settings</h2>

        <label className="block mb-3">
          <span className="text-sm text-stone-600">Seedvault Server URL</span>
          <input
            type="text"
            value={config.seedvaultUrl}
            onChange={(e) => setConfig({ ...config, seedvaultUrl: e.target.value })}
            className="mt-1 block w-full px-3 py-2 border border-stone-200 rounded-lg text-sm"
            placeholder="http://localhost:3000"
          />
        </label>

        <label className="block mb-3">
          <span className="text-sm text-stone-600">Seedvault Token</span>
          <input
            type="password"
            value={config.seedvaultToken}
            onChange={(e) => setConfig({ ...config, seedvaultToken: e.target.value })}
            className="mt-1 block w-full px-3 py-2 border border-stone-200 rounded-lg text-sm"
            placeholder="sv_..."
          />
        </label>

        <label className="block mb-3">
          <span className="text-sm text-stone-600">OpenClaw URL</span>
          <input
            type="text"
            value={config.openclawUrl}
            onChange={(e) => setConfig({ ...config, openclawUrl: e.target.value })}
            className="mt-1 block w-full px-3 py-2 border border-stone-200 rounded-lg text-sm"
            placeholder="ws://localhost:18789"
          />
        </label>

        <label className="block mb-3">
          <span className="text-sm text-stone-600">OpenClaw Token</span>
          <input
            type="password"
            value={config.openclawToken}
            onChange={(e) => setConfig({ ...config, openclawToken: e.target.value })}
            className="mt-1 block w-full px-3 py-2 border border-stone-200 rounded-lg text-sm"
            placeholder="Bearer token"
          />
        </label>

        <div className="flex justify-end gap-2 mt-6">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 text-sm text-stone-600 hover:text-stone-800"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSave}
            className="px-4 py-2 text-sm bg-stone-800 text-white rounded-lg hover:bg-stone-700"
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
```

**Step 6: Register config IPC handlers in main process**

Add to `src/main/index.ts`:

```ts
import { join } from "node:path";
import { app } from "electron";
import { loadConfig, saveConfig } from "./ipc/config";

const configPath = join(app.getPath("userData"), "config.json");

function registerConfigHandlers(): void {
  config = loadConfig(configPath);

  ipcMain.handle(IPC.CONFIG_GET, () => loadConfig(configPath));
  ipcMain.handle(IPC.CONFIG_SET, (_event, updates: Partial<CollaboratorConfig>) => {
    saveConfig(configPath, updates);
    config = loadConfig(configPath);
    // TODO: reconnect services when config changes
  });
}
```

**Step 7: Commit**

```bash
git addsrc/main/ipc/config.ts collaborator/tests/main/config.test.ts collaborator/src/renderer/src/components/Settings.tsx collaborator/src/main/index.ts
git commit -m "feat: config persistence and settings UI"
```

---

## Task 11: Daemon Management

**Files:**
- Create: `src/main/ipc/daemon.ts`
- Create: `tests/main/daemon.test.ts`
- Modify: `src/main/index.ts`

> Manages the Seedvault CLI daemon as a child process. Starts on app launch, monitors health, restarts on crash.

**Step 1: Write the failing test**

`tests/main/daemon.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { buildDaemonArgs } from "../../src/main/ipc/daemon";

describe("buildDaemonArgs", () => {
  it("builds start args", () => {
    const args = buildDaemonArgs("start");
    expect(args).toEqual(["start"]);
  });

  it("builds stop args", () => {
    const args = buildDaemonArgs("stop");
    expect(args).toEqual(["stop"]);
  });

  it("builds status args", () => {
    const args = buildDaemonArgs("status");
    expect(args).toEqual(["status"]);
  });
});
```

**Step 2: Run test to verify it fails**

```bash
pnpm run test -- tests/main/daemon.test.ts
```

Expected: FAIL — module not found.

**Step 3: Implement daemon manager**

`src/main/ipc/daemon.ts`:
```ts
import { spawn, type ChildProcess } from "node:child_process";

export function buildDaemonArgs(command: "start" | "stop" | "status"): string[] {
  return [command];
}

export class DaemonManager {
  private process: ChildProcess | null = null;
  private svPath: string;
  private onStatus: (status: string) => void;

  constructor(svPath: string, onStatus: (status: string) => void) {
    this.svPath = svPath;
    this.onStatus = onStatus;
  }

  start(): void {
    if (this.process) return;

    this.onStatus("starting");
    this.process = spawn(this.svPath, buildDaemonArgs("start"), {
      stdio: "pipe",
      detached: false,
    });

    this.process.on("exit", (code) => {
      this.process = null;
      this.onStatus(code === 0 ? "stopped" : "crashed");
    });

    this.process.on("error", (err) => {
      this.process = null;
      this.onStatus("error");
      console.error("Daemon error:", err.message);
    });

    this.onStatus("running");
  }

  stop(): void {
    if (!this.process) return;
    this.process.kill("SIGTERM");
    this.process = null;
    this.onStatus("stopped");
  }

  isRunning(): boolean {
    return this.process !== null;
  }

  status(): string {
    return this.process ? "running" : "stopped";
  }
}
```

**Step 4: Run tests**

```bash
pnpm run test -- tests/main/daemon.test.ts
```

Expected: All tests PASS.

**Step 5: Register daemon IPC handlers**

Add to `src/main/index.ts`:

```ts
import { DaemonManager } from "./ipc/daemon";

let daemon: DaemonManager | null = null;

function registerDaemonHandlers(win: BrowserWindow): void {
  // Resolve sv binary from @seedvault/cli package
  const svPath = process.env.SV_PATH ?? require.resolve("@seedvault/cli/bin/sv");

  daemon = new DaemonManager(svPath, (status) => {
    win.webContents.send(IPC.DAEMON_STATUS, status);
  });

  ipcMain.handle(IPC.DAEMON_START, () => daemon?.start());
  ipcMain.handle(IPC.DAEMON_STOP, () => daemon?.stop());
  ipcMain.handle(IPC.DAEMON_STATUS, () => daemon?.status() ?? "stopped");
}
```

Start daemon on app ready, stop on quit:

```ts
// In app.whenReady():
daemon?.start();

// Add:
app.on("before-quit", () => {
  daemon?.stop();
});
```

**Step 6: Commit**

```bash
git addsrc/main/ipc/daemon.ts collaborator/tests/main/daemon.test.ts collaborator/src/main/index.ts
git commit -m "feat: Seedvault CLI daemon lifecycle management"
```

---

## Task 12: Integration & Smoke Test

**Files:**
- Create: `tests/integration/app.test.ts`
- Modify: `package.json` (add Playwright Electron test script)

> End-to-end smoke test that launches the Electron app and verifies the three panels render.

**Step 1: Install Playwright for Electron**

```bash
cd /Users/yiliu/repos/collaborator
pnpm add -D @playwright/test electron
```

**Step 2: Write the smoke test**

`tests/integration/app.test.ts`:
```ts
import { test, expect, type ElectronApplication } from "@playwright/test";
import { _electron as electron } from "playwright";
import path from "node:path";

let app: ElectronApplication;

test.beforeAll(async () => {
  app = await electron.launch({
    args: [path.join(__dirname, "../../dist/main/index.js")],
  });
});

test.afterAll(async () => {
  await app.close();
});

test("app launches and shows three-panel layout", async () => {
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");

  // Vault browser section exists
  await expect(page.locator("text=Your Files")).toBeVisible();

  // Chat panel exists
  await expect(page.locator("text=Chat")).toBeVisible();
});

test("shows 'Select a file to view' in editor area", async () => {
  const page = await app.firstWindow();
  await expect(page.locator("text=Select a file to view")).toBeVisible();
});
```

**Step 3: Add test script to package.json**

Add to `package.json` scripts:
```json
"test:e2e": "pnpm run build && playwright test tests/integration/"
```

**Step 4: Build and run smoke test**

```bash
pnpm run build && pnpm run test:e2e
```

Expected: Both tests PASS.

**Step 5: Commit**

```bash
git addtests/integration/ collaborator/package.json
git commit -m "test: add Playwright Electron smoke test"
```

---

## Summary

| Task | What it builds | Key files |
|------|----------------|-----------|
| 1 | Project scaffolding | `package.json`, `electron.vite.config.ts`, entry files |
| 2 | Typed IPC layer | `shared/types.ts`, `shared/ipc-channels.ts`, `preload/index.ts` |
| 3 | Local file read/write/list | `main/ipc/files.ts` |
| 4 | File watcher | `main/ipc/watcher.ts` |
| 5 | Seedvault API client | `main/ipc/seedvault.ts` |
| 6 | OpenClaw WebSocket client | `main/ipc/openclaw.ts` |
| 7 | Layout + Vault Browser UI | `Layout.tsx`, `FileTree.tsx`, `VaultBrowser.tsx` |
| 8 | BlockNote Editor | `Editor.tsx` |
| 9 | Chat Panel | `ChatPanel.tsx`, `MessageList.tsx` |
| 10 | Config & Settings | `main/ipc/config.ts`, `Settings.tsx` |
| 11 | Daemon management | `main/ipc/daemon.ts` |
| 12 | Integration smoke test | `tests/integration/app.test.ts` |
