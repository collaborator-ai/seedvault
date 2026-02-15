import { loadConfig } from "../config.js";
import { createClient } from "../client.js";

/**
 * sv grep <query> [--contributor NAME] [--limit N]
 *
 * Search vault content via FTS5 (GET /v1/search).
 */
export async function grep(args: string[]): Promise<void> {
  if (args.length === 0) {
    console.error("Usage: sv grep <query> [--contributor NAME] [--limit N]");
    process.exit(1);
  }

  let query = "";
  let contributor: string | undefined;
  let limit: number | undefined;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--contributor" && i + 1 < args.length) {
      contributor = args[++i];
    } else if (args[i] === "--limit" && i + 1 < args.length) {
      limit = parseInt(args[++i], 10);
    } else {
      query = query ? `${query} ${args[i]}` : args[i];
    }
  }

  if (!query) {
    console.error("Query is required");
    process.exit(1);
  }

  const config = loadConfig();
  const client = createClient(config.server, config.token);
  const results = await client.search(query, { contributor, limit });

  for (const r of results) {
    const snippet = r.snippet.replace(/<\/?b>/g, "");
    console.log(`${r.contributor}/${r.path}: ${snippet}`);
  }
}
