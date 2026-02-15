import { SeedvaultError } from "./error.js";
import type {
  SeedvaultClientOptions,
  Contributor,
  SignupResult,
  InviteResult,
  FileEntry,
  FileContent,
  SearchResult,
  SearchOptions,
  ActivityEvent,
  ActivityOptions,
  PutFileOptions,
  VaultEvent,
} from "./types.js";

export class SeedvaultClient {
  private readonly baseUrl: string;
  private readonly token: string | undefined;

  constructor(options: SeedvaultClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.token = options.token;
  }

  private async request(
    method: string,
    path: string,
    opts: {
      body?: string;
      contentType?: string;
      auth?: boolean;
      headers?: Record<string, string>;
    } = {},
  ): Promise<Response> {
    const headers: Record<string, string> = {};

    if (opts.auth !== false && this.token) {
      headers["Authorization"] = `Bearer ${this.token}`;
    }
    if (opts.contentType) {
      headers["Content-Type"] = opts.contentType;
    }
    if (opts.headers) {
      Object.assign(headers, opts.headers);
    }

    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers,
      ...(opts.body != null ? { body: opts.body } : {}),
    });

    if (!res.ok) {
      let msg: string;
      try {
        const json = (await res.json()) as { error?: string };
        msg = json.error ?? res.statusText;
      } catch {
        msg = res.statusText;
      }
      throw new SeedvaultError(res.status, msg);
    }

    return res;
  }

  private encodePath(path: string): string {
    return path
      .split("/")
      .map((s) => encodeURIComponent(s))
      .join("/");
  }

  // --- Auth ---

  async signup(
    name: string,
    invite?: string,
  ): Promise<SignupResult> {
    const body: Record<string, string> = { name };
    if (invite) body["invite"] = invite;

    const res = await this.request("POST", "/v1/signup", {
      body: JSON.stringify(body),
      contentType: "application/json",
      auth: false,
    });
    return res.json();
  }

  async me(): Promise<Contributor> {
    const res = await this.request("GET", "/v1/me");
    return res.json();
  }

  // --- Contributors ---

  async listContributors(): Promise<Contributor[]> {
    const res = await this.request("GET", "/v1/contributors");
    const data: { contributors: Contributor[] } = await res.json();
    return data.contributors;
  }

  async deleteContributor(username: string): Promise<void> {
    await this.request(
      "DELETE",
      `/v1/contributors/${encodeURIComponent(username)}`,
    );
  }

  // --- Invites ---

  async createInvite(): Promise<InviteResult> {
    const res = await this.request("POST", "/v1/invites");
    return res.json();
  }

  // --- Files ---

  async listFiles(prefix?: string): Promise<FileEntry[]> {
    const query = prefix
      ? `?prefix=${encodeURIComponent(prefix)}`
      : "";
    const res = await this.request("GET", `/v1/files${query}`);
    const data: { files: FileEntry[] } = await res.json();
    return data.files;
  }

  async readFile(path: string): Promise<FileContent> {
    const res = await this.request(
      "GET",
      `/v1/files/${this.encodePath(path)}`,
    );
    const content = await res.text();
    return {
      content,
      path,
      createdAt: res.headers.get("X-Created-At") ?? "",
      modifiedAt: res.headers.get("X-Modified-At") ?? "",
    };
  }

  async writeFile(
    path: string,
    content: string,
    opts?: PutFileOptions,
  ): Promise<FileEntry> {
    const headers: Record<string, string> = {};
    if (opts?.originCtime) {
      headers["X-Origin-Ctime"] = opts.originCtime;
    }
    if (opts?.originMtime) {
      headers["X-Origin-Mtime"] = opts.originMtime;
    }
    const res = await this.request(
      "PUT",
      `/v1/files/${this.encodePath(path)}`,
      {
        body: content,
        contentType: "text/markdown",
        ...(Object.keys(headers).length > 0 ? { headers } : {}),
      },
    );
    return res.json();
  }

  async deleteFile(path: string): Promise<void> {
    await this.request(
      "DELETE",
      `/v1/files/${this.encodePath(path)}`,
    );
  }

  // --- Search ---

  async search(
    query: string,
    opts?: SearchOptions,
  ): Promise<SearchResult[]> {
    const params = new URLSearchParams({ q: query });
    if (opts?.contributor) params.set("contributor", opts.contributor);
    if (opts?.limit) params.set("limit", String(opts.limit));

    const res = await this.request(
      "GET",
      `/v1/search?${params.toString()}`,
    );
    const data: { results: SearchResult[] } = await res.json();
    return data.results;
  }

  // --- Activity ---

  async getActivity(
    opts?: ActivityOptions,
  ): Promise<ActivityEvent[]> {
    const params = new URLSearchParams();
    if (opts?.contributor) params.set("contributor", opts.contributor);
    if (opts?.action) params.set("action", opts.action);
    if (opts?.limit) params.set("limit", String(opts.limit));
    if (opts?.offset) params.set("offset", String(opts.offset));

    const qs = params.toString();
    const res = await this.request(
      "GET",
      `/v1/activity${qs ? `?${qs}` : ""}`,
    );
    const data: { events: ActivityEvent[] } = await res.json();
    return data.events;
  }

  // --- SSE ---

  async *subscribe(
    opts?: { signal?: AbortSignal },
  ): AsyncGenerator<VaultEvent> {
    const res = await this.request("GET", "/v1/events", {
      headers: { Accept: "text/event-stream" },
    });

    if (!res.body) return;

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      for (;;) {
        if (opts?.signal?.aborted) break;

        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (line.startsWith("data: ")) {
            try {
              yield JSON.parse(line.slice(6)) as VaultEvent;
            } catch {
              // skip malformed event data
            }
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  // --- Health ---

  async health(): Promise<boolean> {
    try {
      await this.request("GET", "/health", { auth: false });
      return true;
    } catch {
      return false;
    }
  }
}
