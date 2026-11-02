import type { Card, Column, ColumnPolicy, ColumnPolicyMode } from "../types";

/**
 * Explicit column policies (#1101): shared rules for the header affordance,
 * the editor, the drag messages and the confirm-on-entry checklist.
 *
 * The server validates the same limits (`boards/column_policy.py`); these
 * mirror them so the editor can stop at the cap instead of failing on save.
 * Nothing here is enforced by the server: "confirm on entry" is a client-side
 * acknowledgment, and the definition of done never blocks a move out.
 */

export const POLICY_MAX_CRITERIA = 8;
export const POLICY_CRITERION_MAX_LENGTH = 200;

/** The column's policy when it has at least one criterion, else null. */
export function columnPolicy(column: Pick<Column, "policy">): ColumnPolicy | null {
  const p = column.policy;
  if (!p) return null;
  return p.entry.length > 0 || p.done.length > 0 ? p : null;
}

function countPhrase(n: number, kind: "entry" | "done"): string {
  return `${n} ${kind} ${n === 1 ? "criterion" : "criteria"}`;
}

/** "3 entry criteria, 2 done criteria" — the counts in the header button's name. */
export function policyCountSummary(policy: ColumnPolicy): string {
  return `${countPhrase(policy.entry.length, "entry")}, ${countPhrase(policy.done.length, "done")}`;
}

export const POLICY_MODE_LABEL: Record<ColumnPolicyMode, string> = {
  advisory: "Advisory",
  confirm: "Confirm on entry",
};

/**
 * Entry criteria a card meets on its way into *column*: empty when the column
 * has none, or when the card is already in it (a move within a column is not
 * an entry).
 */
export function entryCriteriaFor(card: Pick<Card, "column">, column: Column): string[] {
  if (card.column === column.id) return [];
  return columnPolicy(column)?.entry ?? [];
}

/** Whether a drop of *card* into *column* opens the confirm checklist. */
export function needsEntryConfirm(card: Pick<Card, "column">, column: Column): boolean {
  return column.policy?.mode === "confirm" && entryCriteriaFor(card, column).length > 0;
}

/** The drag live region's sentence: "Entry criteria for 'Review': a; b." */
export function entryCriteriaSentence(columnName: string, criteria: string[]): string {
  return `Entry criteria for '${columnName}': ${criteria.join("; ")}.`;
}

/**
 * The value to save from the editor's drafts: criteria trimmed, blanks
 * dropped, and null when both lists end up empty (the server stores an empty
 * policy as null too, so the two never disagree).
 */
export function policyFromDraft(entry: string[], done: string[], mode: ColumnPolicyMode): ColumnPolicy | null {
  const clean = (list: string[]) => list.map((s) => s.trim()).filter((s) => s.length > 0);
  const e = clean(entry);
  const d = clean(done);
  if (e.length === 0 && d.length === 0) return null;
  return { v: 1, entry: e, done: d, mode };
}
