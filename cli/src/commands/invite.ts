import { loadConfig } from "../config.js";
import { createClient, ApiError } from "../client.js";

/**
 * sv invite
 *
 * Generate an invite code (operator only).
 */
export async function invite(): Promise<void> {
  const config = loadConfig();
  const client = createClient(config.server, config.token);

  try {
    const result = await client.createInvite();
    console.log(`Invite code: ${result.invite}`);
    console.log(`\nShare this with the person you want to invite.`);
    console.log(`They can sign up with:`);
    console.log(`  sv init --server ${config.server} --name <name> --invite ${result.invite}`);
  } catch (e) {
    if (e instanceof ApiError && e.status === 403) {
      console.error("Only the operator can generate invite codes.");
      process.exit(1);
    }
    throw e;
  }
}
