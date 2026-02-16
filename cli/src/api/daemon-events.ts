import { createConnection } from "net";
import { join } from "path";
import { homedir } from "os";
import type { DaemonFileEvent } from "../daemon/socket.js";

const DEFAULT_SOCKET_PATH = join(
  homedir(),
  ".config",
  "seedvault",
  "daemon.sock",
);

export type { DaemonFileEvent };

export async function* subscribeDaemonEvents(
  socketPath: string = DEFAULT_SOCKET_PATH,
): AsyncGenerator<DaemonFileEvent> {
  const socket = createConnection(socketPath);
  let buffer = "";
  let done = false;

  const queue: DaemonFileEvent[] = [];
  let resolve: (() => void) | null = null;
  let rejectFn: ((err: Error) => void) | null = null;

  function notify(): void {
    if (resolve) {
      const r = resolve;
      resolve = null;
      rejectFn = null;
      r();
    }
  }

  socket.on("data", (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split("\n");
    buffer = lines.pop()!;

    for (const line of lines) {
      if (line.trim() === "") continue;
      try {
        queue.push(JSON.parse(line) as DaemonFileEvent);
      } catch {
        // Skip malformed lines
      }
    }
    notify();
  });

  socket.on("end", () => {
    done = true;
    notify();
  });

  socket.on("error", (err) => {
    done = true;
    if (rejectFn) {
      const r = rejectFn;
      resolve = null;
      rejectFn = null;
      r(err);
    }
  });

  await new Promise<void>((res, rej) => {
    socket.on("connect", res);
    socket.on("error", rej);
  });

  try {
    while (true) {
      while (queue.length > 0) {
        yield queue.shift()!;
      }
      if (done) break;
      await new Promise<void>((res, rej) => {
        resolve = res;
        rejectFn = rej;
      });
    }
  } finally {
    socket.destroy();
  }
}
