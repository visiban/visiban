/** Copy for the redesigned board states (#2324); kept apart from BoardStates.tsx for fast refresh. */
import type { ShowChipKey } from "../../utils/showChips";

/** The empty board's sentence, dropping the clauses the viewer cannot act on. */
export function emptyBoardSentence(firstColumnName: string, canAdd: boolean, canImport: boolean): string {
  if (canAdd && canImport) return `Add the first card to ${firstColumnName}, or import cards from a file.`;
  if (canAdd) return `Add the first card to ${firstColumnName}.`;
  if (canImport) return "Import cards from a file to get started.";
  return "Cards added to this board will show up here.";
}

/**
 * #2324 — the line under the lanes when filters or a Show chip match no card.
 * The chip gets its own line when it is the cause (the Filter panel alone still
 * matches cards, or no panel filter is set); otherwise the panel is the cause.
 */
export function noMatchLine(chip: ShowChipKey, panelMatchCount: number | null): string {
  if (chip !== "all" && (panelMatchCount === null || panelMatchCount > 0)) {
    return chip === "overdue" ? "No cards are overdue" : chip === "stale" ? "No cards are stale" : "No cards are due soon";
  }
  return "No cards match the active filters";
}
