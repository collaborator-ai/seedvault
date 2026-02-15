import { useMemo } from "react";
import {
  useReactTable,
  getCoreRowModel,
  flexRender,
  type ColumnDef,
} from "@tanstack/react-table";
import {
  File,
  BookmarkSimple,
  FilePdf,
  Lightbulb,
} from "@phosphor-icons/react";
import type { FileEntry } from "@seedvault/sdk";

interface VaultTableProps {
  files: FileEntry[];
  selectedPath?: string | undefined;
  onSelect: (path: string) => void;
  onDelete?: (path: string) => void;
}

function itemIcon(path: string) {
  if (path.endsWith(".pdf"))
    return (
      <FilePdf
        weight="fill"
        style={{ color: "var(--sv-accent-pdf)" }}
      />
    );
  if (
    path.includes("/bookmarks/") ||
    path.startsWith("bookmarks/")
  )
    return (
      <BookmarkSimple
        weight="fill"
        style={{ color: "var(--sv-accent-bookmark)" }}
      />
    );
  if (path.includes("/concepts/") || path.startsWith("concepts/"))
    return (
      <Lightbulb
        weight="fill"
        style={{ color: "var(--sv-accent-concept)" }}
      />
    );
  return (
    <File
      weight="fill"
      style={{ color: "var(--sv-accent-note)" }}
    />
  );
}

function relativeDate(iso: string): string {
  const date = new Date(iso);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffDays = Math.floor(diffMs / 86_400_000);
  if (diffDays === 0) return "Today";
  if (diffDays === 1) return "Yesterday";
  if (diffDays < 7) return `${diffDays}d ago`;
  return date.toLocaleDateString();
}

function fileName(path: string): string {
  const name = path.split("/").pop() ?? path;
  return name.replace(/\.md$/, "");
}

export function VaultTable({
  files,
  selectedPath,
  onSelect,
}: VaultTableProps) {
  const columns = useMemo<ColumnDef<FileEntry>[]>(
    () => [
      {
        id: "icon",
        size: 32,
        cell: ({ row }) => itemIcon(row.original.path),
      },
      {
        accessorKey: "path",
        header: "Name",
        cell: ({ row }) => (
          <span
            style={{
              fontFamily: "var(--sv-font-mono)",
              fontSize: "0.85rem",
            }}
          >
            {fileName(row.original.path)}
          </span>
        ),
      },
      {
        accessorKey: "modifiedAt",
        header: "Modified",
        size: 80,
        cell: ({ row }) => (
          <span
            style={{
              fontFamily: "var(--sv-font-mono)",
              fontSize: "0.75rem",
              color: "var(--sv-muted)",
            }}
          >
            {relativeDate(row.original.modifiedAt)}
          </span>
        ),
      },
    ],
    [],
  );

  const table = useReactTable({
    data: files,
    columns,
    getCoreRowModel: getCoreRowModel(),
  });

  return (
    <div style={{ fontFamily: "var(--sv-font-sans)" }}>
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <tbody>
          {table.getRowModel().rows.map((row) => (
            <tr
              key={row.original.path}
              onClick={() => onSelect(row.original.path)}
              style={{
                cursor: "pointer",
                backgroundColor:
                  row.original.path === selectedPath
                    ? "var(--sv-hover-bg)"
                    : "transparent",
                transition: "var(--sv-transition)",
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.backgroundColor =
                  "var(--sv-hover-bg)";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.backgroundColor =
                  row.original.path === selectedPath
                    ? "var(--sv-hover-bg)"
                    : "transparent";
              }}
            >
              {row.getVisibleCells().map((cell) => (
                <td
                  key={cell.id}
                  style={{
                    padding: "6px 8px",
                    borderBottom:
                      "0.8px solid var(--sv-border)",
                  }}
                >
                  {flexRender(
                    cell.column.columnDef.cell,
                    cell.getContext(),
                  )}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
