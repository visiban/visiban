import { useEffect, useState } from "react";
import type { BoardFull, Card, Column } from "../../types";
import { userDisplayName } from "../../types";
import { moveCard, updateCard, deleteCard } from "../../api/cards";

interface Props {
  board: BoardFull;
  selectedCardIds: Set<number>;
  onCardsUpdated: (cards: Card[]) => void;
  onCardsDeleted: (cardIds: number[]) => void;
  onClearSelection: () => void;
}

type Dropdown = "move" | "assign" | "priority" | null;

export default function BulkActionToolbar({ board, selectedCardIds, onCardsUpdated, onCardsDeleted, onClearSelection }: Props) {
  const [dropdown, setDropdown] = useState<Dropdown>(null);
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    if (!confirmDelete) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setConfirmDelete(false);
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [confirmDelete]);

  const count = selectedCardIds.size;
  const selectedCards = board.cards.filter((c) => selectedCardIds.has(c.id));

  const toggle = (d: Dropdown) => setDropdown((prev) => (prev === d ? null : d));

  const handleMove = async (column: Column) => {
    setDropdown(null);
    setBusy(true);
    // Serialize move requests to avoid database deadlocks from concurrent
    // position-reorder transactions targeting the same column.
    const updated: Card[] = [];
    for (const card of selectedCards) {
      try {
        const result = await moveCard(board.id, card.id, {
          column_id: column.id,
          swimlane_id: card.swimlane,
          position: 9999,
        });
        updated.push(result.card);
      } catch {
        // Continue moving remaining cards on individual failures
      }
    }
    if (updated.length > 0) onCardsUpdated(updated);
    onClearSelection();
    setBusy(false);
  };

  const handleAssign = async (userId: number | null) => {
    setDropdown(null);
    setBusy(true);
    const results = await Promise.allSettled(
      selectedCards.map((card) =>
        updateCard(board.id, card.id, { assignee_id: userId })
      )
    );
    const updated = results
      .filter((r): r is PromiseFulfilledResult<Card> => r.status === "fulfilled")
      .map((r) => r.value);
    if (updated.length > 0) onCardsUpdated(updated);
    onClearSelection();
    setBusy(false);
  };

  const handlePriority = async (priority: "low" | "medium" | "high" | "urgent") => {
    setDropdown(null);
    setBusy(true);
    const results = await Promise.allSettled(
      selectedCards.map((card) =>
        updateCard(board.id, card.id, { priority })
      )
    );
    const updated = results
      .filter((r): r is PromiseFulfilledResult<Card> => r.status === "fulfilled")
      .map((r) => r.value);
    if (updated.length > 0) onCardsUpdated(updated);
    onClearSelection();
    setBusy(false);
  };

  const handleDelete = async () => {
    setConfirmDelete(false);
    setDropdown(null);
    setBusy(true);
    const results = await Promise.allSettled(
      selectedCards.map((card) => deleteCard(board.id, card.id).then(() => card.id))
    );
    const deletedIds = results
      .filter((r): r is PromiseFulfilledResult<number> => r.status === "fulfilled")
      .map((r) => r.value);
    if (deletedIds.length > 0) onCardsDeleted(deletedIds);
    onClearSelection();
    setBusy(false);
  };

  const priorities: Array<{ value: "low" | "medium" | "high" | "urgent"; color: string }> = [
    { value: "low", color: "#6B7280" },
    { value: "medium", color: "#3B82F6" },
    { value: "high", color: "#F59E0B" },
    { value: "urgent", color: "#EF4444" },
  ];

  return (
    <>
      <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-40 flex items-center gap-2 bg-gray-800 text-white rounded-xl shadow-2xl px-4 py-2.5 border border-gray-700">
        <span className="text-sm font-medium tabular-nums">
          {count} selected
        </span>
        <span className="w-px h-5 bg-gray-600" />

        {/* Move */}
        <div className="relative">
          <button
            onClick={() => toggle("move")}
            disabled={busy}
            className="text-xs px-2.5 py-1.5 rounded-lg hover:bg-gray-700 transition disabled:opacity-40"
          >
            Move to...
          </button>
          {dropdown === "move" && (
            <div className="absolute bottom-full left-0 mb-2 bg-gray-900 border border-gray-700 rounded-lg shadow-xl py-1 min-w-[160px] max-h-64 overflow-auto">
              {board.columns.map((col) => (
                <button
                  key={col.id}
                  onClick={() => handleMove(col)}
                  className="flex items-center gap-2 w-full text-left text-xs px-3 py-1.5 hover:bg-gray-700 text-gray-200"
                >
                  <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: col.color }} />
                  {col.name}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Assign */}
        <div className="relative">
          <button
            onClick={() => toggle("assign")}
            disabled={busy}
            className="text-xs px-2.5 py-1.5 rounded-lg hover:bg-gray-700 transition disabled:opacity-40"
          >
            Assign to...
          </button>
          {dropdown === "assign" && (
            <div className="absolute bottom-full left-0 mb-2 bg-gray-900 border border-gray-700 rounded-lg shadow-xl py-1 min-w-[160px] max-h-64 overflow-auto">
              <button
                onClick={() => handleAssign(null)}
                className="w-full text-left text-xs px-3 py-1.5 hover:bg-gray-700 text-gray-400 italic"
              >
                Unassign
              </button>
              {board.members.map((m) => (
                <button
                  key={m.user.id}
                  onClick={() => handleAssign(m.user.id)}
                  className="w-full text-left text-xs px-3 py-1.5 hover:bg-gray-700 text-gray-200"
                >
                  {userDisplayName(m.user)}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Priority */}
        <div className="relative">
          <button
            onClick={() => toggle("priority")}
            disabled={busy}
            className="text-xs px-2.5 py-1.5 rounded-lg hover:bg-gray-700 transition disabled:opacity-40"
          >
            Priority...
          </button>
          {dropdown === "priority" && (
            <div className="absolute bottom-full left-0 mb-2 bg-gray-900 border border-gray-700 rounded-lg shadow-xl py-1 min-w-[120px]">
              {priorities.map((p) => (
                <button
                  key={p.value}
                  onClick={() => handlePriority(p.value)}
                  className="flex items-center gap-2 w-full text-left text-xs px-3 py-1.5 hover:bg-gray-700 text-gray-200 capitalize"
                >
                  <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: p.color }} />
                  {p.value}
                </button>
              ))}
            </div>
          )}
        </div>

        <span className="w-px h-5 bg-gray-600" />

        {/* Delete */}
        <button
          onClick={() => setConfirmDelete(true)}
          disabled={busy}
          className="text-xs px-2.5 py-1.5 rounded-lg text-red-400 hover:bg-red-500/20 transition disabled:opacity-40"
        >
          Delete
        </button>

        <span className="w-px h-5 bg-gray-600" />

        {/* Deselect */}
        <button
          onClick={onClearSelection}
          disabled={busy}
          className="text-gray-400 hover:text-white transition p-1 disabled:opacity-40"
          title="Deselect all (Esc)"
        >
          <svg className="w-4 h-4" viewBox="0 0 20 20" fill="currentColor">
            <path fillRule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clipRule="evenodd" />
          </svg>
        </button>

        {busy && (
          <span className="text-xs text-gray-400 animate-pulse">Working...</span>
        )}
      </div>

      {/* Delete confirmation modal */}
      {confirmDelete && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
          <div className="bg-gray-800 rounded-xl p-6 w-full max-w-sm shadow-xl">
            <h3 className="text-white font-semibold text-lg mb-2">Delete {count} card{count !== 1 ? "s" : ""}?</h3>
            <p className="text-gray-400 text-sm mb-5">
              This will permanently delete {count === 1 ? "this card" : `all ${count} selected cards`}. This cannot be undone.
            </p>
            <div className="flex gap-3 justify-end">
              <button
                onClick={() => setConfirmDelete(false)}
                className="text-gray-400 text-sm hover:text-white px-3 py-1.5"
              >
                Cancel
              </button>
              <button
                onClick={handleDelete}
                className="bg-red-600 hover:bg-red-700 text-white text-sm px-4 py-1.5 rounded-lg"
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
