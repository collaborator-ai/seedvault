import type { Config } from "../config.js";
import type { SyncStatus } from "../api/sync.js";
import type { EventBus } from "./event-bus.js";
import type { FileEvent } from "./watcher.js";

export interface DaemonServerOptions {
  port: number;
  getConfig: () => Config;
  getStatus: () => SyncStatus;
  fileEvents: EventBus<FileEvent>;
  updateCollections?: (
    action: "add" | "remove",
    payload: { path?: string; name: string },
  ) => { error?: string };
}

export function createDaemonServer(options: DaemonServerOptions) {
  const { port, getConfig, getStatus, fileEvents, updateCollections } =
    options;

  function handleLocal(
    req: Request,
  ): Response | Promise<Response> | null {
    const url = new URL(req.url);

    if (req.method === "GET" && url.pathname === "/status") {
      const status = getStatus();
      const config = getConfig();
      return Response.json({
        ...status,
        serverUrl: config.server,
        username: config.username,
      });
    }

    if (req.method === "GET" && url.pathname === "/config") {
      const config = getConfig();
      return Response.json({
        server: config.server,
        username: config.username,
        collections: config.collections,
      });
    }

    if (req.method === "PUT" && url.pathname === "/config/collections") {
      return handleCollectionUpdate(req);
    }

    if (req.method === "GET" && url.pathname === "/events/local") {
      return handleLocalSSE();
    }

    return null;
  }

  async function handleCollectionUpdate(
    req: Request,
  ): Promise<Response> {
    if (!updateCollections) {
      return Response.json(
        { error: "Collection updates not supported" },
        { status: 501 },
      );
    }

    let body: { action: string; path?: string; name: string };
    try {
      body = await req.json();
    } catch {
      return Response.json(
        { error: "Invalid JSON body" },
        { status: 400 },
      );
    }

    if (body.action !== "add" && body.action !== "remove") {
      return Response.json(
        { error: "action must be 'add' or 'remove'" },
        { status: 400 },
      );
    }

    if (!body.name) {
      return Response.json(
        { error: "name is required" },
        { status: 400 },
      );
    }

    if (body.action === "add" && !body.path) {
      return Response.json(
        { error: "path is required for add action" },
        { status: 400 },
      );
    }

    const result = updateCollections(
      body.action as "add" | "remove",
      { path: body.path, name: body.name },
    );

    if (result.error) {
      return Response.json({ error: result.error }, { status: 400 });
    }

    return Response.json({ ok: true });
  }

  function handleLocalSSE(): Response {
    let unsub: (() => void) | null = null;

    const stream = new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder();
        controller.enqueue(encoder.encode(": connected\n\n"));
        unsub = fileEvents.subscribe((event) => {
          try {
            const data = JSON.stringify(event);
            controller.enqueue(
              encoder.encode(`event: file_changed\ndata: ${data}\n\n`),
            );
          } catch {
            unsub?.();
          }
        });
      },
      cancel() {
        unsub?.();
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  }

  const server = Bun.serve({
    port,
    hostname: "127.0.0.1",
    fetch(req) {
      if (req.method === "OPTIONS") {
        return new Response(null, {
          headers: {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods":
              "GET, PUT, POST, DELETE, OPTIONS",
            "Access-Control-Allow-Headers":
              "Content-Type, Authorization",
          },
        });
      }

      const localResponse = handleLocal(req);
      if (localResponse instanceof Promise) {
        return localResponse.then((res) => {
          res.headers.set("Access-Control-Allow-Origin", "*");
          return res;
        });
      }
      if (localResponse) {
        localResponse.headers.set("Access-Control-Allow-Origin", "*");
        return localResponse;
      }

      const url = new URL(req.url);

      if (
        url.pathname.startsWith("/v1/") ||
        url.pathname === "/health"
      ) {
        return proxyToRemote(req, url);
      }

      return Response.json({ error: "Not found" }, { status: 404 });
    },
  });

  async function proxyToRemote(
    req: Request,
    url: URL,
  ): Promise<Response> {
    const config = getConfig();
    const remoteUrl = `${config.server.replace(/\/+$/, "")}${url.pathname}${url.search}`;

    const headers = new Headers(req.headers);
    headers.set("Authorization", `Bearer ${config.token}`);
    headers.delete("host");
    // Request only encodings that browser webviews support.
    // Fly.io may respond with zstd which WKWebView cannot decode.
    headers.set("Accept-Encoding", "gzip, deflate, br");

    try {
      const remoteRes = await fetch(remoteUrl, {
        method: req.method,
        headers,
        body: req.body,
        // @ts-expect-error Bun supports duplex
        duplex: req.body ? "half" : undefined,
      });

      const responseHeaders = new Headers(remoteRes.headers);
      responseHeaders.set("Access-Control-Allow-Origin", "*");
      // Bun decompresses the upstream response, so drop encoding
      // headers to avoid the client trying to decompress again.
      responseHeaders.delete("Content-Encoding");
      responseHeaders.delete("Transfer-Encoding");

      return new Response(remoteRes.body, {
        status: remoteRes.status,
        statusText: remoteRes.statusText,
        headers: responseHeaders,
      });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return Response.json(
        { error: `Proxy error: ${msg}` },
        { status: 502 },
      );
    }
  }

  return server;
}
