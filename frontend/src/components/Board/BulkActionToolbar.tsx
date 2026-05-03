import { useRef, useState } from "react";
import { useEscapeStack } from "../../hooks/useEscapeStack";
import type { BoardFull, Card, Column, User } from "../../types";
import { userDisplayName } from "../../types";
import { moveCard, updateCard, deleteCard, archiveCard } from "../../api/cards";
import ModalWrapper from "../shared/ModalWrapper";

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

  // Item refs for keyboard navigation within each dropdown menu
  const moveItemRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const assignItemRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const priorityItemRefs = useRef<(HTMLButtonElement | null)[]>([]);

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

  // Assign dropdown items: Unassign + non-viewer members
  const assignMembers = board.members.filter((m) => m.role !== "viewer");
  // Total assign items = 1 (Unassign) + assignMembers.length
  const assignItemCount = 1 + assignMembers.length;

  // Generic arrow-key handler for a flat list of item refs
  const makeItemKeyDown = (
    itemRefs: React.MutableRefObject<(HTMLButtonElement | null)[]>,
    itemCount: number,
    triggerRef: React.RefObject<HTMLButtonElement | null>,
  ) => (e: React.KeyboardEvent, i: number) => {
    if (e.key === "ArrowDown") {
      itemRefs.current[Math.min(i + 1, itemCount - 1)]?.focus();
      e.preventDefault();
    } else if (e.key === "ArrowUp") {
      if (i === 0) triggerRef.current?.focus();
      else itemRefs.current[i - 1]?.focus();
      e.preventDefault();
    } else if (e.key === "Home") {
      itemRefs.current[0]?.focus();
      e.preventDefault();
    } else if (e.key === "End") {
      itemRefs.current[itemCount - 1]?.focus();
      e.preventDefault();
    }
  };

  // Generic trigger key handler: open + focus first item on ArrowDown
  const makeTriggerKeyDown = (
    isOpen: boolean,
    openFn: () => void,
    itemRefs: React.MutableRefObject<(HTMLButtonElement | null)[]>,
  ) => (e: React.KeyboardEvent) => {
    if (!isOpen) {
      if (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ") {
        openFn();
        e.preventDefault();
      }
      return;
    }
    if (e.key === "ArrowDown") {
      itemRefs.current[0]?.focus();
      e.preventDefault();
    }
  };

  const handleMoveItemKeyDown = makeItemKeyDown(moveItemRefs, board.columns.length, moveRef);
  const handleAssignItemKeyDown = makeItemKeyDown(assignItemRefs, assignItemCount, assignRef);
  const handlePriorityItemKeyDown = makeItemKeyDown(priorityItemRefs, priorities.length, priorityRef);

  const handleMoveTriggerKeyDown = makeTriggerKeyDown(
    dropdown === "move",
    () => toggle("move"),
    moveItemRefs,
  );
  const handleAssignTriggerKeyDown = makeTriggerKeyDown(
    dropdown === "assign",
    () => toggle("assign"),
    assignItemRefs,
  );
  const handlePriorityTriggerKeyDown = makeTriggerKeyDown(
    dropdown === "priority",
    () => toggle("priority"),
    priorityItemRefs,
  );

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
            onKeyDown={handleMoveTriggerKeyDown}
            disabled={busy}
            aria-haspopup="menu"
            aria-expanded={dropdown === "move"}
            className="text-xs px-2.5 py-1.5 rounded hover:bg-surface-hover transition disabled:opacity-40 disabled:cursor-not-allowed focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
          >
            Move to...
          </button>
          {dropdown === "move" && (
            <div
              role="menu"
              className="absolute bottom-full left-0 mb-2 bg-sunken border border-line rounded-lg shadow-xl py-1 min-w-[160px] max-h-64 overflow-auto"
            >
              {board.columns.map((col, i) => (
                <button
                  key={col.id}
                  ref={(el) => { moveItemRefs.current[i] = el; }}
                  role="menuitem"
                  onClick={() => handleMove(col)}
                  onKeyDown={(e) => handleMoveItemKeyDown(e, i)}
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
            onKeyDown={handleAssignTriggerKeyDown}
            disabled={busy}
            aria-haspopup="menu"
            aria-expanded={dropdown === "assign"}
            className="text-xs px-2.5 py-1.5 rounded hover:bg-surface-hover transition disabled:opacity-40 disabled:cursor-not-allowed focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
          >
            Assign to...
          </button>
          {dropdown === "assign" && (
            <div
              role="menu"
              className="absolute bottom-full left-0 mb-2 bg-sunken border border-line rounded-lg shadow-xl py-1 min-w-[160px] max-h-64 overflow-auto"
            >
              <button
                ref={(el) => { assignItemRefs.current[0] = el; }}
                role="menuitem"
                onClick={() => handleAssign(null)}
                onKeyDown={(e) => handleAssignItemKeyDown(e, 0)}
                className="w-full text-left text-xs px-3 py-1.5 hover:bg-surface-hover text-fg-tertiary italic"
              >
                Unassign
              </button>
              {assignMembers.map((m, i) => (
                <button
                  key={m.user.id}
                  ref={(el) => { assignItemRefs.current[i + 1] = el; }}
                  role="menuitem"
                  onClick={() => handleAssign(m.user.id)}
                  onKeyDown={(e) => handleAssignItemKeyDown(e, i + 1)}
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
            onKeyDown={handlePriorityTriggerKeyDown}
            disabled={busy}
            aria-haspopup="menu"
            aria-expanded={dropdown === "priority"}
            className="text-xs px-2.5 py-1.5 rounded hover:bg-surface-hover transition disabled:opacity-40 disabled:cursor-not-allowed focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
          >
            Priority...
          </button>
          {dropdown === "priority" && (
            <div
              role="menu"
              className="absolute bottom-full left-0 mb-2 bg-sunken border border-line rounded-lg shadow-xl py-1 min-w-[120px]"
            >
              {priorities.map((p, i) => (
                <button
                  key={p.value}
                  ref={(el) => { priorityItemRefs.current[i] = el; }}
                  role="menuitem"
                  onClick={() => handlePriority(p.value)}
                  onKeyDown={(e) => handlePriorityItemKeyDown(e, i)}
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
          className="text-xs px-2.5 py-1.5 rounded text-warning hover:bg-warning/20 transition disabled:opacity-40 disabled:cursor-not-allowed focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
        >
          Archive
        </button>

        {/* Delete */}
        <button
          onClick={() => setConfirmDelete(true)}
          disabled={busy}
          className="text-xs px-2.5 py-1.5 rounded text-danger hover:bg-danger/20 transition disabled:opacity-40 disabled:cursor-not-allowed focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
        >
          Delete
        </button>

        <span className="w-px h-5 bg-surface-active" />

        {/* Deselect */}
        <button
          onClick={() => { setPartialError(null); onClearSelection(); }}
          disabled={busy}
          className="text-fg-tertiary hover:text-fg transition p-1 disabled:opacity-40 focus:outline-none focus:ring-2 focus:ring-primary-emphasis rounded"
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

      <ModalWrapper
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        title={`Delete ${count} card${count !== 1 ? "s" : ""}?`}
        maxWidth="max-w-sm"
        labelId="bulk-delete-title"
      >
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
        <div className="flex items-center justify-end gap-3">
          <button
            onClick={() => setConfirmDelete(false)}
            className="text-fg-secondary hover:text-fg hover:bg-surface-hover px-3 py-1.5 text-sm rounded transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
          >
            Cancel
          </button>
          <button
            onClick={handleDelete}
            className="bg-danger-bg hover:bg-danger-bg-hover text-on-danger px-3 py-1.5 text-sm rounded font-medium focus:outline-none focus:ring-2 focus:ring-danger-emphasis"
          >
            Delete
          </button>
        </div>
      </ModalWrapper>
    </>
  );
}
