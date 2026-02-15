import { useState } from "react";
import { File, MagnifyingGlass } from "@phosphor-icons/react";
import { useSearch } from "../hooks/useSearch.js";

interface SearchPanelProps {
  onSelect?: (path: string) => void;
}

export function SearchPanel({ onSelect }: SearchPanelProps) {
  const [query, setQuery] = useState("");
  const { results, loading } = useSearch(query);

  return (
    <div style={{ fontFamily: "var(--sv-font-sans)" }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "8px 12px",
          borderBottom: "0.8px solid var(--sv-border)",
        }}
      >
        <MagnifyingGlass
          size={16}
          style={{ color: "var(--sv-muted)" }}
        />
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search vault..."
          style={{
            flex: 1,
            border: "none",
            outline: "none",
            background: "transparent",
            fontFamily: "var(--sv-font-mono)",
            fontSize: "0.85rem",
            color: "var(--sv-foreground)",
          }}
        />
      </div>
      {loading && (
        <div
          style={{
            padding: "12px",
            color: "var(--sv-muted)",
            fontSize: "0.85rem",
          }}
        >
          Searching...
        </div>
      )}
      <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
        {results.map((result, i) => (
          <li
            key={`${result.contributor}-${result.path}-${i}`}
            onClick={() =>
              onSelect?.(`${result.contributor}/${result.path}`)
            }
            style={{
              padding: "8px 12px",
              borderBottom: "0.8px solid var(--sv-border)",
              cursor: "pointer",
              transition: "var(--sv-transition)",
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.backgroundColor =
                "var(--sv-hover-bg)";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.backgroundColor =
                "transparent";
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
              }}
            >
              <File
                size={14}
                style={{
                  color: "var(--sv-accent-note)",
                  flexShrink: 0,
                }}
              />
              <span
                style={{
                  fontFamily: "var(--sv-font-mono)",
                  fontSize: "0.8rem",
                  color: "var(--sv-muted)",
                }}
              >
                {result.contributor}/
              </span>
              <span
                style={{
                  fontFamily: "var(--sv-font-mono)",
                  fontSize: "0.85rem",
                }}
              >
                {result.path}
              </span>
            </div>
            {result.snippet && (
              <div
                style={{
                  marginTop: 4,
                  fontSize: "0.8rem",
                  color: "var(--sv-muted)",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {result.snippet}
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
