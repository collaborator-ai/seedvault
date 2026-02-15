export const ITEM_ACCENT_COLORS = {
  note: "var(--sv-accent-note)",
  bookmark: "var(--sv-accent-bookmark)",
  pdf: "var(--sv-accent-pdf)",
  concept: "var(--sv-accent-concept)",
} as const;

export type ItemType = keyof typeof ITEM_ACCENT_COLORS;
