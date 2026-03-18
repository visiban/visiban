import { useEffect, useState } from "react";
import { useEscapeStack } from "../../hooks/useEscapeStack";
import type { BoardFull, Card } from "../../types";
import { getArchivedCards, unarchiveCard } from "../../api/cards";

interface Props {
  board: BoardFull;
  onClose: () => void;
  onUnarchived: (card: Card) => void;
}

export default function ArchivedCardsPanel({ board, onClose, onUnarchived }: Props) {
  const [cards, setCards] = useState<Card[]>([]);
  const [loading, setLoading] = useState(true);
  const [restoringId, setRestoringId] = useState<number | null>(null);

  useEscapeStack(onClose, 30);

  useEffect(() => {
    setLoading(true);
    getArchivedCards(board.id)
      .then(setCards)
      .finally(() => setLoading(false));
  }, [board.id]);

  const handleRestore = async (card: Card) => {
    setRestoringId(card.id);
    try {
      const restored = await unarchiveCard(board.id, card.id);
      setCards((prev) => prev.filter((c) => c.id !== card.id));
      onUnarchived(restored);
    } finally {
      setRestoringId(null);
    }
  };

  const columnName = (colId: number) => board.columns.find((c) => c.id === colId)?.name ?? "—";
  const swimlaneName = (slId: number) => board.swimlanes.find((s) => s.id === slId)?.name ?? "—";

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />

      {/* Panel */}
      <div className="relative w-96 max-w-full h-full bg-slate-800 border-l border-slate-700 shadow-xl flex flex-col">
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-700 shrink-0">
          <h2 className="text-sm font-medium text-slate-200">Archived cards</h2>
          <button
            onClick={onClose}
            className="text-slate-400 hover:text-white hover:bg-slate-700 rounded p-1 transition"
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4">
          {loading && (
            <div className="flex items-center justify-center py-8 text-slate-500 text-sm">Loading…</div>
          )}
          {!loading && cards.length === 0 && (
            <div className="flex flex-col items-center justify-center py-12 gap-2">
              <span className="text-slate-600 text-2xl">📦</span>
              <p className="text-slate-400 text-sm">No archived cards</p>
            </div>
          )}
          {!loading && cards.length > 0 && (
            <ul className="space-y-2">
              {cards.map((card) => (
                <li
                  key={card.id}
                  className="bg-slate-900 border border-slate-700 rounded-lg p-3 flex flex-col gap-1.5"
                >
                  <span className="text-sm text-slate-200 font-medium">{card.title}</span>
                  <span className="text-xs text-slate-500">
                    {columnName(card.column)} · {swimlaneName(card.swimlane)}
                  </span>
                  <div className="flex items-center justify-between mt-1">
                    <span className="text-xs text-slate-500">
                      {card.archived_at
                        ? `Archived ${new Date(card.archived_at).toLocaleDateString()}`
                        : ""}
                    </span>
                    <button
                      onClick={() => handleRestore(card)}
                      disabled={restoringId === card.id}
                      className="text-xs text-blue-400 hover:text-blue-300 hover:bg-blue-500/10 px-2 py-1 rounded transition disabled:opacity-50"
                    >
                      {restoringId === card.id ? "Restoring…" : "Restore"}
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
