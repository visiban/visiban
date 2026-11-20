import type { Card, Column, CustomFieldDefinition, SubColumn, Swimlane } from "../types";
import type { ToastInput } from "./toastQueue";

/**
 * Gated stages (#1102) and tracks (#1920/#1921): pure derivations shared by
 * the grid, the phone board, the card face, the peek sheet and the keyboard
 * move path. The server owns the rules; these only read what it sends.
 *
 * - A stage with K+1 sub-columns has K implicit gates. A card's
 *   `gates_passed` is the index of its sub-column.
 * - A sub-column renders its cell's cards in `position` order: `position`
 *   stays scoped to the (column, lane) cell, never to the sub-column.
 * - Track state is derived client-side from the card's dimension value, the
 *   field's `choice_resolutions` and the lane's not-applicable marks. An
 *   unset or unmapped value is `open`. A lane mark overrides the card's own
 *   value (which the server keeps).
 */

/** A column's sub-columns when it is a gated stage, else `[]` (0 or >= 2, never 1). */
export function stageSubColumns(column: Pick<Column, "sub_columns"> | null | undefined): SubColumn[] {
  const subs = column?.sub_columns ?? [];
  return subs.length >= 2 ? [...subs].sort((a, b) => a.position - b.position) : [];
}

export function isGatedStage(column: Pick<Column, "sub_columns"> | null | undefined): boolean {
  return stageSubColumns(column).length >= 2;
}

/**
 * The sub-column index a card renders in. Clamped so a stale card copy (a
 * remap frame not yet applied) never vanishes from the grid.
 */
export function cardSubColumnIndex(card: Pick<Card, "gates_passed">, column: Pick<Column, "sub_columns">): number {
  const n = stageSubColumns(column).length;
  if (n === 0) return 0;
  const g = card.gates_passed ?? 0;
  return Math.max(0, Math.min(n - 1, g));
}

/** A cell's cards split per sub-column, each in `position` order. */
export function splitCellBySubColumn<T extends Pick<Card, "gates_passed" | "position">>(
  cards: T[],
  column: Pick<Column, "sub_columns">,
): T[][] {
  const n = stageSubColumns(column).length;
  if (n === 0) return [[...cards].sort((a, b) => a.position - b.position)];
  const out: T[][] = Array.from({ length: n }, () => []);
  for (const c of cards) out[cardSubColumnIndex(c, column)].push(c);
  return out.map((list) => list.sort((a, b) => a.position - b.position));
}

/** Gates still open on a card in this stage: the sub-columns after its own. */
export function gatesOpen(card: Pick<Card, "gates_passed">, column: Pick<Column, "sub_columns">): number {
  const n = stageSubColumns(column).length;
  if (n === 0) return 0;
  return n - 1 - cardSubColumnIndex(card, column);
}

/**
 * Warn-and-record only (#1102 phase 1): leaving a gated stage for another
 * column with gates open is allowed, recorded by the server
 * (`from_gates_open`), and named here so the mover knows. Never blocks.
 * Returns null when there is nothing to warn about.
 */
export function leftWithGatesOpenWarning(
  card: Pick<Card, "gates_passed" | "column">,
  fromColumn: Pick<Column, "id" | "name" | "sub_columns"> | undefined,
  toColumnId: number,
): string | null {
  if (!fromColumn || fromColumn.id !== card.column || toColumnId === fromColumn.id) return null;
  const open = gatesOpen(card, fromColumn);
  if (open <= 0) return null;
  // User-facing words are sub-columns; "gate" is internal (frontend/CLAUDE.md § Gated stages and tracks).
  const subs = stageSubColumns(fromColumn);
  const here = subs[cardSubColumnIndex(card, fromColumn)]?.name ?? "";
  return `Left ${fromColumn.name} in ${here}, before ${subs[subs.length - 1].name}`;
}

/**
 * The leave warning for a move of one or more cards to `toColumnId`, from
 * their pre-move copies. One card names its stage and sub-columns; several
 * are counted. Null when no card left a split stage early.
 */
