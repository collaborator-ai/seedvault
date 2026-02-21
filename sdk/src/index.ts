export { createClient, type SeedvaultClient } from "./client.js";
export { ApiError } from "./errors.js";
export { parseVaultEvent, matchesFilter } from "./events.js";
export type {
  VaultEvent,
  VaultEventType,
  FileUpdatedEvent,
  FileDeletedEvent,
  ActivityVaultEvent,
  SubscribeOptions,
} from "./events.js";
export type {
  MeResponse,
  SignupResponse,
  InviteResponse,
  ContributorsResponse,
  FileWriteResponse,
  FileEntry,
  PutFileOptions,
  FilesResponse,
  SearchOptions,
  SearchResult,
  SearchResponse,
  ActivityEvent,
  ActivityOptions,
  ActivityResponse,
  HealthResponse,
} from "./types.js";
