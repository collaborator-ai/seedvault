import { SeedvaultClient } from "@seedvault/sdk";

export type {
  SeedvaultClientOptions,
  FileEntry,
  FileContent,
  SearchResult,
  SearchOptions,
  VaultEvent,
  VaultEventType,
  PutFileOptions,
} from "@seedvault/sdk";

export { SeedvaultClient, SeedvaultError } from "@seedvault/sdk";

/**
 * Create a seedvault server client.
 *
 * Wraps the SDK's SeedvaultClient with a simpler factory signature
 * so consumers don't need to construct the options object themselves.
 */
export function createClient(
  serverUrl: string,
  token?: string,
): SeedvaultClient {
  return new SeedvaultClient({ baseUrl: serverUrl, token });
}