export function leaveWarningForMove(
  cards: Pick<Card, "gates_passed" | "column">[],
  columns: Pick<Column, "id" | "name" | "sub_columns">[],
  toColumnId: number,
): string | null {
  const warnings = cards
    .map((c) => leftWithGatesOpenWarning(c, columns.find((col) => col.id === c.column), toColumnId))
    .filter((w): w is string => w !== null);
  if (warnings.length === 0) return null;
  if (warnings.length === 1) return warnings[0];
  return `${warnings.length} cards left a stage before its last sub-column`;
}

/**
 * The one place every Move surface raises the leave warning (drag, card menu,
 * bulk toolbar, peek, card detail, the forced move): a `warning` toast after
 * the move succeeded, announced by the toast region's polite live region.
 * Warn and record only (#1102 phase 1): it never blocks or confirms a move.
 */
export function notifyLeaveWarning(
  notify: (input: ToastInput) => number,
  cards: Pick<Card, "gates_passed" | "column">[],
  columns: Pick<Column, "id" | "name" | "sub_columns">[],
  toColumnId: number,
): void {
  const title = leaveWarningForMove(cards, columns, toColumnId);
  if (title) notify({ key: "gates-open-warning", variant: "warning", title, durationMs: 6000, testId: "gates-open-warning" });
}

/** One stop on the keyboard move path (#2327): a column, or a sub-column of a gated stage. */
export interface MoveStop {
  columnId: number;
  /** Sub-column index; undefined on a plain column. */
  gatesPassed?: number;
  label: string;
}

/** Every stop in board order: plain columns once, gated stages once per sub-column. */
export function moveStops(columns: Column[]): MoveStop[] {
  const out: MoveStop[] = [];
  for (const col of [...columns].sort((a, b) => a.position - b.position)) {
    const subs = stageSubColumns(col);
    if (subs.length === 0) {
      out.push({ columnId: col.id, label: col.name });
    } else {
      subs.forEach((s, i) => out.push({ columnId: col.id, gatesPassed: i, label: `${col.name}: ${s.name}` }));
    }
  }
  return out;
}

/** The index of the card's own stop in `moveStops(columns)`, or -1. */
export function currentStopIndex(card: Pick<Card, "column" | "gates_passed">, columns: Column[], stops = moveStops(columns)): number {
  const col = columns.find((c) => c.id === card.column);
  if (!col) return -1;
  const g = isGatedStage(col) ? cardSubColumnIndex(card, col) : undefined;
  return stops.findIndex((s) => s.columnId === col.id && s.gatesPassed === g);
}

/** UI state of one track on a card. UI copy says "done"; the API enum says `satisfied`. */
export type TrackState = "done" | "open" | "not_applicable";

export interface CardTrackState {
  /** The dimension field id. */
  id: number;
  name: string;
  state: TrackState;
  /** True when the state comes from the lane's not-applicable mark, not the card. */
  fromLane: boolean;
}

/** Per-card track states for the card's stage, in the stage's track order. */
export function getTrackStates(
  card: Pick<Card, "custom_field_values">,
  column: Pick<Column, "tracks"> | null | undefined,
  swimlane: Pick<Swimlane, "not_applicable_field_ids"> | null | undefined,
  definitions: CustomFieldDefinition[] | undefined,
): CardTrackState[] {
  const tracks = [...(column?.tracks ?? [])].sort((a, b) => a.position - b.position);
  if (tracks.length === 0) return [];
  const laneNa = new Set(swimlane?.not_applicable_field_ids ?? []);
  return tracks.map((t) => {
    if (laneNa.has(t.field_id)) return { id: t.field_id, name: t.name, state: "not_applicable" as const, fromLane: true };
    const def = definitions?.find((d) => d.id === t.field_id);
    const value = card.custom_field_values.find((v) => v.field_definition === t.field_id)?.value ?? "";
    const resolution = value ? def?.choice_resolutions?.[value] ?? "open" : "open";
    const state: TrackState = resolution === "satisfied" ? "done" : resolution === "not_applicable" ? "not_applicable" : "open";
    return { id: t.field_id, name: t.name, state, fromLane: false };
  });
}

/** "done", "open", "not applicable": the words for a track state (phone chips, screen readers). */
export function trackStateLabel(state: TrackState): string {
  return state === "done" ? "done" : state === "open" ? "open" : "not applicable";
}

