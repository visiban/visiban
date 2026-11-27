import type { Card } from "../types";

/**
 * The Parent filter on a child board (#2209 row 10): Any (the key is absent), "any" (has a parent),
 * "none" (no parent), or one parent card's id. Matched client-side on `Card.parent` (#1104), so it needs
 * no server parameter and never asks the server about a parent the viewer cannot open.
 */
export type ParentFilter = "any" | "none" | number;

/** Upper bound of a parent id, mirrored in SavedFilterSerializer (pinned by filter_state_keys.json). */
export const PARENT_FILTER_MAX_ID = 2 ** 31 - 1;

/** A stored, saved or URL value, or `undefined` (Any) for anything else. */
export function sanitizeParentFilter(v: unknown): ParentFilter | undefined {
  if (v === "any" || v === "none") return v;
  if (typeof v === "number" && Number.isInteger(v) && v > 0 && v <= PARENT_FILTER_MAX_ID) return v;
  return undefined;
}

/** `f_parent` in a board URL: `any`, `none` or a card id. */
export function parseParentFilterParam(raw: string | null): ParentFilter | undefined {
  if (raw === null) return undefined;
  return sanitizeParentFilter(/^\d+$/.test(raw) ? Number(raw) : raw);
}

/**
 * Whether a card passes the filter. A card whose `parent` was never read (`undefined`, e.g. one appended
 * from a frame) counts as having none, the same as the card face. A parent the viewer cannot open still
 * counts for "any", but never matches a specific id: the read carries no id for it.
 */
export function matchesParentFilter(card: Pick<Card, "parent">, f: ParentFilter | undefined): boolean {
  if (f === undefined) return true;
  const p = card.parent ?? null;
  if (f === "none") return p === null;
  if (f === "any") return p !== null;
  return p !== null && !p.hidden && p.id === f;
}

/**
 * The specific parents the filter offers: only parents the viewer can open, read from the cards' own
 * `parent` (spec: "Options come only from parent boards the viewer can open"). Sorted by title.
 */
export function parentFilterOptions(cards: Pick<Card, "parent">[]): { id: number; title: string; label: string }[] {
  const seen = new Map<number, string>();
  for (const c of cards) {
    const p = c.parent;
    if (p && !p.hidden && !seen.has(p.id)) seen.set(p.id, p.title);
  }
  const titleCount = new Map<string, number>();
  for (const t of seen.values()) titleCount.set(t, (titleCount.get(t) ?? 0) + 1);
  // Two parents may share a title; the card id tells them apart (frontend/CLAUDE.md frontend/CLAUDE.md § Children tab (#2209), rule D).
  return [...seen]
    .map(([id, title]) => ({ id, title, label: (titleCount.get(title) ?? 0) > 1 ? `${title} (#${id})` : title }))
    .sort((a, b) => a.title.localeCompare(b.title) || a.id - b.id);
}

/**
 * The filter's value as the panel row and chip show it. An id no visible card names (its children left, or
 * the viewer lost the parent's board) still filters, so it reads as active without naming anything.
 */
export function parentFilterLabel(f: ParentFilter | undefined, cards: Pick<Card, "parent">[]): string | null {
  if (f === undefined) return null;
  if (f === "any") return "Any parent";
  if (f === "none") return "No parent";
  return parentFilterOptions(cards).find((o) => o.id === f)?.label ?? "A card not shown here";
}

/** Whether the Parent row is offered: a child-tier board with a linked card, or an active filter. */
export function parentFilterAvailable(
  board: { cards_can_have_children?: boolean; cards: Pick<Card, "parent">[] },
  f: ParentFilter | undefined,
): boolean {
  if (f !== undefined) return true;
  return !board.cards_can_have_children && board.cards.some((c) => c.parent != null);
}

/**
 * The Parent lane filter on a child board (#2370 way in 3): one lane id on a parent board. A card matches when
 * its own `parent` (#1104) is a parent the viewer can open in that lane, so a hidden parent never matches and the
 * server is never asked about a lane the viewer cannot see. Combines with the Parent filter (AND).
 */
export type ParentLaneFilter = number;

/** A stored, saved or URL lane id, or `undefined` (Any) for anything else. Same bound as the Parent filter. */
export function sanitizeParentLaneFilter(v: unknown): ParentLaneFilter | undefined {
  return typeof v === "number" && Number.isInteger(v) && v > 0 && v <= PARENT_FILTER_MAX_ID ? v : undefined;
}

/** `f_parent_lane` in a board URL: a lane id. */
export function parseParentLaneFilterParam(raw: string | null): ParentLaneFilter | undefined {
  return raw !== null && /^\d{1,10}$/.test(raw) ? sanitizeParentLaneFilter(Number(raw)) : undefined;
}

export function matchesParentLaneFilter(card: Pick<Card, "parent">, f: ParentLaneFilter | undefined): boolean {
  if (f === undefined) return true;
  const p = card.parent ?? null;
  return p !== null && !p.hidden && p.swimlane_id === f;
}

/**
 * The lanes the Parent lane row offers: only lanes of parents the viewer can open (so only lanes on parent
 * boards they can open), read from the cards' own `parent`. Two lanes that share a name carry their board.
 */
export function parentLaneFilterOptions(cards: Pick<Card, "parent">[]): { id: number; label: string }[] {
  const seen = new Map<number, { name: string; board: string }>();
  for (const c of cards) {
    const p = c.parent;
    if (p && !p.hidden && !seen.has(p.swimlane_id)) seen.set(p.swimlane_id, { name: p.swimlane_name, board: p.board_name });
  }
  const nameCount = new Map<string, number>();
  for (const v of seen.values()) nameCount.set(v.name, (nameCount.get(v.name) ?? 0) + 1);
  return [...seen]
    .map(([id, v]) => ({ id, name: v.name, label: (nameCount.get(v.name) ?? 0) > 1 ? `${v.name} (${v.board})` : v.name }))
    .sort((a, b) => a.label.localeCompare(b.label) || a.id - b.id)
    .map(({ id, label }) => ({ id, label }));
}

/** The row and chip value. A lane no visible card names still filters, so it reads as active without a name. */
export function parentLaneFilterLabel(f: ParentLaneFilter | undefined, cards: Pick<Card, "parent">[]): string | null {
  if (f === undefined) return null;
  return parentLaneFilterOptions(cards).find((o) => o.id === f)?.label ?? "A lane not shown here";
}
