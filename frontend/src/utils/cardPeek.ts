import type { Card, CardMovement, Column, CustomFieldDefinition } from "../types";

/**
 * Pure derivations for the card peek sheet (#2273). Kept out of the component
 * so the time-in-column arithmetic and the status strip are testable alone.
 */

const DAY_MS = 86_400_000;

export interface PeekStatusStrip {
  previous: Column | null;
  current: Column | null;
  next: Column | null;
}

/** Previous, current and next stage by board order. Plain columns only (sub-columns: #1102). */
export function buildStatusStrip(card: Card, columns: Column[]): PeekStatusStrip {
  const ordered = [...columns].sort((a, b) => a.position - b.position);
  const i = ordered.findIndex((c) => c.id === card.column);
  if (i === -1) return { previous: null, current: null, next: null };
  return { previous: ordered[i - 1] ?? null, current: ordered[i], next: ordered[i + 1] ?? null };
}

/** One track's state on a card (#1920). */
export interface PeekTrackState {
  id: number;
  name: string;
  state: "done" | "open" | "not-applicable";
}

/**
 * Seam for per-card track states. The `Card` payload carries none today
 * (tracks arrive with #1920), so this returns no rows and the sheet renders no
 * track section. When #1920 lands, read the card's track fields here and the
 * sheet needs no change.
 */
export function getCardTrackStates(_card: Card): PeekTrackState[] {
  return [];
}

export interface ColumnDwell {
  /** Column id, or null when the column was deleted (name is then all that is left). */
  columnId: number | null;
  name: string;
  /** Whole days, rounded down; a visit under a day is 0. */
  days: number;
  ms: number;
  current: boolean;
}

/**
 * Time the card spent in each column, derived from its movement history. A
 * column visited twice is summed. Archive and unarchive rows do not move the
 * card, so they are skipped. The open visit runs to `now`.
 */
export function computeTimeInColumns(
  card: Card,
  movements: CardMovement[],
  columns: Column[],
  now: number = Date.now(),
): ColumnDwell[] {
  const moves = movements
    .filter((m) => m.movement_type === "move")
    .sort((a, b) => new Date(a.moved_at).getTime() - new Date(b.moved_at).getTime());
  if (moves.length === 0) return [];

  const order: string[] = [];
  const byKey = new Map<string, ColumnDwell>();
  const add = (columnId: number | null, name: string, ms: number) => {
    const key = columnId !== null ? `id:${columnId}` : `name:${name}`;
    const existing = byKey.get(key);
    if (existing) {
      existing.ms += ms;
      return;
    }
    order.push(key);
    byKey.set(key, { columnId, name, days: 0, ms, current: false });
  };

  // A first row that already has an origin means the card pre-dates the log:
  // its time in that origin runs from creation.
  const first = moves[0];
  if (first.from_column !== null || first.from_column_name) {
    const start = new Date(card.created_at).getTime();
    const end = new Date(first.moved_at).getTime();
    add(first.from_column, first.from_column_name, Math.max(0, end - start));
  }
  moves.forEach((m, i) => {
    const start = new Date(m.moved_at).getTime();
    const end = i + 1 < moves.length ? new Date(moves[i + 1].moved_at).getTime() : now;
    add(m.to_column, m.to_column_name, Math.max(0, end - start));
  });

  const nameOf = (id: number | null, fallback: string) =>
    (id !== null ? columns.find((c) => c.id === id)?.name : undefined) ?? fallback;
  return order.map((key) => {
    const d = byKey.get(key)!;
    return { ...d, name: nameOf(d.columnId, d.name), days: Math.floor(d.ms / DAY_MS), current: d.columnId === card.column };
  });
}

export interface PeekFieldRow {
  definition: CustomFieldDefinition;
  /** The stored value, or null when the card has none (rendered "Not set"). */
  value: string | null;
}

/** Every custom field in board order; empty or absent values come back null. */
export function buildFieldRows(card: Card, definitions: CustomFieldDefinition[]): PeekFieldRow[] {
  return [...definitions]
    .sort((a, b) => a.position - b.position)
    .map((definition) => {
      const v = card.custom_field_values.find((x) => x.field_definition === definition.id)?.value;
      return { definition, value: v === undefined || v === "" ? null : v };
    });
}

/** "2 of 8 pinned to the card". */
export function pinnedNote(definitions: CustomFieldDefinition[]): string {
  const pinned = definitions.filter((d) => d.show_on_card).length;
  return `${pinned} of ${definitions.length} pinned to the card`;
}

/** One history line: "Qualified to Discovery", "Created in Prospect", "Archived". */
export function describeMovement(m: CardMovement): string {
  if (m.movement_type === "archived") return "Archived";
  if (m.movement_type === "unarchived") return "Restored";
  if (!m.from_column_name && !m.from_column) return `Created in ${m.to_column_name || "a deleted column"}`;
  if (m.from_column === m.to_column && m.from_swimlane !== m.to_swimlane) {
    return `Moved to ${m.to_swimlane_name || "another lane"}`;
  }
  return `${m.from_column_name || "?"} to ${m.to_column_name || "?"}`;
}
