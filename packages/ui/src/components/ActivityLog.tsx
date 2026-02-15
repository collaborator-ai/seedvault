import { useState } from "react";
import { useActivity } from "../hooks/useActivity.js";
import { useVaultEvents } from "../hooks/useVaultEvents.js";

interface ActivityLogProps {
  contributor?: string;
}

function relativeTime(iso: string): string {
  const date = new Date(iso);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMin = Math.floor(diffMs / 60_000);
  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHrs = Math.floor(diffMin / 60);
  if (diffHrs < 24) return `${diffHrs}h ago`;
  const diffDays = Math.floor(diffHrs / 24);
  return `${diffDays}d ago`;
}

function actionLabel(action: string): string {
  switch (action) {
    case "file_upserted":
      return "updated";
    case "file_deleted":
      return "deleted";
    case "contributor_added":
      return "joined";
    default:
      return action;
  }
}

export function ActivityLog({ contributor }: ActivityLogProps) {
  const { entries, loading, loadMore } = useActivity(
    contributor ? { contributor } : undefined,
  );

  const [, setRefreshKey] = useState(0);
  useVaultEvents(() => setRefreshKey((k) => k + 1));

  if (loading && entries.length === 0) {
    return (
      <div
        style={{
          padding: 16,
          color: "var(--sv-muted)",
          fontFamily: "var(--sv-font-sans)",
        }}
      >
        Loading activity...
      </div>
    );
  }

  return (
    <div style={{ fontFamily: "var(--sv-font-sans)" }}>
      <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
        {entries.map((event) => (
          <li
            key={event.id}
            style={{
              padding: "8px 12px",
              borderBottom: "0.8px solid var(--sv-border)",
              display: "flex",
              alignItems: "baseline",
              gap: 8,
            }}
          >
            <span
              style={{
                fontFamily: "var(--sv-font-mono)",
                fontSize: "0.8rem",
                color: "var(--sv-muted)",
                flexShrink: 0,
              }}
            >
              {event.contributor}
            </span>
            <span style={{ fontSize: "0.85rem" }}>
              {actionLabel(event.action)}
            </span>
            {event.detail && (
              <span
                style={{
                  fontFamily: "var(--sv-font-mono)",
                  fontSize: "0.8rem",
                  color: "var(--sv-muted)",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {event.detail}
              </span>
            )}
            <span
              style={{
                marginLeft: "auto",
                fontSize: "0.75rem",
                color: "var(--sv-muted)",
                flexShrink: 0,
              }}
            >
              {relativeTime(event.created_at)}
            </span>
          </li>
        ))}
      </ul>
      {entries.length > 0 && (
        <button
          type="button"
          onClick={loadMore}
          style={{
            display: "block",
            width: "100%",
            padding: "8px",
            border: "none",
            background: "var(--sv-muted-bg)",
            color: "var(--sv-muted)",
            cursor: "pointer",
            fontFamily: "var(--sv-font-mono)",
            fontSize: "0.8rem",
          }}
        >
          Load more
        </button>
      )}
    </div>
  );
}
