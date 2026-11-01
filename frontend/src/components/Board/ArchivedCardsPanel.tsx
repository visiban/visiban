import { useEffect, useRef, useState } from "react";
import { useEscapeStack } from "../../hooks/useEscapeStack";
import { useFocusTrap } from "../../hooks/useFocusTrap";
import type { BoardFull, Card, User } from "../../types";
import { getArchivedCards } from "../../api/cards";
import { unarchiveCard } from "../../api/cards";
import { formatDate } from "../../utils/date";
import { limitBlockedMessage } from "./moveBlockedMessages";
import { useInstanceFlags } from "../../contexts/InstanceFlagsContext";

interface Props {
  board: BoardFull;
  onClose: () => void;
  onUnarchived: (card: Card) => void;
  currentUser?: User | null;
}

export default function ArchivedCardsPanel({ board, onClose, onUnarchived, currentUser }: Props) {
  const [loadedCards, setCards] = useState<Card[]>([]);
  const [loadedTotal, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [unarchivingId, setUnarchivingId] = useState<number | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [restoreError, setRestoreError] = useState<string | null>(null);

  const panelRef = useRef<HTMLDivElement>(null);

  useEscapeStack(onClose, 30);

  // #1732 — aria-modal panel: trap Tab, restore focus to the opener on close.
  useFocusTrap(panelRef, true);
  useEffect(() => {
    panelRef.current?.focus();
  }, []);

  useEffect(() => {
    setLoading(true);
    setLoadError(null);
    setCards([]);
    setOffset(0);
    getArchivedCards(board.id, 0)
      .then((page) => {
        setCards(page.results);
        setTotal(page.count);
        setOffset(page.results.length);
      })
      .catch(() => setLoadError("Could not load archived cards. Please try again."))
      .finally(() => setLoading(false));
  }, [board.id]);

  // Deleting a column or swimlane deletes the archived cards in it as well,
  // and the server sends only the container's *.deleted event, not one
  // card.deleted per card (#1615). The board's columns and swimlanes are kept
  // current from those events, so drop any loaded card whose column or
  // swimlane has left the board rather than offer to restore a deleted card.
  const columnIds = new Set(board.columns.map((c) => c.id));
  const swimlaneIds = new Set(board.swimlanes.map((s) => s.id));
  const cards = loadedCards.filter((c) => columnIds.has(c.column) && swimlaneIds.has(c.swimlane));
  const pruned = loadedCards.length - cards.length;
  const total = Math.max(0, loadedTotal - pruned);
  const prunedRef = useRef(0);
  prunedRef.current = pruned;

  // The client cannot know how many *unloaded* archived cards went with a
  // deleted container, so subtracting only the loaded ones leaves a phantom
  // "Load more (N remaining)" that returns nothing (#1637). Rather than guess,
  // re-read the authoritative count from the server whenever the set of
  // columns or swimlanes changes. loadedTotal is kept as server count plus the
  // pruned cards still held in loadedCards, so `total` stays server-true.
  // Sorted so a pure reorder or a new board object with the same ids does not
  // trigger a needless request; additions also only grow the set harmlessly,
  // but any membership change is worth one count read.
  const sortedIds = (xs: { id: number }[]) => xs.map((x) => x.id).sort((a, b) => a - b).join(",");
  const containerKey = `${sortedIds(board.columns)}|${sortedIds(board.swimlanes)}`;
  const lastContainerKey = useRef(containerKey);
  useEffect(() => {
    if (lastContainerKey.current === containerKey) return;
    lastContainerKey.current = containerKey;
    getArchivedCards(board.id, 0)
      .then((page) => setTotal(page.count + prunedRef.current))
      .catch(() => {
        // Keep the local estimate; the next Load more re-syncs from the server.
      });
  }, [containerKey, board.id]);

  const handleLoadMore = () => {
    setLoadingMore(true);
    setLoadError(null);
    // Cards pruned above are gone from the server too, so the server's list
    // has shifted down by that many since they were loaded.
    getArchivedCards(board.id, Math.max(0, offset - pruned))
      .then((page) => {
        setCards((prev) => [...prev, ...page.results]);
        setOffset((prev) => prev + page.results.length);
        // Re-sync with the server so an empty page can never leave a phantom
        // remainder behind (#1637).
        setTotal(page.count + pruned);
      })
      .catch(() => setLoadError("Could not load more archived cards. Please try again."))
      .finally(() => setLoadingMore(false));
  };

  const handleUnarchive = async (card: Card) => {
    setUnarchivingId(card.id);
    setRestoreError(null);
    try {
      const unarchived = await unarchiveCard(board.id, card.id);
      setCards((prev) => prev.filter((c) => c.id !== card.id));
      setTotal((prev) => Math.max(0, prev - 1));
      // The server's list shrank by this card too; without this the next
      // page would be requested one row too far and skip a card (#1637).
      setOffset((prev) => Math.max(0, prev - 1));
      onUnarchived(unarchived);
    } catch (err) {
      // Restoring into a full column is refused with the move path's limit
      // body (#1428). The card stays in the panel and the reason is shown.
      const reason = limitBlockedMessage(err);
      setRestoreError(
        reason ? `${card.title}: ${reason}` : `Could not unarchive "${card.title}". Please try again.`,
      );
    } finally {
      setUnarchivingId(null);
    }
  };

  const { demo_mode: demoMode } = useInstanceFlags();
  const role = board.current_user_role;
  const isModerator = board.members.some(
    (m) => currentUser != null && m.user.id === currentUser.id && m.is_moderator,
  );
  // Hosted demo (#1179): the published visitor (a plain MEMBER) may restore
  // cards others archived — the server's DEMO_MODE-gated carve-out in
  // boards.permissions allows it and unarchive is on DEMO_ALLOWED_WRITES.
  // Display heuristic only; the server stays the authority.
  const canModifyOthersContent =
    role === "admin" || role === "site_admin" || isModerator ||
    (demoMode && role === "member");
  const canUnarchive = (card: Card) =>
    (role === "site_admin" || role === "admin" || role === "member") &&
    ((currentUser != null && card.created_by?.id === currentUser.id) || canModifyOthersContent);

  const columnName = (colId: number) => board.columns.find((c) => c.id === colId)?.name ?? "—";
  const swimlaneName = (slId: number) => board.swimlanes.find((s) => s.id === slId)?.name ?? "—";

  // The server reports count 0 for an empty page, so a Load more that comes
  // back empty can set total below the cards still listed; never show a header
  // count smaller than what is on screen.
  const shownTotal = Math.max(total, cards.length);
  const hasMore = cards.length < total;

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      {/* Backdrop — decorative pointer-only dismiss; keyboard parity is Escape + the Close button (#1376) */}
      <div className="absolute inset-0 bg-backdrop/50" aria-hidden="true" onClick={onClose} />

      {/* Panel */}
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="Archived cards"
        tabIndex={-1}
        className="relative w-96 max-w-full h-full bg-surface border-l border-line shadow-xl flex flex-col outline-none"
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-line shrink-0">
          <h2 className="text-sm font-medium text-fg">
            Archived cards{shownTotal > 0 && <span className="ml-2 text-fg-tertiary font-normal">({shownTotal})</span>}
          </h2>
          <button
            onClick={onClose}
            className="text-fg-tertiary hover:text-fg hover:bg-surface-hover rounded p-1 transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4">
          {loading && (
            <div className="flex items-center justify-center py-8 text-fg-tertiary text-sm">Loading…</div>
          )}
          {!loading && loadError && cards.length === 0 && (
            <div className="flex flex-col items-center justify-center py-12 gap-2">
              <p className="text-danger text-sm">{loadError}</p>
            </div>
          )}
          {!loading && !loadError && cards.length === 0 && (
            <div className="flex flex-col items-center justify-center py-12 gap-2">
              <span className="text-fg-faint text-2xl">📦</span>
              <p className="text-fg-tertiary text-sm">No archived cards</p>
            </div>
          )}
          {!loading && cards.length > 0 && (
            <>
              {/* Reserved restore-result slot — always rendered so the list
                  never shifts when a message appears. */}
              <p className="text-xs min-h-4 mb-2" role="status" aria-live="polite" aria-atomic="true">
                <span className="text-danger">{restoreError}</span>
              </p>
              <ul className="space-y-2">
                {cards.map((card) => (
                  <li
                    key={card.id}
                    className="bg-sunken border border-line rounded-lg p-3 flex flex-col gap-1.5"
                  >
                    <span className="text-sm text-fg font-medium">{card.title}</span>
                    <span className="text-xs text-fg-tertiary">
                      {columnName(card.column)} · {swimlaneName(card.swimlane)}
                    </span>
                    <div className="flex items-center justify-between mt-1">
                      <span className="text-xs text-fg-tertiary">
                        {card.archived_at
                          ? `Archived ${formatDate(card.archived_at, currentUser)}`
                          : ""}
                      </span>
                      {canUnarchive(card) && (
                        <button
                          onClick={() => handleUnarchive(card)}
                          disabled={unarchivingId === card.id}
                          className="text-xs text-fg-secondary hover:text-fg hover:bg-surface-hover px-2 py-1 rounded transition disabled:opacity-40 focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
                        >
                          {unarchivingId === card.id ? "Unarchiving…" : "Unarchive"}
                        </button>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
              {hasMore && (
                <button
                  onClick={handleLoadMore}
                  disabled={loadingMore}
                  className="mt-4 w-full text-sm text-fg-tertiary hover:text-fg hover:bg-surface-hover py-2 rounded transition disabled:opacity-40 focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
                >
                  {loadingMore ? "Loading…" : `Load more (${total - cards.length} remaining)`}
                </button>
              )}
              {loadError && cards.length > 0 && (
                <p className="text-danger text-xs text-center mt-2">{loadError}</p>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
