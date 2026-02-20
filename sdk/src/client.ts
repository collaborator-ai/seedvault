/**
 * HTTP client for the Seedvault server API.
 */

import type {
  MeResponse,
  SignupResponse,
  InviteResponse,
  ContributorsResponse,
  FileWriteResponse,
  PutFileOptions,
  FilesResponse,
  SearchOptions,
  SearchResponse,
  ActivityOptions,
  ActivityResponse,
  HealthResponse,
  SubscribeOptions,
  VaultEvent,
} from "./types.js";
import { ApiError } from "./errors.js";
import { parseSSEStream } from "./sse.js";

export interface SeedvaultClient {
  /** GET /v1/me — resolve token to username */
  me(): Promise<MeResponse>;
  /** POST /v1/signup */
  signup(name: string, invite?: string): Promise<SignupResponse>;
  /** POST /v1/invites */
  createInvite(): Promise<InviteResponse>;
  /** GET /v1/contributors */
  listContributors(): Promise<ContributorsResponse>;
  /** DELETE /v1/contributors/:username */
  deleteContributor(username: string): Promise<void>;
  /** PUT /v1/files/:username/* */
  putFile(
    username: string,
    path: string,
    content: string,
    opts?: PutFileOptions,
  ): Promise<FileWriteResponse>;
  /** DELETE /v1/files/:username/* */
  deleteFile(username: string, path: string): Promise<void>;
  /** GET /v1/files?prefix=... */
  listFiles(prefix: string): Promise<FilesResponse>;
  /** GET /v1/files/:username/*path */
  getFile(username: string, path: string): Promise<string>;
  /** GET /v1/search?q=&contributor=&limit= */
  search(
    query: string,
    opts?: SearchOptions,
  ): Promise<SearchResponse>;
  /** GET /v1/activity?contributor=&action=&limit= */
  listActivity(opts?: ActivityOptions): Promise<ActivityResponse>;
  /** GET /health */
  health(): Promise<HealthResponse>;
  /** GET /v1/events — subscribe to real-time SSE events */
  subscribe(opts?: SubscribeOptions): AsyncGenerator<VaultEvent>;
}

/** Encode each path segment individually, preserving slashes */
function encodePath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

export function createClient(
  serverUrl: string,
  token?: string,
): SeedvaultClient {
  const base = serverUrl.replace(/\/+$/, "");

  async function request(
    method: string,
    path: string,
    opts: {
      body?: string;
      contentType?: string;
      auth?: boolean;
      extraHeaders?: Record<string, string>;
    } = {},
  ): Promise<Response> {
    const headers: Record<string, string> = {};
    if (opts.auth !== false && token) {
      headers["Authorization"] = `Bearer ${token}`;
    }
    if (opts.contentType) {
      headers["Content-Type"] = opts.contentType;
    }
    if (opts.extraHeaders) {
      Object.assign(headers, opts.extraHeaders);
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

    async signup(
      name: string,
      invite?: string,
    ): Promise<SignupResponse> {
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

    async deleteContributor(username: string): Promise<void> {
      await request(
        "DELETE",
        `/v1/contributors/${encodeURIComponent(username)}`,
      );
    },

    async putFile(
      username: string,
      path: string,
      content: string,
      opts?: PutFileOptions,
    ): Promise<FileWriteResponse> {
      const extraHeaders: Record<string, string> = {};
      if (opts?.originCtime)
        extraHeaders["X-Origin-Ctime"] = opts.originCtime;
      if (opts?.originMtime)
        extraHeaders["X-Origin-Mtime"] = opts.originMtime;
      const res = await request(
        "PUT",
        `/v1/files/${username}/${encodePath(path)}`,
        {
          body: content,
          contentType: "text/markdown",
          extraHeaders:
            Object.keys(extraHeaders).length > 0
              ? extraHeaders
              : undefined,
        },
      );
      return res.json();
    },

    async deleteFile(
      username: string,
      path: string,
    ): Promise<void> {
      await request(
        "DELETE",
        `/v1/files/${username}/${encodePath(path)}`,
      );
    },

    async listFiles(prefix: string): Promise<FilesResponse> {
      const qs = `?prefix=${encodeURIComponent(prefix)}`;
      const res = await request("GET", `/v1/files${qs}`);
      return res.json();
    },

    async getFile(
      username: string,
      path: string,
    ): Promise<string> {
      const res = await request(
        "GET",
        `/v1/files/${username}/${encodePath(path)}`,
      );
      return res.text();
    },

    async search(
      query: string,
      opts?: SearchOptions,
    ): Promise<SearchResponse> {
      const params = new URLSearchParams({ q: query });
      if (opts?.contributor)
        params.set("contributor", opts.contributor);
      if (opts?.limit) params.set("limit", String(opts.limit));
      const res = await request("GET", `/v1/search?${params}`);
      return res.json();
    },

    async listActivity(
      opts?: ActivityOptions,
    ): Promise<ActivityResponse> {
      const params = new URLSearchParams();
      if (opts?.contributor)
        params.set("contributor", opts.contributor);
      if (opts?.action) params.set("action", opts.action);
      if (opts?.limit) params.set("limit", String(opts.limit));
      const qs = params.toString();
      const res = await request(
        "GET",
        `/v1/activity${qs ? `?${qs}` : ""}`,
      );
      return res.json();
    },

    async health(): Promise<HealthResponse> {
      const res = await request("GET", "/health", { auth: false });
      return res.json();
    },

    async *subscribe(
      opts?: SubscribeOptions,
    ): AsyncGenerator<VaultEvent> {
      const MAX_BACKOFF = 60_000;
      let backoff = 1_000;

      while (true) {
        const controller = new AbortController();
        let res: Response;

        try {
          const headers: Record<string, string> = {};
          if (token) {
            headers["Authorization"] = `Bearer ${token}`;
          }

          res = await fetch(`${base}/v1/events`, {
            headers,
            signal: controller.signal,
          });

          if (!res.ok) {
            throw new ApiError(res.status, res.statusText);
          }
        } catch {
          if (controller.signal.aborted) return;
          await new Promise((r) => setTimeout(r, backoff));
          backoff = Math.min(backoff * 2, MAX_BACKOFF);
          continue;
        }

        backoff = 1_000;

        try {
          yield* parseSSEStream(res.body!, opts, controller);
        } catch {
          if (controller.signal.aborted) return;
          await new Promise((r) => setTimeout(r, backoff));
          backoff = Math.min(backoff * 2, MAX_BACKOFF);
          continue;
        }

        // Stream ended without error (server closed) — reconnect
        if (controller.signal.aborted) return;
        await new Promise((r) => setTimeout(r, backoff));
        backoff = Math.min(backoff * 2, MAX_BACKOFF);
      }
    },
  };
}
