import { useRef, useState } from "react";
import ModalWrapper from "../shared/ModalWrapper";
import { deleteCard } from "../../api/cards";
import { failureReason } from "../../utils/moveFailure";
import type { Card } from "../../types";

interface Props {
  boardId: number;
  cards: Card[];
  /** Admin, site admin or moderator: may delete cards others created. */
  canModifyAll: boolean;
  currentUserId: number | null;
  onDeleted: (cardIds: number[]) => void;
  /** Closes the dialog; `failure` is the bulk partial-failure line, or null. */
  onClose: (failure: string | null) => void;
}

const plural = (n: number) => `card${n !== 1 ? "s" : ""}`;

/**
 * Delete confirm opened by the card context menu's **Delete card…** (#2059).
 * Same copy and ownership note as the bulk toolbar's confirm; a delete never
 * runs from a single click. In flight the action is `aria-disabled` with a
 * progress label and Escape/backdrop dismissal is swallowed (#1437).
 *
 * Follow-up: the toolbar's inline confirm should adopt this component once
 * #1482's toolbar changes land, so the two cannot drift.
 */
export default function CardDeleteConfirm({ boardId, cards, canModifyAll, currentUserId, onDeleted, onClose }: Props) {
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const count = cards.length;
  const othersCards = currentUserId != null ? cards.filter((c) => c.created_by != null && c.created_by.id !== currentUserId) : [];

  const handleDelete = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    const results = await Promise.allSettled(cards.map((card) => deleteCard(boardId, card.id).then(() => card.id)));
    const deleted = results.filter((r): r is PromiseFulfilledResult<number> => r.status === "fulfilled").map((r) => r.value);
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    if (deleted.length > 0) onDeleted(deleted);
    const reasons = new Set(rejected.map((r) => failureReason(r.reason, "you can only delete cards you created")));
    inFlight.current = false;
    setBusy(false);
    onClose(rejected.length > 0
      ? `${rejected.length} of ${count} ${plural(count)} could not be deleted — ${reasons.size === 1 ? [...reasons][0] : "for more than one reason"}.`
      : null);
  };

  return (
    <ModalWrapper
      open
      onClose={() => { if (!inFlight.current) onClose(null); }}
      dismissable={!busy}
      title={count === 1 ? "Delete this card?" : `Delete ${count} cards?`}
      maxWidth="max-w-sm"
      labelId="card-menu-delete-title"
    >
      <p className="text-fg-tertiary text-sm mb-5">
        This will permanently delete {count === 1 ? `“${cards[0]?.title}”` : `all ${count} cards`}. This cannot be undone.
      </p>
      {!canModifyAll && othersCards.length > 0 && (
        <p className="text-xs text-warning-on-tint -mt-3 mb-4">
          {othersCards.length === count
            ? `You can only delete cards you created. ${count === 1 ? "This card" : "None of these cards"} will not be deleted.`
            : `${othersCards.length} ${plural(othersCards.length)} created by others will be skipped.`}
        </p>
      )}
      <div className="flex items-center justify-end gap-3">
        <button
          type="button"
          onClick={() => { if (!inFlight.current) onClose(null); }}
          aria-disabled={busy || undefined}
          className="text-fg-secondary hover:text-fg hover:bg-surface-hover px-3 py-1.5 text-sm rounded transition aria-disabled:opacity-40 focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={() => void handleDelete()}
          aria-disabled={busy || undefined}
          className="bg-danger-bg hover:bg-danger-bg-hover text-on-danger px-3 py-1.5 text-sm rounded font-medium aria-disabled:opacity-40 focus:outline-none focus:ring-2 focus:ring-danger-emphasis"
        >
          {busy ? "Deleting…" : "Delete"}
        </button>
      </div>
    </ModalWrapper>
  );
}
