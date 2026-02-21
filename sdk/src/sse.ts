import type { VaultEvent, SubscribeOptions } from "./events.js";
import { parseVaultEvent, matchesFilter } from "./events.js";

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
          const event = parseVaultEvent(
            eventType,
            dataLines.join("\n"),
          );
          if (event && matchesFilter(event, opts)) {
            yield event;
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
