export interface SeedvaultClientOptions {
  baseUrl: string;
  token?: string;
}

export interface Contributor {
  username: string;
  createdAt: string;
}

export interface SignupResult {
  contributor: Contributor;
  token: string;
}

export interface InviteResult {
  invite: string;
  createdAt: string;
}

export interface FileEntry {
  path: string;
  size: number;
  createdAt: string;
  modifiedAt: string;
}

export interface FileContent {
  content: string;
  path: string;
  createdAt: string;
  modifiedAt: string;
}

export interface SearchResult {
  contributor: string;
  path: string;
  snippet: string;
  rank: number;
}

export interface SearchOptions {
  contributor?: string;
  limit?: number;
}

export interface ActivityEvent {
  id: string;
  contributor: string;
  action: string;
  detail: string | null;
  created_at: string;
}

export interface ActivityOptions {
  contributor?: string;
  action?: string;
  limit?: number;
  offset?: number;
}

export interface PutFileOptions {
  originCtime?: string;
  originMtime?: string;
}

export type VaultEventType =
  | "file_updated"
  | "file_deleted"
  | "activity"
  | "connected";

export interface VaultEvent {
  type?: VaultEventType;
  path?: string;
  contributor?: string;
  action?: string;
  detail?: string | null;
}
