import { useRef, useState } from "react";
import { useEscapeStack } from "../../hooks/useEscapeStack";
import type { BoardFull, Card, Priority, User } from "../../types";
import { moveCard, updateCard, archiveCard } from "../../api/cards";
import { failureReason } from "../../utils/moveFailure";
import CardDeleteConfirm from "../Card/CardDeleteConfirm";
import { assignChoices, moveChoices, priorityChoices } from "../../utils/cardActions";
import { MENU_ITEM_FOCUS_RING } from "../Common/menuItemFocusRing";
import { useInstanceFlags } from "../../contexts/InstanceFlagsContext";
import { usePublishedHeight } from "../../hooks/usePublishedHeight";
import { DEMO_CARD_FOOTER_NOTE } from "../../constants/demoCopy";

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

const plural = (n: number) => `card${n !== 1 ? "s" : ""}`;

export default function BulkActionToolbar({ board, selectedCardIds, onCardsUpdated, onCardsDeleted, onCardsArchived, onClearSelection, currentUser }: Props) {
  const [dropdown, setDropdown] = useState<Dropdown>(null);
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [partialError, setPartialError] = useState<string | null>(null);

  // The shared toast region floats above the toolbar (frontend/CLAUDE.md § Toasts).
  const rootRef = useRef<HTMLDivElement>(null);
  usePublishedHeight(rootRef, "--bulk-toolbar-h");

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

  const count = selectedCardIds.size;
  const selectedCards = board.cards.filter((c) => selectedCardIds.has(c.id));

  const role = board.current_user_role;
  const isModerator = board.members.some(
    (m) => currentUser != null && m.user.id === currentUser.id && m.is_moderator,
  );
  // Feeds ONLY the delete confirmation's "cards created by others will be
  // skipped" note. Deliberately NOT widened for the hosted demo (#1179): card
  // delete is not on DEMO_ALLOWED_WRITES, and in demo mode the Delete button
  // is inert, so the confirmation (and this note) can never open.
  const canModifyAll = role === "admin" || role === "site_admin" || isModerator;
  const demoMode = useInstanceFlags().demo_mode;

  const toggle = (d: Dropdown) => setDropdown((prev) => (prev === d ? null : d));

  const handleMove = async (columnId: number) => {
    setDropdown(null);
    setPartialError(null);
    setBusy(true);
    // Serialize move requests to avoid database deadlocks from concurrent
    // position-reorder transactions targeting the same column.
    const updated: Card[] = [];
    const reasons = new Set<string>();
    for (const card of selectedCards) {
      try {
        const result = await moveCard(board.id, card.id, {
          column_id: columnId,
          swimlane_id: card.swimlane,
          position: 9999,
        });
        updated.push(result.card);
      } catch (err) {
        // Continue moving remaining cards on individual failures
        reasons.add(failureReason(err));
      }
    }
    if (updated.length > 0) onCardsUpdated(updated);
    const failed = selectedCards.length - updated.length;
    if (failed > 0) {
      // Keep selection active so the user can see which cards remain and dismiss manually.
      setPartialError(
        `${failed} of ${selectedCards.length} ${plural(selectedCards.length)} could not be moved — ${
          reasons.size === 1 ? [...reasons][0] : "for more than one reason"
        }.`
      );
    } else {
      onClearSelection();
    }
    setBusy(false);
  };

  // Shared by the Promise.allSettled handlers: on any failure keep the whole
  // selection and say so (same as Archive/Delete); clear it only on full success.
  const reportBulkResult = (results: PromiseSettledResult<unknown>[], verb: string, forbidden?: string) => {
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    if (rejected.length > 0) {
      const reasons = new Set(rejected.map((r) => failureReason(r.reason, forbidden)));
      setPartialError(
        `${rejected.length} of ${results.length} ${plural(results.length)} could not be ${verb} — ${
          reasons.size === 1 ? [...reasons][0] : "for more than one reason"
        }.`
      );
    } else {
      onClearSelection();
    }
    setBusy(false);
  };

  const handleAssign = async (userId: number | null) => {
    setDropdown(null);
    setPartialError(null);
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
    reportBulkResult(results, "assigned");
  };

  const handlePriority = async (priority: Priority) => {
    setDropdown(null);
    setPartialError(null);
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
    reportBulkResult(results, "updated");
  };

  const handleArchive = async () => {
    if (demoMode) return; // #2105: disabled on the demo with the shared reason
    setPartialError(null);
    setBusy(true);
    const results = await Promise.allSettled(
      selectedCards.map((card) => archiveCard(board.id, card.id).then(() => card.id))
    );
    const archivedIds = results
      .filter((r): r is PromiseFulfilledResult<number> => r.status === "fulfilled")
      .map((r) => r.value);
    if (archivedIds.length > 0) onCardsArchived(archivedIds);
    reportBulkResult(results, "archived", "you can only archive cards you created");
  };

  // The same Move / Assign / Priority lists the card context menu and ⌘K
  // palette offer (#2103), so the three surfaces cannot drift apart.
  const moveItems = moveChoices(board.columns);
  const assignItems = assignChoices(board.members);
  const priorityItems = priorityChoices();

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

  const handleMoveItemKeyDown = makeItemKeyDown(moveItemRefs, moveItems.length, moveRef);
  const handleAssignItemKeyDown = makeItemKeyDown(assignItemRefs, assignItems.length, assignRef);
  const handlePriorityItemKeyDown = makeItemKeyDown(priorityItemRefs, priorityItems.length, priorityRef);

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
      {/* An open menu opens upward into the space the toast region floats in,
          so the toolbar outranks the region (z-[55]) while one is open. */}
      <div ref={rootRef} className={`fixed bottom-4 left-1/2 -translate-x-1/2 ${dropdown !== null ? "z-[56]" : "z-40"} w-max max-w-[calc(100%-2rem)] flex flex-wrap items-center justify-center gap-2 bg-surface text-fg rounded-lg shadow-2xl px-4 py-2.5 border border-line`}>
        <span className="text-sm font-medium tabular-nums">
          {count} selected
        </span>
        <span aria-hidden="true" className="hidden sm:block w-px h-5 bg-surface-active" />

        {/* Move */}
        <div className="relative max-[540px]:static">
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
              className="absolute bottom-full left-0 max-[540px]:inset-x-0 mb-2 bg-sunken border border-line rounded-lg shadow-xl py-1 min-w-[160px] max-w-[calc(100vw-2rem)] max-h-64 overflow-auto"
            >
              {moveItems.map((col, i) => (
                <button
                  key={col.key}
                  ref={(el) => { moveItemRefs.current[i] = el; }}
                  role="menuitem"
                  onClick={() => handleMove(col.value as number)}
                  onKeyDown={(e) => handleMoveItemKeyDown(e, i)}
                  className={`flex items-center gap-2 w-full text-left text-xs px-3 py-1.5 hover:bg-surface-hover text-fg ${MENU_ITEM_FOCUS_RING}`}
                >
                  <span className="color-dot w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: col.dot }} />
                  {col.label}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Assign */}
        <div className="relative max-[540px]:static">
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
              className="absolute bottom-full left-0 max-[540px]:inset-x-0 mb-2 bg-sunken border border-line rounded-lg shadow-xl py-1 min-w-[160px] max-w-[calc(100vw-2rem)] max-h-64 overflow-auto"
            >
              {assignItems.map((m, i) => (
                <button
                  key={m.key}
                  ref={(el) => { assignItemRefs.current[i] = el; }}
                  role="menuitem"
                  onClick={() => handleAssign(m.value as number | null)}
                  onKeyDown={(e) => handleAssignItemKeyDown(e, i)}
                  className={`w-full text-left text-xs px-3 py-1.5 hover:bg-surface-hover ${m.italic ? "text-fg-tertiary italic" : "text-fg"} ${MENU_ITEM_FOCUS_RING}`}
                >
                  {m.label}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Priority */}
        <div className="relative max-[540px]:static">
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
              className="absolute bottom-full left-0 max-[540px]:inset-x-0 mb-2 bg-sunken border border-line rounded-lg shadow-xl py-1 min-w-[120px] max-w-[calc(100vw-2rem)]"
            >
              {priorityItems.map((p, i) => (
                <button
                  key={p.key}
                  ref={(el) => { priorityItemRefs.current[i] = el; }}
                  role="menuitem"
                  onClick={() => handlePriority(p.value as Priority)}
                  onKeyDown={(e) => handlePriorityItemKeyDown(e, i)}
                  className={`flex items-center gap-2 w-full text-left text-xs px-3 py-1.5 hover:bg-surface-hover text-fg capitalize ${MENU_ITEM_FOCUS_RING}`}
                >
                  <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: p.dot }} />
                  {String(p.value)}
                </button>
              ))}
            </div>
          )}
        </div>

        <span aria-hidden="true" className="hidden sm:block w-px h-5 bg-surface-active" />

        {/* Archive — amber: meaningful but reversible (cards move to Archived panel).
            Archive and Delete are withheld on the hosted demo (#2105), matching
            the card sheet, context menu and ⌘K (#2059/#1179): aria-disabled,
            never native disabled, with the shared reason (frontend/CLAUDE.md
            § Hosted demo surfaces). A UI restriction only: the fence would
            allow the archive itself. */}
        <button
          onClick={handleArchive}
          disabled={busy}
          aria-disabled={demoMode ? true : undefined}
          title={demoMode ? DEMO_CARD_FOOTER_NOTE : undefined}
          aria-label={demoMode ? `Archive. ${DEMO_CARD_FOOTER_NOTE}` : undefined}
          className={`text-xs px-2.5 py-1.5 rounded text-warning transition disabled:opacity-40 disabled:cursor-not-allowed focus:outline-none focus:ring-2 focus:ring-primary-emphasis ${
            demoMode ? "opacity-40 cursor-not-allowed" : "hover:bg-warning/20 hover:text-warning-on-tint"
          }`}
        >
          Archive
        </button>

        <button
          onClick={() => { if (!demoMode) setConfirmDelete(true); }}
          disabled={busy}
          aria-disabled={demoMode ? true : undefined}
          title={demoMode ? DEMO_CARD_FOOTER_NOTE : undefined}
          aria-label={demoMode ? `Delete. ${DEMO_CARD_FOOTER_NOTE}` : undefined}
          className={`text-xs px-2.5 py-1.5 rounded text-danger transition disabled:opacity-40 disabled:cursor-not-allowed focus:outline-none focus:ring-2 focus:ring-primary-emphasis ${
            demoMode ? "opacity-40 cursor-not-allowed" : "hover:bg-danger/20 hover:text-danger-on-tint"
          }`}
        >
          Delete
        </button>

        <span aria-hidden="true" className="hidden sm:block w-px h-5 bg-surface-active" />

        {/* Deselect */}
        <button
          onClick={() => { setPartialError(null); onClearSelection(); }}
          disabled={busy}
          className="text-fg-tertiary hover:text-fg transition p-1 disabled:opacity-40 focus:outline-none focus:ring-2 focus:ring-primary-emphasis rounded"
          title="Deselect all (Esc)"
          aria-label="Deselect all (Esc)"
        >
          <svg className="w-4 h-4" viewBox="0 0 20 20" fill="currentColor">
            <path fillRule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clipRule="evenodd" />
          </svg>
        </button>

        {/* Persistent live region: always mounted so assistive tech announces the
            text swap; conditionally mounting the region itself is unreliable. */}
        <span role="status" aria-live="polite" aria-atomic="true" className="text-xs min-h-4 flex items-center min-w-0">
          {partialError && (
            <span className="text-warning line-clamp-2 max-w-full sm:max-w-[20rem]" title={partialError}>{partialError}</span>
          )}
        </span>
        {busy && (
          <span aria-hidden="true" className="text-xs text-fg-tertiary animate-pulse motion-reduce:animate-none">Working...</span>
        )}
      </div>

      {confirmDelete && (
        <CardDeleteConfirm
          boardId={board.id}
          cards={selectedCards}
          canModifyAll={canModifyAll}
          currentUserId={currentUser?.id ?? null}
          onStart={() => { setDropdown(null); setBusy(true); setPartialError(null); }}
          onDeleted={onCardsDeleted}
          onClose={(failure, canceled) => {
            setConfirmDelete(false);
            // Cancel/Escape only closes the dialog; the selection stays.
            if (canceled) return;
            setBusy(false);
            // Keep the selection on any failure so the user can see what is left.
            if (failure) setPartialError(failure);
            else onClearSelection();
          }}
        />
      )}
    </>
  );
}
