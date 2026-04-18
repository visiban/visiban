import { useEffect, useRef, useState } from "react";
import { useEscapeStack } from "../../hooks/useEscapeStack";
import type { BoardFull, Card, User } from "../../types";
import { getArchivedCards } from "../../api/cards";
import { unarchiveCard } from "../../api/cards";

interface Props {
  board: BoardFull;
  onClose: () => void;
  onUnarchived: (card: Card) => void;
  currentUser?: User | null;
}

export default function ArchivedCardsPanel({ board, onClose, onUnarchived, currentUser }: Props) {
  const [cards, setCards] = useState<Card[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [unarchivingId, setUnarchivingId] = useState<number | null>(null);

  const panelRef = useRef<HTMLDivElement>(null);

  useEscapeStack(onClose, 30);

  useEffect(() => {
    panelRef.current?.focus();
  }, []);

  useEffect(() => {
    setLoading(true);
    setCards([]);
    setOffset(0);
    getArchivedCards(board.id, 0)
      .then((page) => {
        setCards(page.results);
        setTotal(page.count);
        setOffset(page.results.length);
      })
      .finally(() => setLoading(false));
  }, [board.id]);

  const handleLoadMore = () => {
    setLoadingMore(true);
    getArchivedCards(board.id, offset)
      .then((page) => {
        setCards((prev) => [...prev, ...page.results]);
        setOffset((prev) => prev + page.results.length);
      })
      .finally(() => setLoadingMore(false));
  };

  const handleUnarchive = async (card: Card) => {
    setUnarchivingId(card.id);
    try {
      const unarchived = await unarchiveCard(board.id, card.id);
      setCards((prev) => prev.filter((c) => c.id !== card.id));
      setTotal((prev) => Math.max(0, prev - 1));
      onUnarchived(unarchived);
    } finally {
      setUnarchivingId(null);
    }
  };

  const role = board.current_user_role;
  const isModerator = board.members.some(
    (m) => currentUser != null && m.user.id === currentUser.id && m.is_moderator,
  );
  const canModifyOthersContent =
    role === "admin" || role === "site_admin" || isModerator;
  const canUnarchive = (card: Card) =>
    (role === "site_admin" || role === "admin" || role === "member") &&
    ((currentUser != null && card.created_by?.id === currentUser.id) || canModifyOthersContent);

  const columnName = (colId: number) => board.columns.find((c) => c.id === colId)?.name ?? "—";
  const swimlaneName = (slId: number) => board.swimlanes.find((s) => s.id === slId)?.name ?? "—";

  const hasMore = cards.length < total;

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />

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
            Archived cards{total > 0 && <span className="ml-2 text-fg-muted font-normal">({total})</span>}
          </h2>
          <button
            onClick={onClose}
            className="text-fg-tertiary hover:text-white hover:bg-surface-hover rounded p-1 transition focus:outline-none focus:ring-2 focus:ring-blue-500"
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4">
          {loading && (
            <div className="flex items-center justify-center py-8 text-fg-muted text-sm">Loading…</div>
          )}
          {!loading && cards.length === 0 && (
            <div className="flex flex-col items-center justify-center py-12 gap-2">
              <span className="text-fg-faint text-2xl">📦</span>
              <p className="text-fg-tertiary text-sm">No archived cards</p>
            </div>
          )}
          {!loading && cards.length > 0 && (
            <>
              <ul className="space-y-2">
                {cards.map((card) => (
                  <li
                    key={card.id}
                    className="bg-sunken border border-line rounded-lg p-3 flex flex-col gap-1.5"
                  >
                    <span className="text-sm text-fg font-medium">{card.title}</span>
                    <span className="text-xs text-fg-muted">
                      {columnName(card.column)} · {swimlaneName(card.swimlane)}
                    </span>
                    <div className="flex items-center justify-between mt-1">
                      <span className="text-xs text-fg-muted">
                        {card.archived_at
                          ? `Archived ${new Date(card.archived_at).toLocaleDateString()}`
                          : ""}
                      </span>
                      {canUnarchive(card) && (
                        <button
                          onClick={() => handleUnarchive(card)}
                          disabled={unarchivingId === card.id}
                          className="text-xs text-fg-secondary hover:text-white hover:bg-surface-hover px-2 py-1 rounded transition disabled:opacity-40 focus:outline-none focus:ring-2 focus:ring-blue-500"
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
                  className="mt-4 w-full text-sm text-fg-tertiary hover:text-fg hover:bg-surface-hover py-2 rounded transition disabled:opacity-40 focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  {loadingMore ? "Loading…" : `Load more (${total - cards.length} remaining)`}
                </button>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
