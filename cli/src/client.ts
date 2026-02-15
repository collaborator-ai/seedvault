import {
  SeedvaultClient,
  SeedvaultError,
  type FileEntry,
  type SearchResult,
  type ActivityEvent,
  type Contributor,
  type FileContent,
  type PutFileOptions,
} from "@seedvault/sdk";

export { SeedvaultError as ApiError };
export type { FileEntry, SearchResult, ActivityEvent, Contributor, FileContent, PutFileOptions };
export type { SeedvaultClient };

export function createClient(
  server: string,
  token?: string,
): SeedvaultClient {
  return new SeedvaultClient({ baseUrl: server, token });
}
