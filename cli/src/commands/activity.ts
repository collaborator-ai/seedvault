import { loadConfig } from "../config.js";
import { createClient } from "../client.js";

/**
 * sv activity [--contributor NAME] [--action TYPE] [--limit N]
 *
 * List activity log (GET /v1/activity).
 */
export async function activity(args: string[]): Promise<void> {
  let contributor: string | undefined;
  let action: string | undefined;
  let limit: number | undefined;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--contributor" && i + 1 < args.length) {
      contributor = args[++i];
    } else if (args[i] === "--action" && i + 1 < args.length) {
      action = args[++i];
    } else if (args[i] === "--limit" && i + 1 < args.length) {
      limit = parseInt(args[++i], 10);
    } else {
      console.error(
        "Usage: sv activity [--contributor NAME] [--action TYPE] [--limit N]"
      );
      process.exit(1);
    }
  }

  const config = loadConfig();
  const client = createClient(config.server, config.token);
  const events = await client.getActivity({
    contributor,
    action,
    limit,
  });

  for (const e of events) {
    const detail = e.detail ? ` ${e.detail}` : "";
    console.log(`${e.created_at} ${e.contributor} ${e.action}${detail}`);
  }
}
