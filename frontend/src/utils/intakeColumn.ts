import type { Column } from "../types";

/**
 * The board's intake column: its first not-done column by position (#2298).
 *
 * Mirrors `_column_entries` in `backend/boards/services/flow_metrics.py`,
 * which `_bottleneck` reads as `[1:]` so the intake column is never named the
 * bottleneck (#2290). The role follows position, not identity, so it must be
 * derived from the current order rather than stored. The server's column list
 * has no archived columns (a column is deleted, not archived), so there is
 * nothing to skip beyond done columns.
 *
 * Array order is authoritative, not `position`: `useBoard.reorderColumns`
 * reorders `board.columns` optimistically and the server's new positions only
 * arrive after the response, so a position sort would name the wrong column in
 * between. The backend orders by position and the two agree once settled.
 * Pass the full `board.columns`, never a view-filtered list: hidden or
 * collapsed columns still count.
 */
export function firstNotDoneColumn(columns: readonly Column[]): Column | null {
  return columns.find((c) => !c.is_done) ?? null;
}

/** True when `column` is the board's intake column. */
export function isIntakeColumn(column: Column, columns: readonly Column[]): boolean {
  return !column.is_done && firstNotDoneColumn(columns)?.id === column.id;
}

/**
 * True when a new, not-done column inserted at `insertIndex` (an index into the
 * ordered `columns`; null appends at the end) would become the intake
 * column, i.e. no not-done column sits to its left.
 */
export function wouldBecomeIntakeColumn(
  columns: readonly Column[],
  insertIndex: number | null,
): boolean {
  // A negative index (a missing column's findIndex) is treated as 0.
  const left = insertIndex === null ? columns : columns.slice(0, Math.max(0, insertIndex));
  return !left.some((c) => !c.is_done);
}
