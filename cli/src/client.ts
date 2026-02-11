/**
 * HTTP client for the Seedvault server API.
 */

export interface SeedvaultClient {
  /** GET /v1/me — resolve token to username */
  me(): Promise<MeResponse>;
  /** POST /v1/signup */
  signup(name: string, invite?: string): Promise<SignupResponse>;
  /** POST /v1/invites */
  createInvite(): Promise<InviteResponse>;
  /** GET /v1/contributors */
  listContributors(): Promise<ContributorsResponse>;
  /** PUT /v1/files/:username/* */
  putFile(username: string, path: string, content: string): Promise<FileWriteResponse>;
  /** DELETE /v1/files/:username/* */
  deleteFile(username: string, path: string): Promise<void>;
  /** GET /v1/files?prefix=username/... */
  listFiles(username: string, prefix?: string): Promise<FilesResponse>;
  /** Read a file via sh("cat ...") */
  getFile(username: string, path: string): Promise<string>;
  /** POST /v1/sh — shell passthrough */
  sh(cmd: string): Promise<string>;
  /** GET /health */
  health(): Promise<HealthResponse>;
}

// --- Response types ---

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
  modifiedAt: string;
}

export interface FileEntry {
  path: string;
  size: number;
  modifiedAt: string;
}

export interface FilesResponse {
  files: FileEntry[];
}

export interface HealthResponse {
  status: string;
}

// --- Error ---

export class ApiError extends Error {
  public status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

// --- Implementation ---

/** Encode each path segment individually, preserving slashes */
function encodePath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

export function createClient(serverUrl: string, token?: string): SeedvaultClient {
  const base = serverUrl.replace(/\/+$/, "");

  async function request(
    method: string,
    path: string,
    opts: { body?: string; contentType?: string; auth?: boolean } = {}
  ): Promise<Response> {
    const headers: Record<string, string> = {};
    if (opts.auth !== false && token) {
      headers["Authorization"] = `Bearer ${token}`;
    }
    if (opts.contentType) {
      headers["Content-Type"] = opts.contentType;
    }

    const res = await fetch(`${base}${path}`, {
      method,
      headers,
      body: opts.body,
    });

    if (!res.ok) {
      let msg: string;
      try {
        const json = (await res.json()) as { error?: string };
        msg = json.error || res.statusText;
      } catch {
        msg = res.statusText;
      }
      throw new ApiError(res.status, msg);
    }

    return res;
  }

  return {
    async me(): Promise<MeResponse> {
      const res = await request("GET", "/v1/me");
      return res.json();
    },

    async signup(name: string, invite?: string): Promise<SignupResponse> {
      const body: Record<string, string> = { name };
      if (invite) body.invite = invite;
      const res = await request("POST", "/v1/signup", {
        body: JSON.stringify(body),
        contentType: "application/json",
        auth: false,
      });
      return res.json();
    },

    async createInvite(): Promise<InviteResponse> {
      const res = await request("POST", "/v1/invites");
      return res.json();
    },

    async listContributors(): Promise<ContributorsResponse> {
      const res = await request("GET", "/v1/contributors");
      return res.json();
    },

    async putFile(username: string, path: string, content: string): Promise<FileWriteResponse> {
      const res = await request("PUT", `/v1/files/${username}/${encodePath(path)}`, {
        body: content,
        contentType: "text/markdown",
      });
      return res.json();
    },

    async deleteFile(username: string, path: string): Promise<void> {
      await request("DELETE", `/v1/files/${username}/${encodePath(path)}`);
    },

    async listFiles(username: string, prefix?: string): Promise<FilesResponse> {
      const fullPrefix = prefix ? `${username}/${prefix}` : `${username}/`;
      const qs = `?prefix=${encodeURIComponent(fullPrefix)}`;
      const res = await request("GET", `/v1/files${qs}`);
      const data: FilesResponse = await res.json();
      // Strip username prefix from paths so syncer sees same data as before
      return {
        files: data.files.map((f) => ({
          ...f,
          path: f.path.startsWith(`${username}/`)
            ? f.path.slice(username.length + 1)
            : f.path,
        })),
      };
    },

    async getFile(username: string, path: string): Promise<string> {
      const fullPath = `${username}/${path}`;
      const res = await request("POST", "/v1/sh", {
        body: JSON.stringify({ cmd: `cat "${fullPath}"` }),
        contentType: "application/json",
      });
      const exitCode = parseInt(res.headers.get("X-Exit-Code") || "0", 10);
      if (exitCode !== 0) {
        const stderr = decodeURIComponent(res.headers.get("X-Stderr") || "");
        if (stderr.includes("No such file or directory")) {
          throw new ApiError(404, "File not found");
        }
        throw new ApiError(500, stderr || `cat exited with code ${exitCode}`);
      }
      return res.text();
    },

    async sh(cmd: string): Promise<string> {
      const res = await request("POST", "/v1/sh", {
        body: JSON.stringify({ cmd }),
        contentType: "application/json",
      });
      return res.text();
    },

    async health(): Promise<HealthResponse> {
      const res = await request("GET", "/health", { auth: false });
      return res.json();
    },
  };
}