/** Dimension fields never appear in generic custom-field lists or card pins (#1921). */
export function isDimensionField(def: Pick<CustomFieldDefinition, "is_dimension">): boolean {
  return def.is_dimension === true;
}

/**
 * Header count lines for a split stage: "Doing: 5 working", "Ready: 3 waiting".
 * The last sub-column is counted as waiting (spec § Sub-columns and tracks).
 */
export function subColumnCountLines(column: Column, cards: Pick<Card, "column" | "gates_passed">[]): string[] {
  return subColumnCounts(column, cards).map((s) => `${s.name}: ${s.count} ${s.state}`);
}

/** The same counts as structured cells, for the header's two-column summary (#2386). */
export function subColumnCounts(column: Column, cards: Pick<Card, "column" | "gates_passed">[]): { name: string; count: number; state: "working" | "waiting" }[] {
  const subs = stageSubColumns(column);
  if (subs.length === 0) return [];
  const counts = subs.map(() => 0);
  for (const c of cards) if (c.column === column.id) counts[cardSubColumnIndex(c, column)] += 1;
  return subs.map((s, i) => ({ name: s.name, count: counts[i], state: i === subs.length - 1 ? "waiting" : "working" }));
}

/** Names of the sub-columns either side of the card's own, for the Move to… steps (#2327). */
export function subColumnNeighbors(card: Pick<Card, "column" | "gates_passed">, columns: Column[]): { previous: string | null; next: string | null } | null {
  const col = columns.find((c) => c.id === card.column);
  const subs = stageSubColumns(col);
  if (!col || subs.length === 0) return null;
  const i = cardSubColumnIndex(card, col);
  return { previous: subs[i - 1]?.name ?? null, next: subs[i + 1]?.name ?? null };
}

/**
 * The sub-column note on a column-move history row (#1102): "left 2
 * sub-columns early" when the card left a split stage before its last
 * sub-column, "entered at sub-column 2" when it arrived past the first.
 * Recorded, never enforced. Null for none. The row carries only counts, not
 * the sub-column names (those may since have been renamed).
 */
export function movementGateNote(m: { from_gates_open?: number | null; to_gates_passed?: number | null }): string | null {
  const parts: string[] = [];
  const open = m.from_gates_open ?? 0;
  if (open > 0) parts.push(`left ${open} ${open === 1 ? "sub-column" : "sub-columns"} early`);
  const passed = m.to_gates_passed ?? 0;
  if (passed > 0) parts.push(`entered at sub-column ${passed + 1}`);
  return parts.length > 0 ? parts.join(", ") : null;
}

/**
 * The activity drawer row for a `card.moved` frame. A move inside a split
 * stage and a reorder carry no `movement` (docs/api/websockets.md), so the
 * sub-column comes from `gate_transitions` (the last one is where the card
 * landed; `actor` is a username). Never a blank detail.
 */
export function cardMovedActivity(d: Record<string, unknown>): { actor: string; headline: string; subject?: string; detail: string } {
  const card = d.card as { title?: string; gate_transitions?: unknown } | undefined;
  const movement = d.movement as { from_column_name?: string; to_column_name?: string; user?: { display_name?: string } } | undefined;
  type Transition = { actor?: string | null; sub_column_name?: string | null; kind?: string };
  const transitions = (d.gate_transitions ?? card?.gate_transitions) as Transition[] | undefined;
  const last = Array.isArray(transitions) && transitions.length > 0 ? transitions[transitions.length - 1] : undefined;
  const sub = movement ? undefined : last?.sub_column_name ?? undefined;
  const back = last?.kind === "reopen";
  const title = card?.title ?? "a card";
  return {
    actor: movement?.user?.display_name ?? last?.actor ?? "Someone",
    headline: sub ? `moved ${title} ${back ? "back " : ""}to ${sub}` : `moved ${title}`,
    subject: card?.title,
    detail: movement
      ? `${movement.from_column_name} → ${movement.to_column_name}`
      : sub ? `${back ? "Back to" : "On to"} ${sub}` : "Reordered within its cell",
  };
}
