/**
 * What a parent-tier board calls its cards (#2212).
 *
 * The server sends `parent_name_singular` / `parent_name_plural` (and the
 * child-side `board_parent_name_singular`) raw; empty means the generic word.
 * Every surface that shows the name goes through these helpers, so the
 * "Parent" / "Parents" fallback lives in one place. Each field falls back on
 * its own. The name appears only in the child-side parent row and the parent
 * picker's helper line; never on the public share (frontend/CLAUDE.md).
 */
export const DEFAULT_PARENT_SINGULAR = "Parent";
export const DEFAULT_PARENT_PLURAL = "Parents";

export function parentSingular(raw: string | null | undefined): string {
  const name = (raw ?? "").trim();
  return name || DEFAULT_PARENT_SINGULAR;
}

export function parentPlural(raw: string | null | undefined): string {
  const name = (raw ?? "").trim();
  return name || DEFAULT_PARENT_PLURAL;
}

/** The custom plural, or null when the board has none (the picker omits its line). */
export function customParentPlural(raw: string | null | undefined): string | null {
  const name = (raw ?? "").trim();
  return name || null;
}
