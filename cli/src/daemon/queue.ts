import type { SeedvaultClient } from "../client.js";
import { ApiError } from "../client.js";

// --- Types ---

export interface QueuedOperation {
  type: "put" | "delete";
  username: string;
  serverPath: string;
  /** For put operations, the file content. Null for deletes. */
  content: string | null;
  /** Timestamp when the operation was queued */
  queuedAt: string;
}

// --- Queue ---

const MIN_BACKOFF = 1000;   // 1s
const MAX_BACKOFF = 60000;  // 60s

export class RetryQueue {
  private items: QueuedOperation[] = [];
  private flushing = false;
  private backoff = MIN_BACKOFF;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private client: SeedvaultClient;
  private onStatus: (msg: string) => void;

  constructor(client: SeedvaultClient, onStatus: (msg: string) => void = () => {}) {
    this.client = client;
    this.onStatus = onStatus;
  }

  /** Enqueue an operation. If online, flushes immediately. */
  enqueue(op: QueuedOperation): void {
    this.items.push(op);
    this.scheduleFlush(0);
  }

  /** Number of pending operations */
  get pending(): number {
    return this.items.length;
  }

  /** Stop the queue (cancel pending flush) */
  stop(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
  }

  // --- Internal ---

  private scheduleFlush(delayMs: number): void {
    if (this.flushing || this.flushTimer) return;
    if (this.items.length === 0) return;

    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flush();
    }, delayMs);
  }

  private async flush(): Promise<void> {
    if (this.flushing || this.items.length === 0) return;
    this.flushing = true;

    while (this.items.length > 0) {
      const op = this.items[0];
      try {
        if (op.type === "put" && op.content !== null) {
          await this.client.putFile(op.username, op.serverPath, op.content);
        } else if (op.type === "delete") {
          await this.client.deleteFile(op.username, op.serverPath);
        }

        // Success — remove from queue and reset backoff
        this.items.shift();
        this.backoff = MIN_BACKOFF;
      } catch (e: unknown) {
        // API errors (4xx) mean the server is reachable but the op is invalid —
        // drop the op and continue flushing.
        if (e instanceof ApiError && e.status >= 400 && e.status < 500) {
          this.onStatus(`Dropping failed op: ${op.type} ${op.serverPath} (${e.status})`);
          this.items.shift();
          continue;
        }

        // Network error — stop flushing, schedule retry
        const errMsg = e instanceof Error ? e.message : String(e);
        this.onStatus(
          `Server unreachable (${errMsg}), ${this.items.length} op(s) queued. Retry in ${this.backoff / 1000}s.`
        );
        this.flushing = false;
        this.scheduleFlush(this.backoff);
        this.backoff = Math.min(this.backoff * 2, MAX_BACKOFF);
        return;
      }
    }

    this.flushing = false;
    if (this.items.length === 0) {
      this.onStatus("Queue flushed — all synced.");
    }
  }
}
