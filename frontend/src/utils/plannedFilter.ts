import type { CardPlannedFields } from "./plannedFields";

/**
 * The Planned filter on a child board (#2371 §2/§9, #2550): Any (the key is absent), "hide" (leave planned
 * children out) or "only" (show only them). Matched client-side on the card's own `planned` field, which the
 * board read sends to every reader of the card (Rule 19), so it needs no server parameter. Nothing is hidden by
 * default, and column counts and WIP meters still count the whole column.
 */
export type PlannedFilter = "hide" | "only";

export const PLANNED_FILTER_VALUES: readonly PlannedFilter[] = ["hide", "only"];

/** A stored, saved or URL value, or `undefined` (Any) for anything else. */
export function sanitizePlannedFilter(v: unknown): PlannedFilter | undefined {
  return v === "hide" || v === "only" ? v : undefined;
}

/** A card whose planned field was never read (`undefined`) counts as not planned, like the card face. */
export function matchesPlannedFilter(card: CardPlannedFields | undefined, f: PlannedFilter | undefined): boolean {
  if (f === undefined) return true;
  const planned = card?.planned === true;
  return f === "only" ? planned : !planned;
}

/** The panel row's value ("Hide planned" / "Only planned"), `null` for Any. */
export function plannedFilterLabel(f: PlannedFilter | undefined): string | null {
  return f === "hide" ? "Hide planned" : f === "only" ? "Only planned" : null;
}

/** The removable chip's text: "Planned: hidden" / "Planned: only". */
export function plannedFilterChipLabel(f: PlannedFilter): string {
  return f === "hide" ? "Planned: hidden" : "Planned: only";
}

/** The row appears when the board has planned cards, and always while its value isn't Any (§9). */
export function plannedFilterAvailable(cards: readonly CardPlannedFields[], f: PlannedFilter | undefined): boolean {
  return f !== undefined || cards.some((c) => c.planned === true);
}
