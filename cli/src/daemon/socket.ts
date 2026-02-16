import { createServer, type Socket } from "net";
import { existsSync, unlinkSync } from "fs";

export interface DaemonFileEvent {
  action: "file_write" | "file_delete";
  path: string;
  collection: string;
  timestamp: string;
}

export interface DaemonSocketServer {
  broadcast(event: DaemonFileEvent): void;
  close(): Promise<void>;
}

export function createDaemonSocket(
  socketPath: string,
): Promise<DaemonSocketServer> {
  return new Promise((resolve, reject) => {
    const clients = new Set<Socket>();

    if (existsSync(socketPath)) {
      try {
        unlinkSync(socketPath);
      } catch {
        // Stale socket may already be gone
      }
    }

    const server = createServer((socket) => {
      clients.add(socket);
      socket.on("close", () => clients.delete(socket));
      socket.on("error", () => clients.delete(socket));
    });

    server.on("error", reject);

    server.listen(socketPath, () => {
      resolve({
        broadcast(event: DaemonFileEvent): void {
          const line = JSON.stringify(event) + "\n";
          for (const socket of clients) {
            try {
              socket.write(line);
            } catch {
              clients.delete(socket);
            }
          }
        },

        close(): Promise<void> {
          return new Promise((res) => {
            for (const socket of clients) {
              socket.destroy();
            }
            clients.clear();
            server.close(() => {
              try {
                unlinkSync(socketPath);
              } catch {
                // Socket file may already be gone
              }
              res();
            });
          });
        },
      });
    });
  });
}
