import type { VaultEvent, SubscribeOptions } from "./types.js";

/** Map server SSE event names to VaultEvent action names */
const SSE_ACTION_MAP: Record<string, "file_write" | "file_delete"> = {
  file_updated: "file_write",
  file_deleted: "file_delete",
};

export async function* parseSSEStream(
  body: ReadableStream<Uint8Array>,
  opts: SubscribeOptions | undefined,
  controller: AbortController,
): AsyncGenerator<VaultEvent> {
  const decoder = new TextDecoder();
  const reader = body.getReader();
  let buffer = "";
  let eventType = "";
  let dataLines: string[] = [];

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop()!;

      for (const line of lines) {
        if (line.startsWith("event: ")) {
          eventType = line.slice(7).trim();
        } else if (line.startsWith("data: ")) {
          dataLines.push(line.slice(6));
        } else if (line === "" && eventType && dataLines.length > 0) {
          const action = SSE_ACTION_MAP[eventType];
          if (action) {
            let data: Record<string, unknown>;
            try {
              data = JSON.parse(dataLines.join("\n"));
            } catch {
              eventType = "";
              dataLines = [];
              continue;
            }
            const event: VaultEvent = {
              id: (data.id as string) ?? "",
              action,
              contributor: (data.contributor as string) ?? "",
              path: (data.path as string) ?? "",
              timestamp:
                (data.modifiedAt as string) ??
                (data.created_at as string) ??
                new Date().toISOString(),
            };

            const passContributor =
              !opts?.contributor ||
              event.contributor === opts.contributor;
            const passAction =
              !opts?.actions ||
              opts.actions.includes(event.action);

            if (passContributor && passAction) {
              yield event;
            }
          }
          eventType = "";
          dataLines = [];
        } else if (line === "") {
          eventType = "";
          dataLines = [];
        }
      }
    }
  } finally {
    reader.releaseLock();
    controller.abort();
  }
}
