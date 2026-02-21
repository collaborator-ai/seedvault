/**
 * SSE event contract — self-contained module (zero imports).
 *
 * Defines the discriminated union for all SSE event types broadcast
 * by the Seedvault server, plus parsing and filtering helpers.
 * Built as a standalone browser ES module for the web UI.
 */

export type VaultEventType =
  | "file_updated"
  | "file_deleted"
  | "activity";

export interface FileUpdatedEvent {
  type: "file_updated";
  id: string;
  contributor: string;
  path: string;
  size: number;
  modifiedAt: string;
}

export interface FileDeletedEvent {
  type: "file_deleted";
  id: string;
  contributor: string;
  path: string;
}

export interface ActivityVaultEvent {
  type: "activity";
  id: string;
  contributor: string;
  action: string;
  detail: string | null;
  created_at: string;
}

export type VaultEvent =
  | FileUpdatedEvent
  | FileDeletedEvent
  | ActivityVaultEvent;

export interface SubscribeOptions {
  /** Filter to a specific contributor. Omit for all. */
  contributor?: string;
  /** Filter to specific event types. Omit for all. */
  eventTypes?: VaultEventType[];
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function num(value: unknown): number {
  return typeof value === "number" ? value : 0;
}

/**
 * Parse a raw SSE event into a typed VaultEvent.
 * Returns null for unknown event types or malformed JSON.
 */
export function parseVaultEvent(
  eventType: string,
  jsonData: string,
): VaultEvent | null {
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(jsonData);
  } catch {
    return null;
  }

  switch (eventType) {
    case "file_updated":
      return {
        type: "file_updated",
        id: str(data.id),
        contributor: str(data.contributor),
        path: str(data.path),
        size: num(data.size),
        modifiedAt: str(data.modifiedAt),
      };

    case "file_deleted":
      return {
        type: "file_deleted",
        id: str(data.id),
        contributor: str(data.contributor),
        path: str(data.path),
      };

    case "activity":
      return {
        type: "activity",
        id: str(data.id),
        contributor: str(data.contributor),
        action: str(data.action),
        detail: typeof data.detail === "string" ? data.detail : null,
        created_at: str(data.created_at),
      };

    default:
      return null;
  }
}

/** Check whether an event passes the given filter options. */
export function matchesFilter(
  event: VaultEvent,
  opts?: SubscribeOptions,
): boolean {
  if (opts?.contributor && event.contributor !== opts.contributor) {
    return false;
  }
  if (opts?.eventTypes && !opts.eventTypes.includes(event.type)) {
    return false;
  }
  return true;
}
