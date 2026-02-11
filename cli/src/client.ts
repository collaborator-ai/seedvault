/**
 * HTTP client for the Seedvault server API.
 */

export interface SeedvaultClient {
  /** POST /v1/signup */
  signup(name: string, invite?: string): Promise<SignupResponse>;
  /** POST /v1/invites */
  createInvite(): Promise<InviteResponse>;
  /** GET /v1/banks */
  listBanks(): Promise<BanksResponse>;
  /** PUT /v1/banks/:bankId/files/* */
  putFile(bankId: string, path: string, content: string): Promise<FileWriteResponse>;
  /** DELETE /v1/banks/:bankId/files/* */
  deleteFile(bankId: string, path: string): Promise<void>;
  /** GET /v1/banks/:bankId/files */
  listFiles(bankId: string, prefix?: string): Promise<FilesResponse>;
  /** GET /v1/banks/:bankId/files/* */
  getFile(bankId: string, path: string): Promise<string>;
  /** GET /health */
  health(): Promise<HealthResponse>;
}

// --- Response types ---

export interface SignupResponse {
  bank: { id: string; name: string; createdAt: string };
  token: string;
}

export interface InviteResponse {
  invite: string;
  createdAt: string;
}

export interface BanksResponse {
  banks: Array<{ id: string; name: string; createdAt: string }>;
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

    async listBanks(): Promise<BanksResponse> {
      const res = await request("GET", "/v1/banks");
      return res.json();
    },

    async putFile(bankId: string, path: string, content: string): Promise<FileWriteResponse> {
      const res = await request("PUT", `/v1/banks/${bankId}/files/${path}`, {
        body: content,
        contentType: "text/markdown",
      });
      return res.json();
    },

    async deleteFile(bankId: string, path: string): Promise<void> {
      await request("DELETE", `/v1/banks/${bankId}/files/${path}`);
    },

    async listFiles(bankId: string, prefix?: string): Promise<FilesResponse> {
      const qs = prefix ? `?prefix=${encodeURIComponent(prefix)}` : "";
      const res = await request("GET", `/v1/banks/${bankId}/files${qs}`);
      return res.json();
    },

    async getFile(bankId: string, path: string): Promise<string> {
      const res = await request("GET", `/v1/banks/${bankId}/files/${path}`);
      return res.text();
    },

    async health(): Promise<HealthResponse> {
      const res = await request("GET", "/health", { auth: false });
      return res.json();
    },
  };
}
