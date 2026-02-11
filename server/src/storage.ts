import { join, dirname, relative, sep } from "path";
import { mkdir, writeFile, unlink, readdir, stat, readFile, rename, rmdir } from "fs/promises";
import { existsSync } from "fs";
import { randomUUID } from "crypto";

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB

/** Validate a file path. Returns an error message or null if valid. */
export function validatePath(filePath: string): string | null {
  if (!filePath || filePath.length === 0) {
    return "Path cannot be empty";
  }
  if (filePath.startsWith("/")) {
    return "Path cannot start with /";
  }
  if (filePath.includes("\\")) {
    return "Path cannot contain backslashes";
  }
  if (filePath.includes("//")) {
    return "Path cannot contain double slashes";
  }
  if (!filePath.endsWith(".md")) {
    return "Path must end in .md";
  }

  // Check each segment for traversal
  const segments = filePath.split("/");
  for (const seg of segments) {
    if (seg === "." || seg === "..") {
      return "Path cannot contain . or .. segments";
    }
    if (seg.length === 0) {
      return "Path cannot contain empty segments";
    }
  }

  return null;
}

/** Resolve a validated file path to an absolute path on disk */
function resolvePath(storageRoot: string, contributorId: string, filePath: string): string {
  return join(storageRoot, contributorId, filePath);
}

/** Ensure the contributor directory exists */
export async function ensureContributorDir(storageRoot: string, contributorId: string): Promise<void> {
  const dir = join(storageRoot, contributorId);
  await mkdir(dir, { recursive: true });
}

/** Write a file atomically (temp file + rename) */
export async function writeFileAtomic(
  storageRoot: string,
  contributorId: string,
  filePath: string,
  content: string | Buffer
): Promise<{ path: string; size: number; modifiedAt: string }> {
  const contentBuf = typeof content === "string" ? Buffer.from(content) : content;

  if (contentBuf.length > MAX_FILE_SIZE) {
    throw new FileTooLargeError(contentBuf.length);
  }

  const absPath = resolvePath(storageRoot, contributorId, filePath);
  const dir = dirname(absPath);
  await mkdir(dir, { recursive: true });

  // Write to temp file then rename for atomicity
  const tmpPath = `${absPath}.tmp.${randomUUID().slice(0, 8)}`;
  try {
    await writeFile(tmpPath, contentBuf);
    await rename(tmpPath, absPath);
  } catch (e) {
    // Clean up temp file on failure
    try { await unlink(tmpPath); } catch {}
    throw e;
  }

  const fileStat = await stat(absPath);
  return {
    path: filePath,
    size: fileStat.size,
    modifiedAt: fileStat.mtime.toISOString(),
  };
}

/** Delete a file and clean up empty parent directories */
export async function deleteFile(
  storageRoot: string,
  contributorId: string,
  filePath: string
): Promise<void> {
  const absPath = resolvePath(storageRoot, contributorId, filePath);

  if (!existsSync(absPath)) {
    throw new FileNotFoundError(filePath);
  }

  await unlink(absPath);

  // Clean up empty parent directories up to the contributor root
  const contributorRoot = join(storageRoot, contributorId);
  let dir = dirname(absPath);
  while (dir !== contributorRoot && dir.startsWith(contributorRoot)) {
    try {
      await rmdir(dir); // only succeeds if empty
      dir = dirname(dir);
    } catch {
      break; // directory not empty, stop
    }
  }
}

/** Read a file's content */
export async function readFileContent(
  storageRoot: string,
  contributorId: string,
  filePath: string
): Promise<string> {
  const absPath = resolvePath(storageRoot, contributorId, filePath);

  if (!existsSync(absPath)) {
    throw new FileNotFoundError(filePath);
  }

  return await readFile(absPath, "utf-8");
}

export interface FileEntry {
  path: string;
  size: number;
  modifiedAt: string;
}

/** List all files in a contributor, optionally filtered by prefix */
export async function listFiles(
  storageRoot: string,
  contributorId: string,
  prefix?: string
): Promise<FileEntry[]> {
  const contributorRoot = join(storageRoot, contributorId);

  if (!existsSync(contributorRoot)) {
    return [];
  }

  const files: FileEntry[] = [];
  await walkDir(contributorRoot, contributorRoot, prefix, files);

  // Sort by modification time, newest first
  files.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
  return files;
}

async function walkDir(
  dir: string,
  contributorRoot: string,
  prefix: string | undefined,
  results: FileEntry[]
): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    // Directory may have been removed by a concurrent delete cleanup
    return;
  }

  for (const entry of entries) {
    const fullPath = join(dir, entry.name);

    if (entry.isDirectory()) {
      await walkDir(fullPath, contributorRoot, prefix, results);
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      const relPath = relative(contributorRoot, fullPath).split(sep).join("/");

      if (prefix && !relPath.startsWith(prefix)) {
        continue;
      }

      const fileStat = await stat(fullPath);
      results.push({
        path: relPath,
        size: fileStat.size,
        modifiedAt: fileStat.mtime.toISOString(),
      });
    }
  }
}

// --- Custom errors ---

export class FileNotFoundError extends Error {
  constructor(path: string) {
    super(`File not found: ${path}`);
    this.name = "FileNotFoundError";
  }
}

export class FileTooLargeError extends Error {
  public size: number;
  constructor(size: number) {
    super(`File too large: ${size} bytes (max ${MAX_FILE_SIZE})`);
    this.name = "FileTooLargeError";
    this.size = size;
  }
}
