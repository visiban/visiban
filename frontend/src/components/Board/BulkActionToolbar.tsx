import { useId, useRef, useState } from "react";
import { useEscapeStack } from "../../hooks/useEscapeStack";
import type { BoardFull, Card, Priority, User } from "../../types";
import CardDeleteConfirm from "../Card/CardDeleteConfirm";
import {
  allRefusedMessage, archiveCards, assignCards, assignChoices, cardActionEntries, moveCardsToColumn,
  MOVE_ASSIGNED_REASON, OWNER_ONLY_REASON, moveChoices, priorityChoices, setCardsPriority, type CardActionContext, type OwnershipAction,
} from "../../utils/cardActions";
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
  /**
   * The shared availability context BoardView builds for the card context
   * menu and the palette. The toolbar derives nothing of its own, so the
   * three surfaces gate and word a refusal identically (#2173).
   */
  cardActionCtx: CardActionContext;
  /**
   * The slot's text. Controlled by BoardView so a context-menu or palette
   * result over this same selection reports here too (#2173).
   */
  message: string | null;
  onMessageChange: (message: string | null) => void;
}

type Dropdown = "move" | "assign" | "priority" | null;

export default function BulkActionToolbar({ board, selectedCardIds, onCardsUpdated, onCardsDeleted, onCardsArchived, onClearSelection, currentUser, cardActionCtx, message: partialError, onMessageChange: setPartialError }: Props) {
  const [dropdown, setDropdown] = useState<Dropdown>(null);
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const refusalIdPrefix = useId();

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

  // Feeds ONLY the delete confirmation's "cards created by others will be
  // skipped" note. Deliberately NOT widened for the hosted demo (#1179): card
  // delete is not on DEMO_ALLOWED_WRITES, and in demo mode the Delete button
  // is inert, so the confirmation (and this note) can never open.
  const canModifyAll = cardActionCtx.role === "admin" || cardActionCtx.role === "site_admin" || cardActionCtx.isModerator;
  const demoMode = useInstanceFlags().demo_mode;

  // Same availability the context menu shows for this selection. A button is
  // refused when the client knows every selected card is (role, maintenance,
  // ownership); one card that may go keeps it enabled (#2173).
  const entries = cardActionEntries(selectedCards, cardActionCtx);
  const entryFor = (id: "move" | "assign" | "priority" | "archive") => entries.find((e) => e.id === id)!;
  const moveEntry = entryFor("move");
  const assignEntry = entryFor("assign");
  const priorityEntry = entryFor("priority");
  const archiveEntry = entryFor("archive");

  // A refused button is aria-disabled, never native disabled: it stays in the
  // tab order so the reason is reachable, and activating it writes the reason
  // into the status slot (§ Bulk operations). `aria-disabled` stops nothing,
  // so every handler guards (§ aria-disabled needs a handler guard).
  const refuseMessage = (action: OwnershipAction, verb: string, reason: string | undefined) =>
    // Name the gate that actually applies. cardActionEntries checks maintenance
    // and role first, so only an ownership reason reads in the rule-2 wording;
    // any other gate (maintenance, role, demo) already reads as a sentence.
    (reason === OWNER_ONLY_REASON || reason === MOVE_ASSIGNED_REASON)
      ? allRefusedMessage(selectedCards, action, verb)
      : reason ?? "";
  const refuse = (action: OwnershipAction, verb: string, reason: string | undefined) => {
    setDropdown(null);
    const text = refuseMessage(action, verb, reason);
    // Clear first, then set on the next tick: an identical repeat message
    // would change nothing in the live region and so not be announced again.
    setPartialError(null);
    setTimeout(() => setPartialError(text), 0);
  };
  const refusalProps = (key: string, entry: { enabled: boolean; reason?: string }) =>
    entry.enabled ? {} : {
      "aria-disabled": true as const,
      title: entry.reason,
      "aria-describedby": `${refusalIdPrefix}-${key}`,
    };

  const toggle = (d: Dropdown) => setDropdown((prev) => (prev === d ? null : d));

  // Move, Assign, Priority and Archive run through the same executors as the
  // card context menu and the palette (cardActions.ts), which skip the cards
  // known to be refused and report them in the rule-2 wording.
  const finish = (failure: string | null) => {
    // Keep selection active so the user can see which cards remain and dismiss manually.
    if (failure) setPartialError(failure);
    else onClearSelection();
    setBusy(false);
  };

  const handleMove = async (columnId: number) => {
    const column = board.columns.find((c) => c.id === columnId);
    if (!column) return;
    setDropdown(null);
    setPartialError(null);
    setBusy(true);
    const r = await moveCardsToColumn(board.id, selectedCards, column, cardActionCtx);
    if (r.done.length > 0) onCardsUpdated(r.done);
    finish(r.failureMessage);
  };

  const handleAssign = async (userId: number | null) => {
    setDropdown(null);
    setPartialError(null);
    setBusy(true);
    const r = await assignCards(board.id, selectedCards, userId, cardActionCtx);
    if (r.done.length > 0) onCardsUpdated(r.done);
    finish(r.failureMessage);
  };

  const handlePriority = async (priority: Priority) => {
    setDropdown(null);
    setPartialError(null);
    setBusy(true);
    const r = await setCardsPriority(board.id, selectedCards, priority, cardActionCtx);
    if (r.done.length > 0) onCardsUpdated(r.done);
    finish(r.failureMessage);
  };

  const handleArchive = async () => {
    if (demoMode) return; // #2105: disabled on the demo with the shared reason
    if (!archiveEntry.enabled) { refuse("archive", "archived", archiveEntry.reason); return; }
    setPartialError(null);
    setBusy(true);
    const r = await archiveCards(board.id, selectedCards, cardActionCtx);
    if (r.done.length > 0) onCardsArchived(r.done);
    finish(r.failureMessage);
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

  // A refused trigger never opens its menu: activating it says why instead.
  const moveOpen = () => (moveEntry.enabled ? toggle("move") : refuse("move", "moved", moveEntry.reason));
  const assignOpen = () => (assignEntry.enabled ? toggle("assign") : refuse("assign", "assigned", assignEntry.reason));
  const priorityOpen = () => (priorityEntry.enabled ? toggle("priority") : refuse("priority", "updated", priorityEntry.reason));

  const handleMoveItemKeyDown = makeItemKeyDown(moveItemRefs, moveItems.length, moveRef);
  const handleAssignItemKeyDown = makeItemKeyDown(assignItemRefs, assignItems.length, assignRef);
  const handlePriorityItemKeyDown = makeItemKeyDown(priorityItemRefs, priorityItems.length, priorityRef);

  const handleMoveTriggerKeyDown = makeTriggerKeyDown(
    dropdown === "move",
    moveOpen,
    moveItemRefs,
  );
  const handleAssignTriggerKeyDown = makeTriggerKeyDown(
    dropdown === "assign",
    assignOpen,
    assignItemRefs,
  );
  const handlePriorityTriggerKeyDown = makeTriggerKeyDown(
    dropdown === "priority",
    priorityOpen,
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
            onClick={() => moveOpen()}
            onKeyDown={handleMoveTriggerKeyDown}
            disabled={busy}
            aria-haspopup="menu"
            aria-expanded={dropdown === "move"}
            {...refusalProps("move", moveEntry)}
            className={`text-xs px-2.5 py-1.5 rounded transition disabled:opacity-40 disabled:cursor-not-allowed focus:outline-none focus:ring-2 focus:ring-primary-emphasis ${moveEntry.enabled ? "hover:bg-surface-hover" : "opacity-40 cursor-not-allowed"}`}
          >
            Move to...
          </button>
          {!moveEntry.enabled && <span id={`${refusalIdPrefix}-move`} className="sr-only">{moveEntry.reason}</span>}
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
            onClick={() => assignOpen()}
            onKeyDown={handleAssignTriggerKeyDown}
            disabled={busy}
            aria-haspopup="menu"
            aria-expanded={dropdown === "assign"}
            {...refusalProps("assign", assignEntry)}
            className={`text-xs px-2.5 py-1.5 rounded transition disabled:opacity-40 disabled:cursor-not-allowed focus:outline-none focus:ring-2 focus:ring-primary-emphasis ${assignEntry.enabled ? "hover:bg-surface-hover" : "opacity-40 cursor-not-allowed"}`}
          >
            Assign to...
          </button>
          {!assignEntry.enabled && <span id={`${refusalIdPrefix}-assign`} className="sr-only">{assignEntry.reason}</span>}
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
            onClick={() => priorityOpen()}
            onKeyDown={handlePriorityTriggerKeyDown}
            disabled={busy}
            aria-haspopup="menu"
            aria-expanded={dropdown === "priority"}
            {...refusalProps("priority", priorityEntry)}
            className={`text-xs px-2.5 py-1.5 rounded transition disabled:opacity-40 disabled:cursor-not-allowed focus:outline-none focus:ring-2 focus:ring-primary-emphasis ${priorityEntry.enabled ? "hover:bg-surface-hover" : "opacity-40 cursor-not-allowed"}`}
          >
            Priority...
          </button>
          {!priorityEntry.enabled && <span id={`${refusalIdPrefix}-priority`} className="sr-only">{priorityEntry.reason}</span>}
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
          aria-disabled={demoMode || !archiveEntry.enabled ? true : undefined}
          title={demoMode ? DEMO_CARD_FOOTER_NOTE : archiveEntry.reason}
          aria-label={demoMode ? `Archive. ${DEMO_CARD_FOOTER_NOTE}` : undefined}
          aria-describedby={!demoMode && !archiveEntry.enabled ? `${refusalIdPrefix}-archive` : undefined}
          className={`text-xs px-2.5 py-1.5 rounded text-warning transition disabled:opacity-40 disabled:cursor-not-allowed focus:outline-none focus:ring-2 focus:ring-primary-emphasis ${
            demoMode || !archiveEntry.enabled ? "opacity-40 cursor-not-allowed" : "hover:bg-warning/20 hover:text-warning-on-tint"
          }`}
        >
          Archive
        </button>
        {!demoMode && !archiveEntry.enabled && <span id={`${refusalIdPrefix}-archive`} className="sr-only">{archiveEntry.reason}</span>}

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
        <button type="button"
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
