export interface MeResponse {
  username: string;
  createdAt: string;
}

export interface SignupResponse {
  contributor: { username: string; createdAt: string };
  token: string;
}

export interface InviteResponse {
  invite: string;
  createdAt: string;
}

export interface ContributorsResponse {
  contributors: Array<{ username: string; createdAt: string }>;
}

export interface FileWriteResponse {
  path: string;
  size: number;
  createdAt: string;
  modifiedAt: string;
}

export interface FileEntry {
  path: string;
  size: number;
  createdAt: string;
  modifiedAt: string;
}

export interface PutFileOptions {
  originCtime?: string;
  originMtime?: string;
}

export interface FilesResponse {
  files: FileEntry[];
}

export interface SearchOptions {
  contributor?: string;
  limit?: number;
}

export interface SearchResult {
  contributor: string;
  path: string;
  snippet: string;
  rank: number;
}

export interface SearchResponse {
  results: SearchResult[];
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
}

export interface ActivityResponse {
  events: ActivityEvent[];
}

export interface HealthResponse {
  status: string;
}

