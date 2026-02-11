import { loadConfig } from "../config.js";
import { createClient } from "../client.js";

/**
 * sv ls [prefix]
 *
 * List files in your contributor, optionally filtered by prefix.
 */
export async function ls(args: string[]): Promise<void> {
  const config = loadConfig();
  const client = createClient(config.server, config.token);
  const prefix = args[0] || undefined;

  const { files } = await client.listFiles(config.username, prefix);

  if (files.length === 0) {
    console.log(prefix ? `No files matching '${prefix}'.` : "No files in your contributor.");
    return;
  }

  // Find widest path for alignment
  const maxPath = Math.max(...files.map((f) => f.path.length));

  for (const f of files) {
    const size = formatSize(f.size);
    const date = new Date(f.modifiedAt).toLocaleString();
    console.log(`  ${f.path.padEnd(maxPath + 2)} ${size.padStart(8)}  ${date}`);
  }

  console.log(`\n${files.length} file(s)`);
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
