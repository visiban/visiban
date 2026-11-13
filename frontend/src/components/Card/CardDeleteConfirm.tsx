import { useRef, useState } from "react";
import ModalWrapper from "../shared/ModalWrapper";
import { deleteCard } from "../../api/cards";
import { failureReason } from "../../utils/moveFailure";
import { partitionRefused, REFUSAL_CLAUSE, type CardActionContext } from "../../utils/cardActions";
import type { Card } from "../../types";

interface Props {
  boardId: number;
  cards: Card[];
  /** Admin, site admin or moderator: may delete cards others created. */
  canModifyAll: boolean;
  currentUserId: number | null;
  /**
   * The user's action context. With it, cards the client already knows the
   * server refuses (`cardRefusal`) are not sent: they count as failed with the
   * delete clause. Without it every card is sent and the server decides.
   */
  actionContext?: CardActionContext;
  /** Fired when the deletes start, for callers that show their own in-flight state (the bulk toolbar's "Working..."). */
  onStart?: () => void;
  onDeleted: (cardIds: number[]) => void;
  /**
   * Closes the dialog. `failure` is the bulk partial-failure line, or null;
   * `canceled` is true when the user dismissed it without deleting anything
   * (Cancel, backdrop, Escape), so callers keep the selection and stay quiet.
   */
  onClose: (failure: string | null, canceled?: boolean) => void;
}

const plural = (n: number) => `card${n !== 1 ? "s" : ""}`;

/**
 * The one delete confirm for card actions: the card context menu's
 * **Delete card…** (#2059) and the bulk toolbar's **Delete** (#2103); a delete never
 * runs from a single click. In flight the action is `aria-disabled` with a
 * progress label and Escape/backdrop dismissal is swallowed (#1437).
 */
export default function CardDeleteConfirm({ boardId, cards, canModifyAll, currentUserId, actionContext, onStart, onDeleted, onClose }: Props) {
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const count = cards.length;
  const othersCards = currentUserId != null ? cards.filter((c) => c.created_by?.id !== currentUserId) : cards;

  const handleDelete = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    onStart?.();
    // Known-refused cards are never sent: the server would 403 them, and a
    // refused delete is not a skipped one unless we skip it here.
    const { sendable, refused, clause } = partitionRefused(cards, "delete", actionContext);
    const results = await Promise.allSettled(sendable.map((card) => deleteCard(boardId, card.id).then(() => card.id)));
    const deleted = results.filter((r): r is PromiseFulfilledResult<number> => r.status === "fulfilled").map((r) => r.value);
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    if (deleted.length > 0) onDeleted(deleted);
    const reasons = new Set(rejected.map((r) => failureReason(r.reason, REFUSAL_CLAUSE.delete)));
    if (clause) reasons.add(clause);
    const failed = rejected.length + refused;
    inFlight.current = false;
    setBusy(false);
    onClose(failed > 0
      ? `${failed} of ${count} ${plural(count)} could not be deleted — ${reasons.size === 1 ? [...reasons][0] : "for more than one reason"}.`
      : null);
  };

  return (
    <ModalWrapper
      open
      onClose={() => { if (!inFlight.current) onClose(null, true); }}
      dismissable={!busy}
      title={count === 1 ? "Delete this card?" : `Delete ${count} cards?`}
      maxWidth="max-w-sm"
      labelId="card-delete-title"
    >
      <p className={`text-fg-tertiary text-sm ${!canModifyAll && othersCards.length > 0 ? "mb-2" : "mb-5"}`}>
        This will permanently delete {count === 1 ? `“${cards[0]?.title}”` : `all ${count} cards`}. This cannot be undone.
      </p>
      {!canModifyAll && othersCards.length > 0 && (
        <p className="text-xs text-warning-on-tint mb-4">
          {othersCards.length === count
            ? `You can only delete cards you created. ${count === 1 ? "This card will not be deleted." : "None of these cards will be deleted."}`
            : `${othersCards.length} ${plural(othersCards.length)} created by others will be skipped.`}
        </p>
      )}
      <div className="flex items-center justify-end gap-3">
        <button
          type="button"
          onClick={() => { if (!inFlight.current) onClose(null, true); }}
          aria-disabled={busy || undefined}
          className="text-fg-secondary hover:text-fg hover:bg-surface-hover px-3 py-1.5 text-sm rounded transition aria-disabled:opacity-40 focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={() => void handleDelete()}
          aria-disabled={busy || undefined}
          className="bg-danger-bg hover:bg-danger-bg-hover text-on-danger px-3 py-1.5 text-sm rounded font-medium transition aria-disabled:opacity-40 focus:outline-none focus:ring-2 focus:ring-danger-emphasis"
        >
          {busy ? "Deleting…" : "Delete"}
        </button>
      </div>
    </ModalWrapper>
  );
}
