import type { ImportSummary } from "../types";

/** How long the post-import notice stays before dismissing itself. */
export const IMPORT_SKIPPED_TOAST_MS = 8000;

/** At most this many counts are spelled out; the rest collapse to "and N more". */
const MAX_LISTED = 3;

/**
 * The post-import notice copy, or `null` when nothing was skipped (#119):
 * "Board imported. Skipped: 12 cards, 30 comments, 4 card labels."
 * Movements and activity entries are reported together as history entries.
 * Only non-zero counts, singular for 1, at most three then "and N more".
 */
export function formatImportSkipped(summary: ImportSummary | null | undefined): string | null {
  const skipped = summary?.skipped;
  if (!skipped) return null;
  const items: { n: number; one: string; many: string }[] = [
    { n: skipped.cards ?? 0, one: "card", many: "cards" },
    { n: skipped.comments ?? 0, one: "comment", many: "comments" },
    { n: skipped.checklist_items ?? 0, one: "checklist item", many: "checklist items" },
    { n: skipped.label_refs ?? 0, one: "card label", many: "card labels" },
    {
      n: (skipped.movements ?? 0) + (skipped.activities ?? 0),
      one: "history entry",
      many: "history entries",
    },
  ];
  const parts = items.filter(({ n }) => n > 0).map(({ n, one, many }) => `${n} ${n === 1 ? one : many}`);
  if (parts.length === 0) return null;
  const listed = parts.slice(0, MAX_LISTED);
  const rest = parts.length - listed.length;
  if (rest > 0) listed.push(`and ${rest} more`);
  return `Board imported. Skipped: ${listed.join(", ")}.`;
}

/** True when the import left anything out, i.e. the notice should be shown. */
export function hasImportSkips(summary: ImportSummary | null | undefined): boolean {
  return formatImportSkipped(summary) !== null;
}
