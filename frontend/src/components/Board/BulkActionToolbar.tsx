import { useRef, useState } from "react";
import { useEscapeStack } from "../../hooks/useEscapeStack";
import type { BoardFull, Card, Column, User } from "../../types";
import { userDisplayName } from "../../types";
import { moveCard, updateCard, deleteCard, archiveCard } from "../../api/cards";

interface Props {
  board: BoardFull;
  selectedCardIds: Set<number>;
  onCardsUpdated: (cards: Card[]) => void;
  onCardsDeleted: (cardIds: number[]) => void;
  onCardsArchived: (cardIds: number[]) => void;
  onClearSelection: () => void;
  currentUser?: User | null;
}

type Dropdown = "move" | "assign" | "priority" | null;

export default function BulkActionToolbar({ board, selectedCardIds, onCardsUpdated, onCardsDeleted, onCardsArchived, onClearSelection, currentUser }: Props) {
  const [dropdown, setDropdown] = useState<Dropdown>(null);
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [partialError, setPartialError] = useState<string | null>(null);

  const moveRef = useRef<HTMLButtonElement>(null);
  const assignRef = useRef<HTMLButtonElement>(null);
  const priorityRef = useRef<HTMLButtonElement>(null);

  // Priority 25: dropdown Escape closes the open dropdown and returns focus to its trigger.
  useEscapeStack(() => {
    if (dropdown === null) return false;
    const ref = dropdown === "move" ? moveRef : dropdown === "assign" ? assignRef : priorityRef;
    setDropdown(null);
    ref.current?.focus();
  }, 25);

  useEscapeStack(() => {
    if (!confirmDelete) return false;
    setConfirmDelete(false);
  }, 20);

  const count = selectedCardIds.size;
  const selectedCards = board.cards.filter((c) => selectedCardIds.has(c.id));

  const role = board.current_user_role;
  const isModerator = board.members.some(
    (m) => currentUser != null && m.user.id === currentUser.id && m.is_moderator,
  );
  const canModifyAll = role === "admin" || role === "site_admin" || isModerator;
  const othersCards = currentUser
    ? selectedCards.filter((c) => c.created_by?.id !== currentUser.id)
    : selectedCards;

  const toggle = (d: Dropdown) => setDropdown((prev) => (prev === d ? null : d));

  const handleMove = async (column: Column) => {
    setDropdown(null);
    setPartialError(null);
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
    const failed = selectedCards.length - updated.length;
    if (failed > 0) {
      // Keep selection active so the user can see which cards remain and dismiss manually.
      setPartialError(
        `${failed} of ${selectedCards.length} card${selectedCards.length !== 1 ? "s" : ""} could not be moved — blocked by a WIP or weight limit.`
      );
    } else {
      onClearSelection();
    }
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

  const handleArchive = async () => {
    setPartialError(null);
    setBusy(true);
    const results = await Promise.allSettled(
      selectedCards.map((card) => archiveCard(board.id, card.id).then(() => card.id))
    );
    const archivedIds = results
      .filter((r): r is PromiseFulfilledResult<number> => r.status === "fulfilled")
      .map((r) => r.value);
    if (archivedIds.length > 0) onCardsArchived(archivedIds);
    const failed = selectedCards.length - archivedIds.length;
    if (failed > 0) {
      setPartialError(
        `${failed} of ${selectedCards.length} card${selectedCards.length !== 1 ? "s" : ""} could not be archived — you can only archive cards you created.`
      );
    } else {
      onClearSelection();
    }
    setBusy(false);
  };

  const handleDelete = async () => {
    setConfirmDelete(false);
    setDropdown(null);
    setPartialError(null);
    setBusy(true);
    const results = await Promise.allSettled(
      selectedCards.map((card) => deleteCard(board.id, card.id).then(() => card.id))
    );
    const deletedIds = results
      .filter((r): r is PromiseFulfilledResult<number> => r.status === "fulfilled")
      .map((r) => r.value);
    if (deletedIds.length > 0) onCardsDeleted(deletedIds);
    const failed = selectedCards.length - deletedIds.length;
    if (failed > 0) {
      setPartialError(
        `${failed} of ${selectedCards.length} card${selectedCards.length !== 1 ? "s" : ""} could not be deleted — you can only delete cards you created.`
      );
    } else {
      onClearSelection();
    }
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
      <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-40 flex items-center gap-2 bg-surface text-fg rounded-xl shadow-2xl px-4 py-2.5 border border-line">
        <span className="text-sm font-medium tabular-nums">
          {count} selected
        </span>
        <span className="w-px h-5 bg-surface-active" />

        {/* Move */}
        <div className="relative">
          <button
            ref={moveRef}
            onClick={() => toggle("move")}
            disabled={busy}
            className="text-xs px-2.5 py-1.5 rounded hover:bg-surface-hover transition disabled:opacity-40 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
          >
            Move to...
          </button>
          {dropdown === "move" && (
            <div className="absolute bottom-full left-0 mb-2 bg-sunken border border-line rounded-lg shadow-xl py-1 min-w-[160px] max-h-64 overflow-auto">
              {board.columns.map((col) => (
                <button
                  key={col.id}
                  onClick={() => handleMove(col)}
                  className="flex items-center gap-2 w-full text-left text-xs px-3 py-1.5 hover:bg-surface-hover text-fg"
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
            ref={assignRef}
            onClick={() => toggle("assign")}
            disabled={busy}
            className="text-xs px-2.5 py-1.5 rounded hover:bg-surface-hover transition disabled:opacity-40 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
          >
            Assign to...
          </button>
          {dropdown === "assign" && (
            <div className="absolute bottom-full left-0 mb-2 bg-sunken border border-line rounded-lg shadow-xl py-1 min-w-[160px] max-h-64 overflow-auto">
              <button
                onClick={() => handleAssign(null)}
                className="w-full text-left text-xs px-3 py-1.5 hover:bg-surface-hover text-fg-tertiary italic"
              >
                Unassign
              </button>
              {board.members.filter((m) => m.role !== "viewer").map((m) => (
                <button
                  key={m.user.id}
                  onClick={() => handleAssign(m.user.id)}
                  className="w-full text-left text-xs px-3 py-1.5 hover:bg-surface-hover text-fg"
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
            ref={priorityRef}
            onClick={() => toggle("priority")}
            disabled={busy}
            className="text-xs px-2.5 py-1.5 rounded hover:bg-surface-hover transition disabled:opacity-40 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
          >
            Priority...
          </button>
          {dropdown === "priority" && (
            <div className="absolute bottom-full left-0 mb-2 bg-sunken border border-line rounded-lg shadow-xl py-1 min-w-[120px]">
              {priorities.map((p) => (
                <button
                  key={p.value}
                  onClick={() => handlePriority(p.value)}
                  className="flex items-center gap-2 w-full text-left text-xs px-3 py-1.5 hover:bg-surface-hover text-fg capitalize"
                >
                  <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: p.color }} />
                  {p.value}
                </button>
              ))}
            </div>
          )}
        </div>

        <span className="w-px h-5 bg-surface-active" />

        {/* Archive — amber: meaningful but reversible (cards move to Archived panel) */}
        <button
          onClick={handleArchive}
          disabled={busy}
          className="text-xs px-2.5 py-1.5 rounded text-warning hover:bg-warning/20 transition disabled:opacity-40 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
        >
          Archive
        </button>

        {/* Delete */}
        <button
          onClick={() => setConfirmDelete(true)}
          disabled={busy}
          className="text-xs px-2.5 py-1.5 rounded text-danger hover:bg-danger/20 transition disabled:opacity-40 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
        >
          Delete
        </button>

        <span className="w-px h-5 bg-surface-active" />

        {/* Deselect */}
        <button
          onClick={() => { setPartialError(null); onClearSelection(); }}
          disabled={busy}
          className="text-fg-tertiary hover:text-fg transition p-1 disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 rounded"
          title="Deselect all (Esc)"
        >
          <svg className="w-4 h-4" viewBox="0 0 20 20" fill="currentColor">
            <path fillRule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clipRule="evenodd" />
          </svg>
        </button>

        <span className="text-xs h-4 flex items-center min-w-0">
          {partialError && (
            <span className="text-warning truncate max-w-[20rem]" title={partialError}>{partialError}</span>
          )}
          {busy && (
            <span className="text-fg-tertiary animate-pulse">Working...</span>
          )}
        </span>
      </div>

      {/* Delete confirmation modal */}
      {confirmDelete && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
          <div role="dialog" aria-modal="true" aria-labelledby="bulk-delete-title" className="bg-surface rounded-xl p-6 w-full max-w-sm shadow-xl">
            <h3 id="bulk-delete-title" className="text-fg font-semibold text-lg mb-2">Delete {count} card{count !== 1 ? "s" : ""}?</h3>
            <p className="text-fg-tertiary text-sm mb-5">
              This will permanently delete {count === 1 ? "this card" : `all ${count} selected cards`}. This cannot be undone.
            </p>
            {!canModifyAll && othersCards.length > 0 && (
              <p className="text-xs text-warning -mt-3 mb-4">
                {othersCards.length === count
                  ? "You can only delete cards you created. None of the selected cards will be deleted."
                  : `${othersCards.length} card${othersCards.length !== 1 ? "s" : ""} created by others will be skipped.`}
              </p>
            )}
            <div className="flex gap-3 justify-end">
              <button
                onClick={() => setConfirmDelete(false)}
                className="text-fg-tertiary text-sm hover:text-fg px-3 py-1.5"
              >
                Cancel
              </button>
              <button
                onClick={handleDelete}
                className="bg-red-600 hover:bg-red-700 text-fg text-sm px-4 py-1.5 rounded font-medium focus:outline-none focus:ring-2 focus:ring-red-500"
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
