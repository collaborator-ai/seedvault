/**
 * Re-exports from @seedvault/sdk.
 *
 * CLI commands import from this file for convenience.
 * The actual client implementation lives in @seedvault/sdk.
 */
export {
  createClient,
  ApiError,
  parseVaultEvent,
  matchesFilter,
  type SeedvaultClient,
  type MeResponse,
  type SignupResponse,
  type InviteResponse,
  type ContributorsResponse,
  type FileWriteResponse,
  type FileEntry,
  type PutFileOptions,
  type FilesResponse,
  type SearchOptions,
  type SearchResult,
  type SearchResponse,
  type ActivityEvent,
  type ActivityOptions,
  type ActivityResponse,
  type HealthResponse,
  type SubscribeOptions,
  type VaultEvent,
  type VaultEventType,
  type FileUpdatedEvent,
  type FileDeletedEvent,
  type ActivityVaultEvent,
} from "@seedvault/sdk";
