import { loadConfig } from "../config.js";
import { createClient } from "../client.js";

/**
 * sv ls [username[/prefix]]
 *
 * No args: list contributors.
 * With path: list files for a contributor, optionally filtered by prefix.
 */
export async function ls(args: string[]): Promise<void> {
  const config = loadConfig();
  const client = createClient(config.server, config.token);

  if (args.length === 0) {
    const { contributors } = await client.listContributors();
    for (const c of contributors) {
      console.log(c.username);
    }
    return;
  }

  const input = args[0];
  const slashIdx = input.indexOf("/");
  const username = slashIdx === -1 ? input : input.slice(0, slashIdx);
  const prefix = slashIdx === -1 ? undefined : input.slice(slashIdx + 1) || undefined;

  const { files } = await client.listFiles(username, prefix);
  for (const f of files) {
    console.log(f.path);
  }
}
