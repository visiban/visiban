/**
 * Which card detail tab opens (#967, design A-Q7).
 *
 * Kept in module memory, not storage: it lasts for the page session, across
 * card swaps (BoardView remounts CardDetail per card) and closes, so Jordan
 * can step through cards on History. It is deliberately not persisted: a
 * stored "History" would hide comments from an occasional user on their next
 * visit. A deep link (`?card=…&tab=comments`) overrides it.
 */
export type CardDetailTab = "details" | "comments" | "history";

export const CARD_DETAIL_TABS: readonly CardDetailTab[] = ["details", "comments", "history"];

let lastTab: CardDetailTab = "details";

export function getRememberedCardDetailTab(): CardDetailTab {
  return lastTab;
}

export function rememberCardDetailTab(tab: CardDetailTab): void {
  lastTab = tab;
}

/** Parse a `?tab=` value; unknown values are `null` so the caller keeps session memory. */
export function parseCardDetailTab(value: string | null | undefined): CardDetailTab | null {
  return CARD_DETAIL_TABS.includes(value as CardDetailTab) ? (value as CardDetailTab) : null;
}

/** Page size of the History tab, shared so CardDetail's first page matches the panel's paging. */
export const HISTORY_PAGE_LIMIT = 50;
