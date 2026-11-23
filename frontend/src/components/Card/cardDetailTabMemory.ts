/**
 * Which card detail tab opens (#967, design A-Q7).
 *
 * Kept in module memory, not storage: it lasts for the page session, across
 * card swaps (BoardView remounts CardDetail per card) and closes, so Jordan
 * can step through cards on History. It is deliberately not persisted: a
 * stored "History" would hide comments from an occasional user on their next
 * visit. A deep link (`?card=…&tab=comments`) overrides it.
 */
export type CardDetailTab = "details" | "children" | "comments" | "history";

export const CARD_DETAIL_TABS: readonly CardDetailTab[] = ["details", "comments", "history"];

/** A card on a parent-tier board also has the Children tab, after Details (#2209). */
export const PARENT_CARD_DETAIL_TABS: readonly CardDetailTab[] = ["details", "children", "comments", "history"];

/**
 * Whether this card has the parent capability: the Children tab, the rollup, Add child and Link existing.
 *
 * Per card, not per board (#2446): a board whose "can have children" switch was turned off while cards
 * on it had children keeps those cards as parents. The server sends `children_rollup` on such a board
 * only for a card that has children, so its presence is the per-card signal; the board flag covers
 * every card on a parent-tier board, including one with no children yet.
 */
export function cardCanHaveChildren(
  board: { cards_can_have_children?: boolean },
  card?: { children_rollup?: unknown } | null,
): boolean {
  return !!board.cards_can_have_children || (card?.children_rollup !== undefined && card?.children_rollup !== null);
}

/** The tabs `card` on `board` shows (the card is optional for callers that only know the board). */
export function cardDetailTabsFor(
  board: { cards_can_have_children?: boolean },
  card?: { children_rollup?: unknown } | null,
): readonly CardDetailTab[] {
  return cardCanHaveChildren(board, card) ? PARENT_CARD_DETAIL_TABS : CARD_DETAIL_TABS;
}

let lastTab: CardDetailTab = "details";

export function getRememberedCardDetailTab(): CardDetailTab {
  return lastTab;
}

export function rememberCardDetailTab(tab: CardDetailTab): void {
  lastTab = tab;
}

/** Parse a `?tab=` value; unknown values are `null` so the caller keeps session memory. */
export function parseCardDetailTab(value: string | null | undefined): CardDetailTab | null {
  return PARENT_CARD_DETAIL_TABS.includes(value as CardDetailTab) ? (value as CardDetailTab) : null;
}

/** Page size of the History tab, shared so CardDetail's first page matches the panel's paging. */
export const HISTORY_PAGE_LIMIT = 50;
