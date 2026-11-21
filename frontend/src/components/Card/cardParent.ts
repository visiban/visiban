import type { ChildCandidate, ParentCandidate } from "../../types";

/**
 * Child-side card links (#1104): shared copy and the refetch event.
 *
 * `LINKED_CARD_HIDDEN` is the one string for every linked card on a board the
 * viewer cannot open (frontend/CLAUDE.md § Cards, the #2206 shared rule 5). It
 * names nothing about the card: the server sends `{hidden: true}` and no other
 * key, so there is nothing else to show.
 */
export const LINKED_CARD_HIDDEN = "Linked card you can't open";
export const LINKED_CARD_HIDDEN_DETAIL = "It is on a board you don't have access to.";

/**
 * Window event asking BoardView to re-read `parent` for some cards. The card
 * detail fires it after its own link or unlink, the same refetch a
 * `card.parent_changed` frame starts. `detail: { cardIds: number[] }`.
 */
export const CARD_PARENT_REFETCH_EVENT = "visiban:card-parent-refetch";

export function requestCardParentRefetch(cardIds: number[]): void {
  window.dispatchEvent(new CustomEvent(CARD_PARENT_REFETCH_EVENT, { detail: { cardIds } }));
}

/** Why a picker option cannot be chosen, or null when it can. */
export function candidateDisabledReason(c: ParentCandidate): string | null {
  if (c.disabled_reason === "children_limit") return "Has 100 children (the limit)";
  if (c.disabled_reason === "children_on_other_board") {
    // The server names the other board only when the viewer can open it.
    return c.children_board_name
      ? `Its children are on ${c.children_board_name}`
      : "Its children are on a board you can't open";
  }
  return null;
}

/**
 * The link write's 400 codes as copy (docs/api/cards.md § Parent and
 * children). The picker filters out what it can, so these are the backstop
 * for a concurrent change. Branch on `code`, never on `detail`.
 */
const LINK_ERROR_COPY: Record<string, string> = {
  link_not_allowed: "That board's cards can't be parents of this card.",
  self_link: "A card can't be its own parent.",
  link_exists: "This card is already linked to that parent.",
  already_has_parent: "This card already has a parent. Unlink it first.",
  children_on_other_board: "That card's children are on another board.",
  children_limit: "That card has 100 children (the limit).",
  child_is_parent: "That would make a third tier. A child card can't be a parent.",
  parent_is_child: "That would make a third tier. A child card can't be a parent.",
};

export function linkErrorCopy(err: unknown): string {
  const res = (err as { response?: { status?: number; data?: { code?: unknown } } })?.response;
  if (res?.status === 404) return "No matching cards. That card may have been deleted or moved.";
  if (res?.status === 429) return "Too many link changes. Wait a moment and try again.";
  const code = res?.data?.code;
  return (typeof code === "string" && LINK_ERROR_COPY[code]) || "Failed to link the parent. Please try again.";
}

/** Why an option cannot be linked under this parent, or null when it can (#1104 copy). */
export function childCandidateReason(c: ChildCandidate): string | null {
  if (c.disabled_reason === "link_exists") return "already a child of this card";
  if (c.disabled_reason === "children_limit") return "this card has 100 children (the limit)";
  if (c.disabled_reason === "already_has_parent") {
    return c.parent_title ? `already a child of ${c.parent_title}` : "already a child of a card you can't open";
  }
  return null;
}
