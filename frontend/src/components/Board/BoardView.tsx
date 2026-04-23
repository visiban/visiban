import React, { useState, useCallback, useEffect, useRef, useMemo } from "react";
import { getCardStatus } from "../../api/cards";
import { resetTour } from "../../api/auth";
import { useSearchParams } from "react-router-dom";
import SummaryView from "./SummaryView";
import AnalyticsView from "./AnalyticsView";
import MovementHistoryView from "./MovementHistoryView";
import { useBoardSocket } from "../../hooks/useBoardSocket";
import { useEscapeStack } from "../../hooks/useEscapeStack";
import type { BoardEvent } from "../../hooks/useBoardSocket";
import ConnectionStatus from "../Common/ConnectionStatus";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  useDroppable,
} from "@dnd-kit/core";
import type { DragEndEvent, DragStartEvent, DragOverEvent, CollisionDetection } from "@dnd-kit/core";
import { SortableContext, horizontalListSortingStrategy, verticalListSortingStrategy, arrayMove } from "@dnd-kit/sortable";
import type { BoardMembership, Card, Column, Label, Swimlane, User } from "../../types";
import { useBoardContext } from "../../contexts/BoardContext";
import ColumnHeader from "./ColumnHeader";
import ColumnSeparator from "./ColumnSeparator";
import RowSeparator from "./RowSeparator";
import SwimlaneRow from "./SwimlaneRow";
import CardItem from "../Card/CardItem";
import CardDetail from "../Card/CardDetail";
import AddColumnModal from "./AddColumnModal";
import AddSwimlaneModal from "../Swimlane/AddSwimlaneModal";
import BoardSettingsModal from "./BoardSettingsModal";
import BoardExportModal from "./BoardExportModal";
import { useExportSeenPref } from "../../hooks/useExportSeenPref";
import { useShortcutsSeenPref } from "../../hooks/useShortcutsSeenPref";
import { useOverflowSeenPref } from "../../hooks/useOverflowSeenPref";
import { useIsLargeViewport } from "../../hooks/useIsLargeViewport";
import SplitButton from "../Common/SplitButton";
import OverflowMenu from "../Layout/OverflowMenu";
import type { OverflowItem } from "../Layout/OverflowMenu";
import { formatShortcut } from "../../utils/platform";
import FilterBar, { countActiveFilters, EMPTY_FILTER } from "./FilterBar";
import SavedFiltersDropdown from "./SavedFiltersDropdown";
import SavedFilterTabs from "./SavedFilterTabs";
import KeyboardShortcutsOverlay from "./KeyboardShortcutsOverlay";
import Tooltip from "../Common/Tooltip";
import BulkActionToolbar from "./BulkActionToolbar";
import ArchivedCardsPanel from "./ArchivedCardsPanel";
import OnboardingTour from "./OnboardingTour";
import { useViewPrefs } from "../../hooks/useViewPrefs";
import { useCardLayoutPref } from "../../hooks/useCardLayoutPref";
import { useBoardPan } from "../../hooks/useBoardPan";
import { usePersistedFilters } from "../../hooks/usePersistedFilters";
import { useSavedFilters } from "../../hooks/useSavedFilters";
import { useBoardResync } from "../../hooks/useBoardResync";
import SectionErrorBoundary from "../SectionErrorBoundary";
import BoardActivityDrawer from "./BoardActivityDrawer";
import type { ActivityEntry } from "./BoardActivityDrawer";
import { useCardSearch } from "../../hooks/useCardSearch";
import { todayInTimezone } from "../../utils/date";
import { filterCards } from "../../utils/filterCards";
import CommandPalette from "../Common/CommandPalette";
import ModalWrapper from "../shared/ModalWrapper";

interface Props {
  onBoardDeleted?: () => void;
  userTimezone?: string;
  userDateFormat?: string;
  userTimeFormat?: string;
  closeEditorOnEnter?: boolean;
  currentUser?: User | null;
  onUserUpdated?: (user: User) => void;
}

function ColumnTrashZone() {
  const { setNodeRef, isOver } = useDroppable({ id: "trash:column" });
  return (
    <div
      ref={setNodeRef}
      className={`w-20 shrink-0 flex items-center justify-center px-2 border-l transition-colors ${
        isOver
          ? "bg-danger/50 border-danger/60"
          : "bg-danger/30 border-line"
      }`}
    >
      <span className={`text-xs font-medium whitespace-nowrap ${isOver ? "text-danger" : "text-fg-secondary"}`}>
        <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4 mx-auto mb-0.5" viewBox="0 0 20 20" fill="currentColor">
          <path fillRule="evenodd" d="M9 2a1 1 0 00-.894.553L7.382 4H4a1 1 0 000 2v10a2 2 0 002 2h8a2 2 0 002-2V6a1 1 0 100-2h-3.382l-.724-1.447A1 1 0 0011 2H9zM7 8a1 1 0 012 0v6a1 1 0 11-2 0V8zm5-1a1 1 0 00-1 1v6a1 1 0 102 0V8a1 1 0 00-1-1z" clipRule="evenodd" />
        </svg>
        Delete
      </span>
    </div>
  );
}

function ViewToggle({
  view,
  onChange,
}: {
  view: "board" | "summary" | "history" | "analytics";
  onChange: (v: "board" | "summary" | "history" | "analytics") => void;
}) {
  const btn = (label: string, val: "board" | "summary" | "history" | "analytics", tourStep?: string) => (
    <button
      onClick={() => onChange(val)}
      className={`text-xs px-2.5 py-1 rounded transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis ${
        view === val
          ? "bg-primary text-on-primary"
          : "text-fg-tertiary hover:text-fg hover:bg-surface-hover"
      }`}
      {...(tourStep ? { "data-tour-step": tourStep } : {})}
    >
      {label}
    </button>
  );
  return (
    <div className="flex items-center gap-0.5 bg-surface-hover rounded p-0.5">
      {btn("Board", "board")}
      {btn("Summary", "summary")}
      {btn("History", "history", "history")}
      <button
        onClick={() => onChange("analytics")}
        className={`text-xs px-2.5 py-1 rounded transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis ${
          view === "analytics"
            ? "bg-primary text-on-primary"
            : "text-fg-tertiary hover:text-fg hover:bg-surface-hover"
        }`}
      >
        <span className="flex items-center gap-1.5">
          Analytics
          <span
            className={`px-1 py-0 text-[10px] font-medium rounded leading-4 ${
              view === "analytics"
                ? "bg-warning/30 text-warning"
                : "bg-warning/20 text-warning"
            }`}
          >
            Beta
          </span>
        </span>
      </button>
    </div>
  );
}

// Icon constants for the overflow menu. Kept at module scope so the JSX
// nodes are stable across renders and the items useMemo is not invalidated
// by fresh icon references every render.
const LayoutCompactIcon = (
  <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" aria-hidden="true">
    <rect x="3" y="3" width="18" height="5" rx="1" />
    <rect x="3" y="10" width="18" height="5" rx="1" />
    <rect x="3" y="17" width="18" height="4" rx="1" />
  </svg>
);
const LayoutExpandedIcon = (
  <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" aria-hidden="true">
    <rect x="3" y="3" width="7" height="7" rx="1" />
    <rect x="14" y="3" width="7" height="7" rx="1" />
    <rect x="3" y="14" width="7" height="7" rx="1" />
    <rect x="14" y="14" width="7" height="7" rx="1" />
  </svg>
);
const ArchivedIcon = (
  <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" aria-hidden="true">
    <path d="M4 8v11a2 2 0 002 2h12a2 2 0 002-2V8" strokeLinejoin="round" />
    <rect x="2" y="3" width="20" height="5" rx="1" />
    <line x1="10" y1="12" x2="14" y2="12" strokeLinecap="round" />
  </svg>
);
const ActivityDrawerIcon = (
  <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" aria-hidden="true">
    <circle cx="5" cy="7" r="1.5" fill="currentColor" stroke="none" />
    <line x1="9" y1="7" x2="20" y2="7" />
    <circle cx="5" cy="12" r="1.5" fill="currentColor" stroke="none" />
    <line x1="9" y1="12" x2="20" y2="12" />
    <circle cx="5" cy="17" r="1.5" fill="currentColor" stroke="none" />
    <line x1="9" y1="17" x2="16" y2="17" />
  </svg>
);
const SettingsIcon = (
  <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" aria-hidden="true">
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83 0 2 2 0 010-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 010-2.83 2 2 0 012.83 0l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 0 2 2 0 010 2.83l-.06.06A1.65 1.65 0 0019.32 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z" />
  </svg>
);
const ExportIcon = (
  <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" aria-hidden="true">
    <path d="M12 3v12M8 11l4 4 4-4" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M4 17v2a2 2 0 002 2h12a2 2 0 002-2v-2" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);
const ShortcutsIcon = (
  <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" aria-hidden="true">
    <rect x="2" y="6" width="20" height="12" rx="2" />
    <line x1="6" y1="10" x2="6" y2="10.01" />
    <line x1="10" y1="10" x2="10" y2="10.01" />
    <line x1="14" y1="10" x2="14" y2="10.01" />
    <line x1="18" y1="10" x2="18" y2="10.01" />
    <line x1="8" y1="14" x2="16" y2="14" />
  </svg>
);
const ReplayTourIcon = (
  <svg className="w-4 h-4" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
    <path d="M13.5 8A5.5 5.5 0 1 1 8 2.5" strokeLinecap="round" />
    <polyline points="8,1 8,4 11,4" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

export default function BoardView({ onBoardDeleted, userTimezone = "", userDateFormat = "MM/DD/YYYY", userTimeFormat = "12h", closeEditorOnEnter = false, currentUser = null, onUserUpdated }: Props) {
  const {
    board: boardOrNull,
    moveCard: onMoveCard,
    addCard: onCardAdded,
    removeCard,
    updateCard: onCardUpdated,
    addColumn: onColumnAdded,
    updateColumn: onColumnUpdated,
    removeColumn: onColumnDeleted,
    reorderColumns: onColumnsReordered,
    addSwimlane: onSwimlaneAdded,
    updateSwimlane: onSwimlaneUpdated,
    removeSwimlane: onSwimlaneDeleted,
    reorderSwimlanes: onSwimlanesReordered,
    addLabel: onLabelAdded,
    updateLabel: onLabelUpdated,
    removeLabel: onLabelDeleted,
    addMember: onMemberAdded,
    updateMember: onMemberUpdated,
    removeMember: onMemberRemoved,
    applyColumnOrder: onColumnOrderApplied,
    applySwimlaneOrder: onSwimlaneOrderApplied,
    updateBoardSettings: onUpdateBoardSettings,
    evictColumn,
    evictSwimlane,
    evictCardByUid,
    mergeBoardState,
    silentReload,
  } = useBoardContext();

  // BoardView is only rendered when board is non-null (guarded by the parent).
  // The non-null assertion keeps the existing contract without changing every
  // downstream reference from BoardFull to BoardFull | null.
  const board = boardOrNull!;

  // Re-fetch board state when the user returns to a backgrounded tab.
  useBoardResync(silentReload);

  // Alias removeCard for the two semantic uses (archive and delete both remove
  // the card from local state).
  const onCardDeleted = removeCard;
  const onCardArchived = removeCard;
  const onCardUnarchived = onCardAdded;
  const isAdmin = board.current_user_role === "admin" || board.current_user_role === "site_admin";
  const canEdit = isAdmin || board.current_user_role === "member";
  // #843 — mirror of the backend per-board export gate. Owner / site_admin
  // always bypass; everyone else must meet ``board.export_min_role``. When
  // the threshold flips via WebSocket, the Export button re-evaluates on
  // re-render and hides itself, and the auto-close effect below dismisses
  // an open export modal so the user doesn't click into a 403.
  const EXPORT_ROLE_RANK: Record<string, number> = { viewer: 0, collaborator: 1, member: 2, admin: 3 };
  const exportMinRole = board.export_min_role ?? "viewer";
  const canExport =
    board.current_user_role === "site_admin" ||
    board.current_user_role === "admin" ||
    (board.current_user_role != null &&
      EXPORT_ROLE_RANK[board.current_user_role] >= (EXPORT_ROLE_RANK[exportMinRole] ?? 0));

  const validColumnIds = useMemo(() => new Set(board.columns.map((c) => c.id)), [board.columns]);
  const validSwimlaneIds = useMemo(() => new Set(board.swimlanes.map((s) => s.id)), [board.swimlanes]);
  const { prefs: viewPrefs, toggleHiddenColumn, toggleCollapsedColumn, expandAllColumns, collapseAllColumns, toggleHiddenSwimlane, toggleCollapsedSwimlane, collapseAllSwimlanes, expandAllSwimlanes, setSwimlaneColumnWidth, setColumnWidth, setSwimlaneHeight, setCardFieldPref } = useViewPrefs(board.id, validColumnIds, validSwimlaneIds);
  const [cardLayout, setCardLayout] = useCardLayoutPref();

  // Wrap in useMemo so downstream memos don't re-run on every render due to new Set instances
  const hiddenColumnIds = useMemo(() => new Set(viewPrefs.hiddenColumnIds), [viewPrefs.hiddenColumnIds]);
  const hiddenSwimlaneIds = useMemo(() => new Set(viewPrefs.hiddenSwimlaneIds), [viewPrefs.hiddenSwimlaneIds]);
  // Collapsed = explicitly listed in collapsedColumnIds. All other columns are expanded by default.
  const collapsedColumnIds = useMemo(() => new Set(viewPrefs.collapsedColumnIds), [viewPrefs.collapsedColumnIds]);
  const allColumnsExpanded = board.columns.every((c) => !collapsedColumnIds.has(c.id));
  // Swimlane collapsed state — driven by useViewPrefs, seeded from board.swimlanes[*].is_collapsed on first load.
  const collapsedSwimlaneIds = useMemo(() => new Set(viewPrefs.collapsedSwimlaneIds), [viewPrefs.collapsedSwimlaneIds]);
  const allSwimlanesExpanded = board.swimlanes.every((s) => !collapsedSwimlaneIds.has(s.id));
  const allExpanded = allColumnsExpanded && allSwimlanesExpanded;


  const handleSocketEvent = useCallback((event: BoardEvent) => {
    const d = event.data;
    if (event.event === "card.created") {
      onCardAdded(d as unknown as Card);
    } else if (event.event === "card.moved") {
      // card.moved payload is { card, movement } — consistent with the REST response
      onCardUpdated((d as unknown as { card: Card }).card);
    } else if (event.event === "card.updated") {
      onCardUpdated(d as unknown as Card);
    } else if (event.event === "card.deleted") {
      evictCardByUid((d as { card_uid: string }).card_uid);
    } else if (event.event === "card.archived") {
      evictCardByUid((d as { card_uid: string }).card_uid);
    } else if (event.event === "card.unarchived") {
      onCardUnarchived(d as unknown as Card);
    } else if (event.event === "column.created") {
      onColumnAdded(d as unknown as Column);
    } else if (event.event === "column.updated") {
      onColumnUpdated(d as unknown as Column);
    } else if (event.event === "column.deleted") {
      // Use state-only eviction — the delete already happened on the server;
      // calling onColumnDeleted would fire a redundant DELETE API request.
      evictColumn((d as { column_uid: string }).column_uid);
    } else if (event.event === "columns.reordered" || event.event === "column.reordered") {
      // Backend emits both plural (legacy 1.0) and singular (canonical from 1.1) names
      // during the deprecation window; the plural form will be removed in 2.0.
      onColumnOrderApplied((d as { columns: Column[] }).columns);
    } else if (event.event === "swimlane.created") {
      onSwimlaneAdded(d as unknown as Swimlane);
    } else if (event.event === "swimlane.updated") {
      onSwimlaneUpdated(d as unknown as Swimlane);
    } else if (event.event === "swimlane.deleted") {
      // Use state-only eviction — the delete already happened on the server;
      // calling onSwimlaneDeleted would fire a redundant DELETE API request.
      evictSwimlane((d as { swimlane_uid: string }).swimlane_uid);
    } else if (event.event === "swimlanes.reordered" || event.event === "swimlane.reordered") {
      // Backend emits both plural (legacy 1.0) and singular (canonical from 1.1) names
      // during the deprecation window; the plural form will be removed in 2.0.
      onSwimlaneOrderApplied((d as { swimlanes: Swimlane[] }).swimlanes);
    } else if (event.event === "label.created") {
      onLabelAdded(d as unknown as Label);
    } else if (event.event === "label.updated") {
      onLabelUpdated(d as unknown as Label);
    } else if (event.event === "label.deleted") {
      onLabelDeleted((d as { label_uid: string }).label_uid);
    } else if (event.event === "member.added") {
      onMemberAdded(d as unknown as BoardMembership);
    } else if (event.event === "member.updated") {
      const updatedMembership = d as unknown as BoardMembership;
      onMemberUpdated(updatedMembership);
      // If the role change affects the current user, sync current_user_role
      // immediately. Without this, canEdit/isAdmin are computed from the stale
      // value set during the last /full/ fetch and the user retains the wrong
      // UI affordances until they reload the page.
      if (currentUser && updatedMembership.user.id === currentUser.id) {
        mergeBoardState({ current_user_role: updatedMembership.role });
      }
    } else if (event.event === "member.removed") {
      onMemberRemoved((d as { user_id: number }).user_id);
    } else if (event.event === "board.updated") {
      // Another user changed board-level settings — merge the patch into local
      // state without calling the API. The mutation already happened on the
      // server; onUpdateBoardSettings would fire a redundant PATCH request.
      mergeBoardState(d as Partial<typeof board>);
    } else if (event.event === "board.deleted") {
      // Board was deleted by another user — navigate away
      onBoardDeleted?.();
    } else if (event.event === "board.star_changed") {
      // Star is per-user state; only apply when the event belongs to the
      // current user's session (e.g. another tab for the same user).
      const payload = d as { user_id?: number; is_starred?: boolean };
      if (currentUser && payload.user_id === currentUser.id) {
        mergeBoardState({ is_starred: !!payload.is_starred });
      }
    }
  }, [onCardAdded, onCardUpdated, onCardUnarchived, evictCardByUid, onColumnAdded, onColumnUpdated, evictColumn, onColumnOrderApplied, onSwimlaneAdded, onSwimlaneUpdated, evictSwimlane, onSwimlaneOrderApplied, onLabelAdded, onLabelUpdated, onLabelDeleted, onMemberAdded, onMemberUpdated, onMemberRemoved, mergeBoardState, onBoardDeleted, currentUser]);

  // Collect a subset of WS events into the activity feed for the drawer.
  // Runs alongside handleSocketEvent — does not interfere with board state updates.
  const collectActivityEvent = useCallback((event: BoardEvent) => {
    let entry: ActivityEntry | null = null;
    const d = event.data as Record<string, unknown>;
    if (event.event === "card.moved") {
      const card = (d.card as { title?: string } | undefined);
      const movement = d.movement as { from_column_name?: string; to_column_name?: string; user?: { display_name?: string } } | undefined;
      entry = {
        id: crypto.randomUUID(),
        timestamp: new Date(),
        kind: "move",
        actor: movement?.user?.display_name ?? "Someone",
        headline: `moved ${card?.title ?? "a card"}`,
        detail: movement ? `${movement.from_column_name} → ${movement.to_column_name}` : "",
      };
    } else if (event.event === "card.created") {
      const card = d as { title?: string; created_by?: { display_name?: string } };
      entry = {
        id: crypto.randomUUID(),
        timestamp: new Date(),
        kind: "create",
        actor: card.created_by?.display_name ?? "Someone",
        headline: `created ${card.title ?? "a card"}`,
        detail: "",
      };
    } else if (event.event === "member.added") {
      const m = d as { user?: { display_name?: string } };
      entry = {
        id: crypto.randomUUID(),
        timestamp: new Date(),
        kind: "member",
        actor: m.user?.display_name ?? "Someone",
        headline: "joined the board",
        detail: "",
      };
    } else if (event.event === "member.removed") {
      entry = {
        id: crypto.randomUUID(),
        timestamp: new Date(),
        kind: "member",
        actor: "A member",
        headline: "was removed from the board",
        detail: "",
      };
    }
    if (entry) {
      setActivityFeed((prev) => [entry!, ...prev].slice(0, 100));
    }
  }, []);

  const combinedSocketHandler = useCallback((event: BoardEvent) => {
    handleSocketEvent(event);
    collectActivityEvent(event);
  }, [handleSocketEvent, collectActivityEvent]);

  const { status: socketStatus, lastEventAt: socketLastEventAt, reconnectAttempt: socketReconnectAttempt } = useBoardSocket(board.id, combinedSocketHandler);

  const [searchParams, setSearchParams] = useSearchParams();
  const [activeCard, setActiveCard] = useState<Card | null>(null);
  const [activeColumn, setActiveColumn] = useState<Column | null>(null);
  const [activeSwimlane, setActiveSwimlane] = useState<Swimlane | null>(null);
  const [dndAnnouncement, setDndAnnouncement] = useState("");
  const dndHoverThrottleRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [selectedCard, setSelectedCard] = useState<Card | null>(null);
  const [highlightedCardId, setHighlightedCardId] = useState<number | null>(null);
  // null = no message; non-null string = message to show in the not-found toast.
  const [cardNotFound, setCardNotFound] = useState<string | null>(null);
  const [archiveToast, setArchiveToast] = useState(false);
  const archiveToastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // --- Focus mode ---
  // Parse ?focus= param; validate against board.swimlanes; null if absent or invalid (silent ignore).
  const rawFocus = searchParams.get("focus");
  const focusedSwimlaneId: number | null = (() => {
    if (!rawFocus) return null;
    const id = parseInt(rawFocus, 10);
    if (isNaN(id)) return null;
    return board.swimlanes.some((s) => s.id === id) ? id : null;
  })();
  const focusedSwimlane = focusedSwimlaneId !== null ? board.swimlanes.find((s) => s.id === focusedSwimlaneId) ?? null : null;

  // Snapshot of collapsed swimlane and column IDs at the moment focus is entered —
  // restored on exit. Stored in refs so they don't trigger re-renders.
  const preFocusCollapsedSwimlaneIds = useRef<number[] | null>(null);
  const preFocusCollapsedColumnIds = useRef<number[] | null>(null);

  const enterFocus = useCallback((swimlaneId: number) => {
    // Only snapshot on the first focus entry — switching focus to a different
    // swimlane while already focused must not overwrite the original snapshot,
    // otherwise exitFocus restores the wrong (already-focused) state.
    if (preFocusCollapsedSwimlaneIds.current === null) {
      preFocusCollapsedSwimlaneIds.current = viewPrefs.collapsedSwimlaneIds.slice();
      preFocusCollapsedColumnIds.current = viewPrefs.collapsedColumnIds.slice();
    }
    // Collapse all swimlanes except the focused one so they disappear from DOM.
    collapseAllSwimlanes(board.swimlanes.filter((s) => s.id !== swimlaneId).map((s) => s.id));
    // Expand all columns so the focused swimlane shows full card content.
    expandAllColumns();
    setSearchParams((prev) => { prev.set("focus", String(swimlaneId)); return prev; });
  }, [board.swimlanes, collapseAllSwimlanes, expandAllColumns, viewPrefs.collapsedSwimlaneIds, viewPrefs.collapsedColumnIds, setSearchParams]);

  const exitFocus = useCallback(() => {
    // Restore the pre-focus collapse state if we have a snapshot.
    if (preFocusCollapsedSwimlaneIds.current !== null) {
      collapseAllSwimlanes(preFocusCollapsedSwimlaneIds.current);
      preFocusCollapsedSwimlaneIds.current = null;
    }
    if (preFocusCollapsedColumnIds.current !== null) {
      collapseAllColumns(preFocusCollapsedColumnIds.current);
      preFocusCollapsedColumnIds.current = null;
    }
    setSearchParams((prev) => { prev.delete("focus"); return prev; });
  }, [collapseAllSwimlanes, collapseAllColumns, setSearchParams]);

  // Keep a stable ref to exitFocus so the deletion-detection effect below always calls the
  // latest version of exitFocus without needing to re-run the effect when exitFocus changes.
  const exitFocusRef = useRef<() => void>(exitFocus);
  exitFocusRef.current = exitFocus;

  // When a focused swimlane is deleted via WebSocket, board.swimlanes no longer contains it, so
  // focusedSwimlaneId resolves to null. This effect detects that transition and exits focus cleanly.
  const prevFocusedSwimlaneIdRef = useRef<number | null>(null);
  useEffect(() => {
    const prev = prevFocusedSwimlaneIdRef.current;
    prevFocusedSwimlaneIdRef.current = focusedSwimlaneId;
    if (prev !== null && focusedSwimlaneId === null) {
      exitFocusRef.current();
    }
  }, [focusedSwimlaneId]);

  // Auto-open card from ?card= query param (e.g. from notification deep-link).
  // When the card is not in the active board view, call the /status/ endpoint to
  // distinguish "archived" (show targeted message) from "deleted/missing" (generic).
  useEffect(() => {
    const cardId = Number(searchParams.get("card"));
    if (!cardId) return;
    const card = board.cards.find((c) => c.id === cardId);
    if (card) {
      setSelectedCard(card);
      setHighlightedCardId(cardId);
      setTimeout(() => setHighlightedCardId(null), 1500);
      setSearchParams((prev) => { prev.delete("card"); return prev; }, { replace: true });
    } else {
      setSearchParams((prev) => { prev.delete("card"); return prev; }, { replace: true });
      // Check whether the card is archived so we can show a contextual message.
      getCardStatus(board.id, cardId).then((status) => {
        const msg = status?.archived
          ? "This card has been archived."
          : "Card not found — it may have been deleted.";
        setCardNotFound(msg);
        setTimeout(() => setCardNotFound(null), 4000);
      });
    }
  }, [board.cards, board.id, searchParams, setSearchParams]);
  const [showAddColumn, setShowAddColumn] = useState(false);
  // When non-null, new column is inserted at this index (0 = first)
  const [insertPosition, setInsertPosition] = useState<number | null>(null);
  const [showAddSwimlane, setShowAddSwimlane] = useState(false);
  // When non-null, new swimlane is inserted at this index (0 = first)
  const [insertSwimlanePosition, setInsertSwimlanePosition] = useState<number | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const { filters: persistedFilters, setFilters: setPersistedFilters } = usePersistedFilters(board.id);

  // Parse filter state from URL params on mount; URL params override localStorage when present.
  const initialFilters = useMemo<typeof persistedFilters>(() => {
    const fAssignees = searchParams.get("f_assignees");
    const fLabels = searchParams.get("f_labels");
    const fPriorities = searchParams.get("f_priorities");
    const fDue = searchParams.get("f_due");
    const fSearch = searchParams.get("f_search");
    const hasUrlFilters = fAssignees !== null || fLabels !== null || fPriorities !== null || fDue !== null || fSearch !== null;
    if (!hasUrlFilters) return persistedFilters;
    return {
      search: fSearch ?? "",
      assigneeIds: fAssignees ? fAssignees.split(",").map(Number).filter((n) => !isNaN(n)) : [],
      labelIds: fLabels ? fLabels.split(",").map(Number).filter((n) => !isNaN(n)) : [],
      priorities: fPriorities
        ? (fPriorities.split(",").filter((v) => ["low", "medium", "high", "urgent"].includes(v)) as typeof persistedFilters["priorities"])
        : [],
      dueDate: (["overdue", "today", "this_week", "none"] as const).includes(fDue as never)
        ? (fDue as typeof persistedFilters["dueDate"])
        : null,
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps -- only run on mount; searchParams and persistedFilters are stable on first render
  }, []);

  const [filters, setFiltersState] = useState(initialFilters);

  // Sync filter changes to both localStorage and URL params.
  const setFilters = useCallback((next: typeof filters) => {
    setPersistedFilters(next);
    setFiltersState(next);
    setSearchParams((prev) => {
      const isEmptyFilter =
        next.search === "" &&
        next.assigneeIds.length === 0 &&
        next.labelIds.length === 0 &&
        next.priorities.length === 0 &&
        next.dueDate === null;
      if (isEmptyFilter) {
        prev.delete("f_assignees");
        prev.delete("f_labels");
        prev.delete("f_priorities");
        prev.delete("f_due");
        prev.delete("f_search");
      } else {
        if (next.assigneeIds.length > 0) prev.set("f_assignees", next.assigneeIds.join(","));
        else prev.delete("f_assignees");
        if (next.labelIds.length > 0) prev.set("f_labels", next.labelIds.join(","));
        else prev.delete("f_labels");
        if (next.priorities.length > 0) prev.set("f_priorities", next.priorities.join(","));
        else prev.delete("f_priorities");
        if (next.dueDate !== null) prev.set("f_due", next.dueDate);
        else prev.delete("f_due");
        if (next.search !== "") prev.set("f_search", next.search);
        else prev.delete("f_search");
      }
      return prev;
    }, { replace: true });
  }, [setPersistedFilters, setSearchParams]);

  // #852 — search scope ("board" | "all"). URL-persisted via ?scope=all so the
  // selection is link-shareable; absent ⇒ default "board". Selecting "all"
  // opens the command palette (handled in FilterBar) until #191 ships a
  // dedicated global search popover.
  const [scope, setScopeState] = useState<"board" | "all">(() => {
    return searchParams.get("scope") === "all" ? "all" : "board";
  });
  const setScope = useCallback((next: "board" | "all") => {
    setScopeState(next);
    setSearchParams((prev) => {
      if (next === "all") prev.set("scope", "all");
      else prev.delete("scope");
      return prev;
    }, { replace: true });
  }, [setSearchParams]);

  const {
    savedFilters,
    loading: savedFiltersLoading,
    saveFilter,
    removeFilter,
    hydrateFilter,
  } = useSavedFilters(board.id);
  const [showFilters, setShowFilters] = useState(false);
  const filterBarFirstRef = useRef<HTMLButtonElement>(null);
  // Tracks which saved filter preset is currently active. Cleared to null whenever the
  // user edits any filter dimension manually — a manual edit means the preset no longer
  // represents the live filter state.
  const [activeFilterId, setActiveFilterId] = useState<number | null>(null);
  // Forwarded to SavedFiltersDropdown so the "+ Save current" pill in SavedFilterTabs can
  // programmatically open the dropdown's save flow without duplicating the save-form UI.
  const savedFiltersDropdownTriggerRef = useRef<HTMLButtonElement>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [activityFeed, setActivityFeed] = useState<ActivityEntry[]>([]);
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [showExport, setShowExport] = useState(false);
  // #843 — close the standalone export modal if a board.updated broadcast
  // raises the threshold above the user's role while they have the modal
  // open. Without this, a non-admin sees an Export button that silently
  // 403s when clicked.
  useEffect(() => {
    if (showExport && !canExport) setShowExport(false);
  }, [showExport, canExport]);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [exportSeen, markExportSeen] = useExportSeenPref();
  const [shortcutsSeen, markShortcutsSeen] = useShortcutsSeenPref();
  const [overflowSeen, markOverflowSeen] = useOverflowSeenPref();
  const [overflowOpen, setOverflowOpen] = useState(false);
  const isLargeViewport = useIsLargeViewport();
  // At sub-`lg` viewports the secondary toolbar controls (Layout, Archived,
  // Activity drawer, Settings, Export, Shortcuts) fold into the overflow
  // kebab menu. At `lg` the overflow is additive (it offers a second path to
  // Export / Shortcuts plus a home for Replay onboarding tour). The `sm`
  // horizontal-scroll behavior is carried by the scroll container's
  // `overflow-x-auto`, so no separate md/sm branch is needed here.
  const foldToolbarControls = !isLargeViewport;
  const [confirmDeleteColumn, setConfirmDeleteColumn] = useState<Column | null>(null);
  // Derive view from ?view= search param; any unrecognised value falls back to "board".
  // Using replace: true when switching tabs so the browser Back button skips tab transitions
  // and users can bookmark/share a specific sub-view URL.
  const VALID_VIEWS = ["board", "summary", "history", "analytics"] as const;
  const rawView = searchParams.get("view");
  const view: "board" | "summary" | "history" | "analytics" = (VALID_VIEWS as readonly string[]).includes(rawView ?? "") ? (rawView as "board" | "summary" | "history" | "analytics") : "board";
  const setView = (v: "board" | "summary" | "history" | "analytics") =>
    setSearchParams(
      (prev) => {
        prev.set("view", v);
        return prev;
      },
      { replace: true }
    );
  const [selectedCardIds, setSelectedCardIds] = useState<Set<number>>(new Set());
  const [hoveredSepIndex, setHoveredSepIndex] = useState<number | null>(null);
  const lastHoveredSwimlaneId = useRef<number | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [scrollEl, setScrollEl] = useState<HTMLDivElement | null>(null);
  useBoardPan(scrollEl);

  const showArchiveToast = useCallback(() => {
    setArchiveToast(true);
    if (archiveToastTimerRef.current) clearTimeout(archiveToastTimerRef.current);
    // Auto-dismiss after 5 seconds so the toast doesn't linger indefinitely.
    archiveToastTimerRef.current = setTimeout(() => setArchiveToast(false), 5000);
  }, []);

  // Clear the auto-dismiss timer on unmount to avoid a setState call on an
  // unmounted component if the user navigates away while the toast is visible.
  useEffect(() => {
    return () => {
      if (archiveToastTimerRef.current) clearTimeout(archiveToastTimerRef.current);
    };
  }, []);

  const toggleCardSelection = useCallback((cardId: number) => {
    setSelectedCardIds((prev) => {
      const next = new Set(prev);
      if (next.has(cardId)) next.delete(cardId);
      else next.add(cardId);
      return next;
    });
  }, []);

  const clearSelection = useCallback(() => setSelectedCardIds(new Set()), []);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // ⌘\ / Ctrl+\ — toggle activity drawer (fires even from input fields)
      if ((e.metaKey || e.ctrlKey) && e.key === "\\") {
        e.preventDefault();
        setDrawerOpen((v) => !v);
        return;
      }
      // ⌘K / Ctrl+K — toggle command palette (fires even from input fields)
      if ((e.metaKey || e.ctrlKey) && (e.key === "k" || e.key === "K")) {
        e.preventDefault();
        setPaletteOpen((v) => !v);
        return;
      }
      const tag = (e.target as HTMLElement).tagName;
      if (
        tag === "INPUT" ||
        tag === "TEXTAREA" ||
        tag === "SELECT" ||
        (e.target as HTMLElement).closest?.('[contenteditable="true"]')
      ) return;
      // ⌘⇧E / Ctrl+Shift+E — open export modal (only when export is permitted)
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === "e" || e.key === "E")) {
        if (!canExport) return;
        e.preventDefault();
        markExportSeen();
        setShowExport(true);
        return;
      }
      // ⌘, / Ctrl+, — open board settings (admins only)
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key === ",") {
        if (!isAdmin) return;
        e.preventDefault();
        setShowSettings(true);
        return;
      }
      if (e.key === "f") {
        e.preventDefault();
        setShowFilters((v) => {
          if (!v) {
            // Opening: focus first interactive element in the filter bar
            setTimeout(() => filterBarFirstRef.current?.focus(), 0);
          }
          return !v;
        });
      } else if (e.key === "c") {
        e.preventDefault();
        const id = lastHoveredSwimlaneId.current;
        if (id !== null) toggleCollapsedSwimlane(id);
      } else if (e.key === "/") {
        e.preventDefault();
        setShowFilters(true);
        setTimeout(() => searchRef.current?.focus(), 0);
      } else if (e.key === "?") {
        e.preventDefault();
        setShowShortcuts((v) => !v);
      } else if (e.key === ".") {
        // Bare `.` — open the overflow menu. Guarded by the input-tag check
        // above so a period typed into a text field does not fire.
        e.preventDefault();
        setOverflowOpen((v) => !v);
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [toggleCollapsedSwimlane, canExport, markExportSeen, isAdmin]);

  // Surface the shortcuts overlay from the Navbar's user menu (route-agnostic dispatch).
  useEffect(() => {
    const open = () => setShowShortcuts(true);
    window.addEventListener("visiban:open-shortcuts", open);
    return () => window.removeEventListener("visiban:open-shortcuts", open);
  }, []);

  // Replay the onboarding tour — best-effort reset on the server, then flip
  // the local user's has_completed_tour flag so the tour re-arms. Shared by
  // the Shortcuts overlay "Restart tour" button and the overflow menu's
  // "Replay onboarding tour" item; both call sites need identical behavior.
  const replayTour = useCallback(async () => {
    if (!currentUser) return;
    try {
      await resetTour();
    } catch {
      // Best-effort — proceed even if the API call fails so the tour restarts locally.
    }
    if (onUserUpdated) {
      onUserUpdated({ ...currentUser, has_completed_tour: false });
    }
  }, [currentUser, onUserUpdated]);

  // Surface the command palette from the Row 1 global search trigger in Navbar
  // (#852). Until #191 ships a richer global search, the Row 1 button opens this
  // same board-scoped palette when a board is mounted.
  useEffect(() => {
    const open = () => setPaletteOpen(true);
    window.addEventListener("visiban:open-palette", open);
    return () => window.removeEventListener("visiban:open-palette", open);
  }, []);

  useEscapeStack(() => {
    if (view === "analytics" || view === "history" || view === "summary") { setView("board"); return; }
    return false;
  }, 15);

  // Priority 12 — above selection-clear (10), below view-toggle (15).
  useEscapeStack(() => {
    if (focusedSwimlaneId === null) return false;
    exitFocus();
  }, 12);

  useEscapeStack(() => {
    if (selectedCardIds.size === 0) return false;
    clearSelection();
  }, 10);

  // Prune selection when cards are removed (e.g. by another user via WebSocket)
  useEffect(() => {
    const cardIds = new Set(board.cards.map((c) => c.id));
    setSelectedCardIds((prev) => {
      const pruned = new Set([...prev].filter((id) => cardIds.has(id)));
      return pruned.size === prev.size ? prev : pruned;
    });
  }, [board.cards]);

  // Seed collapsed swimlane state from server defaults on first board load.
  // Only applies when localStorage has no stored preference for this board
  // (collapsedSwimlaneIds.size === 0) and the server has at least one swimlane
  // marked is_collapsed=true. Runs only when board.id changes to avoid
  // infinite loops — toggleCollapsedSwimlane writes to localStorage, which
  // triggers viewPrefs to update, but this effect is gated on board.id alone.
  useEffect(() => {
    if (collapsedSwimlaneIds.size > 0) return;
    const defaultCollapsed = board.swimlanes.filter((s) => s.is_collapsed).map((s) => s.id);
    if (defaultCollapsed.length > 0) {
      defaultCollapsed.forEach((id) => toggleCollapsedSwimlane(id));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [board.id]);

  // Server-side text search — debounced 300ms, aborts stale requests.
  // searchMatchIds is null when query is empty or on error (silent fallback → show all cards).
  const { searchMatchIds, isSearching } = useCardSearch(board.id, filters.search);

  // Search is handled server-side (useCardSearch → GET /api/boards/{id}/cards/?search=)
  // because it uses trigram indexes (migration 0030) for efficient title+description matching.
  // Assignee/label/priority/due-date filters run client-side against board.cards since all
  // cards are already loaded via the /full/ endpoint. The two results are intersected here.
  // Note: server search matches title+description only; client-side filterCards additionally
  // matches assignee name and label name — this is intentional (client has richer context).
  const filteredCardIds: Set<number> | null = (() => {
    const clientFiltersActive = (
      filters.assigneeIds.length > 0 ||
      filters.labelIds.length > 0 ||
      filters.priorities.length > 0 ||
      filters.dueDate !== null
    );

    if (!clientFiltersActive && searchMatchIds === null) return null;

    if (!clientFiltersActive && searchMatchIds !== null) {
      // Only server search is active — return its result directly as a Set.
      return searchMatchIds;
    }

    // Use the user's stored timezone so that "Today" / "Overdue" boundaries
    // are computed at midnight in their local time, not the browser's locale.
    const todayStr = todayInTimezone(userTimezone);

    // filterCards handles the server search intersection via its searchResults param.
    return new Set(filterCards(board.cards, filters, searchMatchIds ? [...searchMatchIds] : null, todayStr));
  })();

  const handleColumnAdded = useCallback((col: Column) => {
    onColumnAdded(col);
    if (insertPosition !== null) {
      const currentIds = board.columns.map((c) => c.id);
      const newOrder = [
        ...currentIds.slice(0, insertPosition),
        col.id,
        ...currentIds.slice(insertPosition),
      ];
      onColumnsReordered(newOrder);
    }
  }, [board.columns, insertPosition, onColumnAdded, onColumnsReordered]);

  const handleSwimlaneAdded = useCallback((swimlane: Swimlane) => {
    onSwimlaneAdded(swimlane);
    if (insertSwimlanePosition !== null) {
      // Filter the new swimlane's ID out of currentIds before splicing it in.
      // If the WS `swimlane.created` event fires before the API response,
      // board.swimlanes may already contain the new swimlane, which would
      // produce a duplicate in newOrder and corrupt the board state.
      const currentIds = board.swimlanes.filter((s) => s.id !== swimlane.id).map((s) => s.id);
      const newOrder = [
        ...currentIds.slice(0, insertSwimlanePosition),
        swimlane.id,
        ...currentIds.slice(insertSwimlanePosition),
      ];
      onSwimlanesReordered(newOrder);
    }
  }, [board.swimlanes, insertSwimlanePosition, onSwimlaneAdded, onSwimlanesReordered]);


  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  // Unique 3-char abbreviations for collapsed column headers.
  // Algorithm: strip spaces, take first 3 chars uppercased; if two columns share
  // the same base, suffix the later ones with a digit (e.g. "DON", "DO2").
  const columnAbbreviations = useCallback((): Map<number, string> => {
    const result = new Map<number, string>();
    const seen = new Map<string, number>();
    for (const col of board.columns) {
      const base = col.name.replace(/\s+/g, "").slice(0, 3).toUpperCase() || "COL";
      const n = (seen.get(base) ?? 0) + 1;
      seen.set(base, n);
      result.set(col.id, n === 1 ? base : `${base.slice(0, 2)}${n}`);
    }
    return result;
  }, [board.columns])();

  // Resizable swimlane name column
  const swimlaneColWidth = viewPrefs.swimlaneColumnWidth;

  const resizeState = useRef<{ startX: number; startWidth: number } | null>(null);

  // Resizable board columns
  const DEFAULT_COL_WIDTH = 220;
  const colWidths = useMemo(() => {
    const map = new Map<number, number>();
    for (const col of board.columns) {
      map.set(col.id, Math.max(160, viewPrefs.columnWidths[col.id] ?? DEFAULT_COL_WIDTH));
    }
    return map;
  }, [board.columns, viewPrefs.columnWidths]);

  // X position of the currently-hovered column separator within the scrollable area.
  // Layout: sidebar(W) | sep[0](16) | col[0](w0) | sep[1](16) | col[1](w1) | ...
  // sep[i] left = W + i*16 + sum(colWidth[j] for j in 0..i-1)
  const hoveredSepX = useMemo(() => {
    if (hoveredSepIndex === null) return null;
    let x = swimlaneColWidth;
    for (let i = 0; i < hoveredSepIndex; i++) {
      x += 16; // separator width
      if (i < board.columns.length) {
        const col = board.columns[i];
        x += (hiddenColumnIds.has(col.id) || collapsedColumnIds.has(col.id))
          ? 40
          : (colWidths.get(col.id) ?? DEFAULT_COL_WIDTH);
      }
    }
    return x;
  }, [hoveredSepIndex, swimlaneColWidth, board.columns, hiddenColumnIds, collapsedColumnIds, colWidths]);

  // Center X of each column within the scrollable area — used by RowSeparator to position "+" signs.
  // Layout: sidebar(W) | sep[0](16) | col[0](w0) | sep[1](16) | col[1](w1) | ...
  const colCenterXs = useMemo(() => {
    const result: number[] = [];
    let x = swimlaneColWidth + 16; // after sidebar + first sep
    for (const col of board.columns) {
      const w = (hiddenColumnIds.has(col.id) || collapsedColumnIds.has(col.id)) ? 40 : (colWidths.get(col.id) ?? DEFAULT_COL_WIDTH);
      result.push(x + w / 2);
      x += w + 16;
    }
    return result;
  }, [swimlaneColWidth, board.columns, hiddenColumnIds, collapsedColumnIds, colWidths]);

  const handleResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    resizeState.current = { startX: e.clientX, startWidth: swimlaneColWidth };
    const onMove = (ev: MouseEvent) => {
      if (!resizeState.current) return;
      const delta = ev.clientX - resizeState.current.startX;
      setSwimlaneColumnWidth(resizeState.current.startWidth + delta);
    };
    const onUp = () => {
      resizeState.current = null;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, [swimlaneColWidth, setSwimlaneColumnWidth]);

  // Custom collision detection: restrict candidates by the type of item being dragged
  // so that cell droppables don't steal hits from col: or swim: sortable targets.
  const collisionDetection = useCallback<CollisionDetection>((args) => {
    const activeId = String(args.active.id);
    if (activeId.startsWith("swim:")) {
      return closestCenter({
        ...args,
        droppableContainers: args.droppableContainers.filter((c) => String(c.id).startsWith("swim:")),
      });
    }
    if (activeId.startsWith("col:")) {
      return closestCenter({
        ...args,
        droppableContainers: args.droppableContainers.filter(
          (c) => String(c.id).startsWith("col:") || String(c.id).startsWith("cell:") || c.id === "trash:column"
        ),
      });
    }
    // Card drag — restrict to cell: drop zones; col: and swim: headers are not valid card targets
    return closestCenter({
      ...args,
      droppableContainers: args.droppableContainers.filter((c) => String(c.id).startsWith("cell:")),
    });
  }, []);

  const handleDragStart = (e: DragStartEvent) => {
    clearSelection();
    const id = String(e.active.id);
    if (id.startsWith("col:")) {
      const col = board.columns.find((c) => c.id === Number(id.slice(4))) ?? null;
      setActiveColumn(col);
      if (col) setDndAnnouncement(`Column '${col.name}' picked up`);
    } else if (id.startsWith("swim:")) {
      const swim = board.swimlanes.find((s) => s.id === Number(id.slice(5))) ?? null;
      setActiveSwimlane(swim);
      if (swim) setDndAnnouncement(`Swimlane '${swim.name}' picked up`);
    } else {
      const card = board.cards.find((c) => c.id === Number(id)) ?? null;
      setActiveCard(card);
      if (card) setDndAnnouncement(`Card '${card.title}' picked up`);
    }
  };

  const handleDragOver = (e: DragOverEvent) => {
    if (!e.over) return;
    const overId = String(e.over.id);
    if (!overId.startsWith("cell:")) return;
    if (dndHoverThrottleRef.current) return;
    dndHoverThrottleRef.current = setTimeout(() => {
      dndHoverThrottleRef.current = null;
    }, 300);
    const [, colId, swimId] = overId.split(":");
    const col = board.columns.find((c) => c.id === Number(colId));
    const swim = board.swimlanes.find((s) => s.id === Number(swimId));
    if (col && swim) {
      setDndAnnouncement(`Over column '${col.name}', swimlane '${swim.name}'`);
    }
  };

  const handleDragEnd = (e: DragEndEvent) => {
    const { over, active } = e;
    const activeId = String(active.id);

    if (activeId.startsWith("col:")) {
      const draggedColumn = activeColumn;
      setActiveColumn(null);
      if (!over) return;
      const overId = String(over.id);

      // Dropped on trash zone — confirm before deleting
      if (overId === "trash:column" && draggedColumn) {
        setConfirmDeleteColumn(draggedColumn);
        return;
      }

      // Cells cover a larger area than column headers, so closestCenter may
      // resolve to "cell:{colId}:{swimlaneId}" — map back to the column id.
      let mappedOverId = overId;
      if (mappedOverId.startsWith("cell:")) {
        mappedOverId = `col:${mappedOverId.split(":")[1]}`;
      }
      if (activeId === mappedOverId) return;
      const oldIndex = board.columns.findIndex((c) => `col:${c.id}` === activeId);
      const newIndex = board.columns.findIndex((c) => `col:${c.id}` === mappedOverId);
      if (oldIndex === -1 || newIndex === -1) return;
      const reordered = arrayMove(board.columns, oldIndex, newIndex);
      onColumnsReordered(reordered.map((c) => c.id));
      return;
    }

    if (activeId.startsWith("swim:")) {
      setActiveSwimlane(null);
      if (!over) return;
      const overId = String(over.id);

      // Cells cover a larger area than swimlane sidebars, so closestCenter may
      // resolve to "cell:{colId}:{swimlaneId}" — map back to the swimlane id.
      let mappedOverId = overId;
      if (mappedOverId.startsWith("cell:")) {
        mappedOverId = `swim:${mappedOverId.split(":")[2]}`;
      }

      if (!mappedOverId.startsWith("swim:")) return;
      if (activeId === mappedOverId) return;
      const oldIndex = board.swimlanes.findIndex((s) => `swim:${s.id}` === activeId);
      const newIndex = board.swimlanes.findIndex((s) => `swim:${s.id}` === overId);
      if (oldIndex === -1 || newIndex === -1) return;
      const reordered = arrayMove(board.swimlanes, oldIndex, newIndex);
      onSwimlanesReordered(reordered.map((s) => s.id));
      return;
    }

    setActiveCard(null);
    if (!over) {
      setDndAnnouncement("Move canceled, card returned to original position");
      return;
    }
    // Guard: card drops must land on a cell: zone. col:/swim: zones are not valid targets for cards.
    // Without this, over.id like "col:3" causes swimId = undefined → NaN → null → backend 404.
    if (!String(over.id).startsWith("cell:")) {
      setDndAnnouncement("Move canceled, card returned to original position");
      return;
    }
    const [, colId, swimId] = String(over.id).split(":");
    const cardId = Number(activeId);
    const card = board.cards.find((c) => c.id === cardId);
    if (!card) return;

    const targetColumnId = Number(colId);
    const targetSwimlaneId = Number(swimId);
    const targetCol = board.columns.find((c) => c.id === targetColumnId);
    const targetSwim = board.swimlanes.find((s) => s.id === targetSwimlaneId);
    if (targetCol && targetSwim) {
      setDndAnnouncement(`Card '${card.title}' moved to column '${targetCol.name}', swimlane '${targetSwim.name}'`);
    }

    const siblings = board.cards
      .filter((c) => c.column === targetColumnId && c.swimlane === targetSwimlaneId && c.id !== cardId)
      .sort((a, b) => a.position - b.position);

    onMoveCard(cardId, targetColumnId, targetSwimlaneId, siblings.length);
  };

  const activeCount = countActiveFilters(filters);

  const hiddenCount = filteredCardIds !== null
    ? board.cards.filter((c) => !c.archived_at).length - filteredCardIds.size
    : 0;

  // Overflow menu items are computed unconditionally — the memo must sit above
  // the early-return branches for summary/history/analytics views so the hook
  // order stays stable across re-renders.
  const overflowItems: OverflowItem[] = useMemo(() => {
    const items: OverflowItem[] = [];

    // Section 1 — folded Row 2 view controls (only at md and sm)
    if (foldToolbarControls) {
      items.push({
        id: "layout",
        label: cardLayout === "compact" ? "Layout: Compact" : "Layout: Expanded",
        icon: cardLayout === "compact" ? LayoutCompactIcon : LayoutExpandedIcon,
        onSelect: () => setCardLayout(cardLayout === "compact" ? "expanded" : "compact"),
      });
      items.push({
        id: "archived",
        label: showArchived ? "Hide archived cards" : "Show archived cards",
        icon: ArchivedIcon,
        onSelect: () => setShowArchived((v) => !v),
      });
      items.push({
        id: "drawer",
        label: drawerOpen ? "Close activity drawer" : "Open activity drawer",
        icon: ActivityDrawerIcon,
        shortcut: formatShortcut({ mod: true, key: "\\" }),
        onSelect: () => setDrawerOpen((v) => !v),
      });
      if (isAdmin) {
        items.push({
          id: "settings",
          label: "Board settings",
          icon: SettingsIcon,
          shortcut: formatShortcut({ mod: true, key: "," }),
          onSelect: () => setShowSettings(true),
        });
      }
    }

    // Section 2 — board tools (always available at every breakpoint)
    const section2Separator = foldToolbarControls;
    let section2First = true;
    if (canExport) {
      items.push({
        id: "export",
        label: "Export board",
        icon: ExportIcon,
        shortcut: formatShortcut({ mod: true, shift: true, key: "E" }),
        onSelect: () => {
          markExportSeen();
          setShowExport(true);
        },
        separatorBefore: section2Separator && section2First,
      });
      section2First = false;
    }
    items.push({
      id: "shortcuts",
      label: "Keyboard shortcuts",
      icon: ShortcutsIcon,
      shortcut: "?",
      onSelect: () => {
        markShortcutsSeen();
        setShowShortcuts(true);
      },
      separatorBefore: section2Separator && section2First,
    });

    // Section 3 — help (only when a user is signed in and can reset the tour)
    if (currentUser) {
      items.push({
        id: "tour",
        label: "Replay onboarding tour",
        icon: ReplayTourIcon,
        onSelect: () => {
          void replayTour();
        },
        separatorBefore: true,
      });
    }

    return items;
  }, [
    foldToolbarControls,
    cardLayout,
    setCardLayout,
    showArchived,
    drawerOpen,
    isAdmin,
    canExport,
    markExportSeen,
    markShortcutsSeen,
    currentUser,
    replayTour,
  ]);

  if (view === "summary") {
    return (
      <div className="flex-1 flex flex-col min-h-0">
        <div className="flex items-center gap-2 px-3 py-1.5 bg-surface border-b border-line shrink-0">
          <ViewToggle view={view} onChange={setView} />
        </div>
        <SectionErrorBoundary section="Summary">
          <SummaryView boardId={board.id} columns={board.columns.map((c) => c.name)} />
        </SectionErrorBoundary>
      </div>
    );
  }

  if (view === "history") {
    return (
      <div className="flex-1 flex flex-col min-h-0">
        <div className="flex items-center gap-2 px-3 py-1.5 bg-surface border-b border-line shrink-0">
          <ViewToggle view={view} onChange={setView} />
        </div>
        <SectionErrorBoundary section="Movement history">
          <MovementHistoryView board={board} currentUser={currentUser} />
        </SectionErrorBoundary>
      </div>
    );
  }

  if (view === "analytics") {
    return (
      <div className="flex-1 flex flex-col min-h-0">
        <div className="flex items-center gap-2 px-3 py-1.5 bg-surface border-b border-line shrink-0">
          <ViewToggle view={view} onChange={setView} />
        </div>
        <SectionErrorBoundary section="Analytics">
          <AnalyticsView
            boardId={board.id}
            currentUserRole={board.current_user_role}
            onOpenCard={(cardId) => {
              const card = board.cards.find((c) => c.id === cardId);
              if (card) { clearSelection(); setSelectedCard(card); }
            }}
          />
        </SectionErrorBoundary>
        {selectedCard && (
          <CardDetail
            card={selectedCard}
            board={board}
            onClose={() => setSelectedCard(null)}
            onDeleted={(id) => { onCardDeleted(id); setSelectedCard(null); }}
            onUpdated={onCardUpdated}
            onArchived={(id) => { onCardArchived(id); setSelectedCard(null); showArchiveToast(); }}
            onMoveCard={async (cardId, columnId, swimlaneId, position) => onMoveCard(cardId, columnId, swimlaneId, position)}
            userDateFormat={userDateFormat}
            userTimeFormat={userTimeFormat}
            userTimezone={userTimezone}
            currentUser={currentUser}
            closeEditorOnEnter={closeEditorOnEnter}
          />
        )}
      </div>
    );
  }

  // Primary click on the Collapse split button performs the dominant action —
  // if anything is expanded, collapse all; otherwise, expand all. Preserves
  // the 1.0 single-button behavior so muscle memory is not disturbed.
  const onCollapsePrimary = () => {
    if (focusedSwimlaneId !== null) exitFocus();
    if (allExpanded) {
      collapseAllColumns(board.columns.map((c) => c.id));
      collapseAllSwimlanes(board.swimlanes.map((s) => s.id));
    } else {
      expandAllColumns();
      expandAllSwimlanes();
    }
  };
  const onHideAllSwimlanes = () => {
    if (focusedSwimlaneId !== null) exitFocus();
    collapseAllSwimlanes(board.swimlanes.map((s) => s.id));
  };
  const onHideAllColumns = () => {
    if (focusedSwimlaneId !== null) exitFocus();
    collapseAllColumns(board.columns.map((c) => c.id));
  };
  const onHideEverything = () => {
    if (focusedSwimlaneId !== null) exitFocus();
    collapseAllColumns(board.columns.map((c) => c.id));
    collapseAllSwimlanes(board.swimlanes.map((s) => s.id));
  };
  const onShowAllSwimlanes = () => expandAllSwimlanes();
  const onShowAllColumns = () => expandAllColumns();
  const onShowEverything = () => {
    expandAllColumns();
    expandAllSwimlanes();
  };

  return (
    <>
      {/* Primary toolbar row — scrollable region + pinned trailing cluster.
          At sub-`lg` viewports (md/sm) the secondary controls fold into the
          overflow kebab; at `lg` the overflow is additive. The trailing
          cluster (overflow + ConnectionStatus) sits outside the scrollable
          region so `⋮` stays visible when the scroll strip overflows at `sm`. */}
      <nav aria-label="Board toolbar" className="h-10 shrink-0 bg-surface border-b border-line flex items-center">
      <div className="flex-1 min-w-0 overflow-x-auto h-full flex items-center pl-3">
      <div data-testid="board-toolbar" className="flex items-center gap-2 h-full min-w-max">
        {/* Zone 1: View navigation */}
        <div data-tour-step="view-tabs">
          <ViewToggle view={view} onChange={setView} />
        </div>

        {/* Divider 1 */}
        <div className="w-px h-4 bg-surface-hover mx-1" aria-hidden="true" />

        {/* Zone 2: Board controls */}
        <div className="flex items-center gap-1">
          <SplitButton
            primaryLabel={allExpanded ? "Collapse" : "Expand"}
            primaryAriaLabel={allExpanded ? "Hide all swimlanes and columns" : "Show all swimlanes and columns"}
            primaryTitle={allExpanded ? "Hide all swimlanes and columns" : "Show all swimlanes and columns"}
            menuAriaLabel="Collapse menu"
            onPrimary={onCollapsePrimary}
            renderMenu={({ close }) => {
              // Menu items are disabled when the action would be a no-op — e.g.
              // "Hide all swimlanes" is disabled once every swimlane is already
              // collapsed. This teaches the mental model without removing
              // entries; the menu shape is stable regardless of current state.
              const allSwimlanesCollapsed = board.swimlanes.length > 0 && collapsedSwimlaneIds.size >= board.swimlanes.length;
              const allColumnsCollapsed = board.columns.length > 0 && collapsedColumnIds.size >= board.columns.length;
              const renderItem = (
                label: string,
                onClick: () => void,
                disabled: boolean,
              ) => (
                <button
                  type="button"
                  role="menuitem"
                  disabled={disabled}
                  onClick={() => {
                    if (disabled) return;
                    onClick();
                    close();
                  }}
                  className="w-full text-left px-3 py-1.5 text-sm text-fg-secondary hover:bg-surface-hover focus:bg-surface-hover focus:outline-none transition disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  {label}
                </button>
              );
              return (
                <>
                  {renderItem("Hide all swimlanes", onHideAllSwimlanes, allSwimlanesCollapsed)}
                  {renderItem("Hide all columns", onHideAllColumns, allColumnsCollapsed)}
                  {renderItem("Hide everything", onHideEverything, allSwimlanesCollapsed && allColumnsCollapsed)}
                  <div role="separator" className="mx-4 my-1">
                    <div className="h-px bg-sunken" />
                    <div className="h-px bg-surface-active/50" />
                  </div>
                  {renderItem("Show all swimlanes", onShowAllSwimlanes, allSwimlanesExpanded)}
                  {renderItem("Show all columns", onShowAllColumns, allColumnsExpanded)}
                  {renderItem("Show everything", onShowEverything, allExpanded)}
                </>
              );
            }}
          />
          <Tooltip content={showFilters ? "Hide filters (F)" : "Filters (F)"}>
            <button
              data-tour-step="filter"
              onClick={() => setShowFilters((v) => !v)}
              className={`text-xs px-2 py-1 rounded transition shrink-0 focus:outline-none focus:ring-2 focus:ring-primary-emphasis ${showFilters ? "text-info bg-info/10" : "text-fg-secondary hover:text-fg hover:bg-surface-hover"}`}
              aria-pressed={showFilters || activeCount > 0}
              aria-label={activeCount > 0 ? `Filters, ${activeCount} active` : "Filters"}
            >
              {showFilters ? "Hide filters" : "Filters"}
              {!showFilters && activeCount > 0 && (
                <span className="ml-1.5 bg-info/20 text-info rounded-full px-1.5 py-0.5 font-medium">
                  {activeCount}
                </span>
              )}
            </button>
          </Tooltip>
          {!foldToolbarControls && (
          <Tooltip content={cardLayout === "compact" ? "Switch to expanded card layout" : "Switch to compact card layout"}>
            <button
              onClick={() => setCardLayout(cardLayout === "compact" ? "expanded" : "compact")}
              aria-pressed={cardLayout === "compact"}
              aria-label={cardLayout === "compact" ? "Switch to expanded card layout" : "Switch to compact card layout"}
              className={`p-1.5 rounded transition shrink-0 focus:outline-none focus:ring-2 focus:ring-primary-emphasis ${
                cardLayout === "compact"
                  ? "text-info bg-info/10"
                  : "text-fg-secondary hover:text-fg hover:bg-surface-hover"
              }`}
            >
              {cardLayout === "compact" ? LayoutCompactIcon : LayoutExpandedIcon}
            </button>
          </Tooltip>
          )}
          {!foldToolbarControls && (
          <button
            onClick={() => setShowArchived((v) => !v)}
            className={`text-xs px-2 py-1 rounded transition shrink-0 focus:outline-none focus:ring-2 focus:ring-primary-emphasis ${showArchived ? "text-warning bg-warning/10" : "text-fg-secondary hover:text-fg hover:bg-surface-hover"}`}
            aria-pressed={showArchived}
            aria-label={showArchived ? "Hide archived cards" : "Show archived cards"}
          >
            Archived
          </button>
          )}
        </div>

        {/* Spacer */}
        <div className="flex-1" />

        {!foldToolbarControls && (
        <>
        {/* Divider 2 */}
        <div className="w-px h-4 bg-surface-hover mx-1" aria-hidden="true" />

        {/* Zone 3: Utilities (direct at lg; folded into overflow at md/sm) */}
        <div className="flex items-center gap-1">
          <Tooltip content={`${drawerOpen ? "Close activity drawer" : "Open activity drawer"} (${formatShortcut({ mod: true, key: "\\" })})`}>
            <button
              onClick={() => setDrawerOpen((v) => !v)}
              aria-pressed={drawerOpen}
              aria-label={drawerOpen ? "Close activity drawer" : "Open activity drawer"}
              className={`p-1.5 rounded transition shrink-0 focus:outline-none focus:ring-2 focus:ring-primary-emphasis ${
                drawerOpen ? "text-info bg-info/10" : "text-fg-tertiary hover:text-fg hover:bg-surface-hover"
              }`}
            >
              {ActivityDrawerIcon}
            </button>
          </Tooltip>
          <Tooltip content="Keyboard shortcuts (?)">
            <button
              onClick={() => { markShortcutsSeen(); setShowShortcuts((v) => !v); }}
              className="relative p-1.5 rounded text-fg-tertiary hover:text-fg hover:bg-surface-hover transition shrink-0 focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
              aria-label={showShortcuts ? "Close keyboard shortcuts" : "Keyboard shortcuts"}
              aria-pressed={showShortcuts}
            >
              {ShortcutsIcon}
              {!shortcutsSeen && (
                <span className="absolute top-0 right-0 w-2 h-2 bg-primary-emphasis rounded-full pointer-events-none" aria-hidden="true" />
              )}
            </button>
          </Tooltip>
          {canExport && (
          <Tooltip content={`Export board (${formatShortcut({ mod: true, shift: true, key: "E" })})`}>
            <button
              onClick={() => { markExportSeen(); setShowExport(true); }}
              className="relative p-1.5 rounded text-fg-tertiary hover:text-fg hover:bg-surface-hover transition shrink-0 focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
              aria-label="Export board"
            >
              {ExportIcon}
              {!exportSeen && (
                <span className="absolute top-0 right-0 w-2 h-2 bg-primary-emphasis rounded-full pointer-events-none" aria-hidden="true" />
              )}
            </button>
          </Tooltip>
          )}
          {isAdmin && (
            <Tooltip content={`Board settings (${formatShortcut({ mod: true, key: "," })})`}>
              <button
                onClick={() => setShowSettings(true)}
                className="p-1.5 rounded text-fg-tertiary hover:text-fg hover:bg-surface-hover transition shrink-0 focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
                aria-label="Board settings"
              >
                {SettingsIcon}
              </button>
            </Tooltip>
          )}
        </div>
        </>
        )}
      </div>
      </div>
      {/* Pinned trailing cluster — overflow kebab + connection status.
          Lives outside the scrollable region so `⋮` stays visible at `sm`
          when the inner strip overflows horizontally. */}
      <div className="flex items-center gap-1 shrink-0 h-full px-2 border-l border-line bg-surface">
        <OverflowMenu
          items={overflowItems}
          showDot={!overflowSeen}
          onDismissDot={markOverflowSeen}
          externalOpen={overflowOpen}
          onExternalOpenChange={setOverflowOpen}
        />
        <ConnectionStatus
          status={socketStatus}
          lastEventAt={socketLastEventAt}
          reconnectAttempt={socketReconnectAttempt}
          onRefresh={silentReload}
          tourStep="live-indicator"
        />
      </div>
      </nav>

      {/* Filter row — own row so it doesn't compress the toolbar */}
      {showFilters && (
        <>
          {/* Preset tab pills — one-click load of saved filters, above the chip row */}
          {savedFilters.length > 0 && (
            <div className="px-3 pt-1.5 bg-surface border-t border-line shrink-0">
              <SavedFilterTabs
                savedFilters={savedFilters}
                activeFilterId={activeFilterId}
                onLoad={(saved) => {
                  setFilters(hydrateFilter(saved));
                  setActiveFilterId(saved.id);
                }}
                onClearAll={() => {
                  setFilters(EMPTY_FILTER);
                  setActiveFilterId(null);
                }}
                onSaveCurrentClick={() => {
                  // Delegate to the existing SavedFiltersDropdown save flow by clicking
                  // its trigger button programmatically — avoids duplicating the save-form UI.
                  savedFiltersDropdownTriggerRef.current?.click();
                }}
                hasActiveFilters={activeCount > 0}
              />
            </div>
          )}
          <div role="search" aria-label="Card filters" className="px-3 py-1.5 bg-surface border-b border-line shrink-0 flex items-center gap-2 flex-wrap">
            <SavedFiltersDropdown
              boardId={board.id}
              filters={filters}
              savedFilters={savedFilters}
              loading={savedFiltersLoading}
              onLoad={(sf) => {
                setFilters(hydrateFilter(sf));
                setActiveFilterId(sf.id);
              }}
              onSave={(name) => saveFilter(name, filters)}
              onDelete={removeFilter}
              firstElementRef={(el) => { filterBarFirstRef.current = el; }}
              externalTriggerRef={(el) => { (savedFiltersDropdownTriggerRef as React.MutableRefObject<HTMLButtonElement | null>).current = el; }}
            />
            <FilterBar
              board={board}
              filters={filters}
              onChange={(next) => {
                // Any manual edit means the active preset no longer matches live state.
                setActiveFilterId(null);
                setFilters(next);
              }}
              searchRef={searchRef}
              isSearching={isSearching}
              currentUser={currentUser}
              hiddenCount={hiddenCount}
              scope={scope}
              onScopeChange={setScope}
            />
          </div>
        </>
      )}
      {filteredCardIds !== null && filteredCardIds.size === 0 && (
        <div className="mx-4 mt-2 px-4 py-2 bg-surface border border-line rounded-lg text-fg-tertiary text-sm">
          No cards match the active filters.
        </div>
      )}
      {cardNotFound !== null && (
        <div className="mx-4 mt-2 px-4 py-2 bg-warning/50 border border-warning/60 rounded-lg text-warning text-sm">
          {cardNotFound}
        </div>
      )}
      {archiveToast && (
        <div className="flex items-center justify-between gap-3 mx-4 mt-2 px-4 py-2 bg-surface-hover/80 border border-line-strong rounded-lg text-fg text-sm">
          <span>Card archived — view in <button onClick={() => { setShowArchived(true); setArchiveToast(false); }} className="text-info hover:underline">Archived panel</button></span>
          <button onClick={() => setArchiveToast(false)} className="text-fg-tertiary hover:text-fg transition text-lg leading-none shrink-0">×</button>
        </div>
      )}

      {/* Collapsed swimlanes strip — shows count and "Expand all swimlanes" button */}
      {view === "board" && collapsedSwimlaneIds.size > 0 && (
        <div className="bg-info/15 border-b border-primary-emphasis/40 px-4 py-1.5 flex items-center gap-3 text-sm text-info shrink-0">
          <svg className="w-3.5 h-3.5 text-info shrink-0" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
            <line x1="2" y1="5" x2="14" y2="5" />
            <line x1="2" y1="11" x2="14" y2="11" />
            <polyline points="10,2 13,5 10,8" />
          </svg>
          <span>
            <span className="font-medium text-info">{collapsedSwimlaneIds.size}</span>
            {" "}
            {collapsedSwimlaneIds.size === 1 ? "swimlane" : "swimlanes"} collapsed
          </span>
          <div className="flex-1" />
          <button
            onClick={expandAllSwimlanes}
            className="text-fg-secondary hover:text-fg hover:bg-surface-hover px-2 py-1 rounded text-xs shrink-0 focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
          >
            Expand all swimlanes
          </button>
        </div>
      )}

      {/* Focus mode banner — sits outside the scroll container so it does not scroll away */}
      {focusedSwimlaneId !== null && (
        <div className="bg-info/15 border-b border-primary-emphasis/40 px-4 py-2 flex items-center gap-3 text-sm text-info transition-opacity duration-150">
          <svg className="w-3.5 h-3.5 text-info shrink-0" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
            <circle cx="8" cy="8" r="3" />
            <line x1="8" y1="1" x2="8" y2="4" />
            <line x1="8" y1="12" x2="8" y2="15" />
            <line x1="1" y1="8" x2="4" y2="8" />
            <line x1="12" y1="8" x2="15" y2="8" />
          </svg>
          <span className="text-info">Focused on:</span>
          <span className="font-medium text-info truncate max-w-[24rem]">{focusedSwimlane?.name}</span>
          <div className="flex-1" />
          <button onClick={exitFocus} className="text-fg-secondary hover:text-fg hover:bg-surface-hover px-2 py-1 rounded text-xs shrink-0 focus:outline-none focus:ring-2 focus:ring-primary-emphasis">
            Exit focus
          </button>
        </div>
      )}

      <div role="status" aria-live="polite" aria-atomic="true" className="sr-only">{dndAnnouncement}</div>

      <SectionErrorBoundary section="Board grid">
      <DndContext sensors={sensors} onDragStart={handleDragStart} onDragOver={handleDragOver} onDragEnd={handleDragEnd} collisionDetection={collisionDetection}>
        {/* flex-row wrapper lets the activity drawer sit alongside the scroll container */}
        <div className="flex flex-row flex-1 min-h-0 overflow-hidden">
        {/*
          Single scroll container — header and body share the same horizontal
          scroll so fixed-width columns always line up.
        */}
        <div ref={setScrollEl} className="board-scroll flex-1 overflow-auto bg-sunken">
          {/*
            min-w-max wrapper — gives the sticky header row and all swimlane
            rows the same containing-block width (max-content).  Without this,
            a sticky element may be sized to the scroll-container's layout
            width rather than the full scrollable content width, so its flex-1
            columns become narrower than the corresponding cells below.
          */}
          <div className="min-w-max">
          {/* Header row — sticky to the top of the scroll container */}
          <div className="flex sticky top-0 z-20 border-b border-line bg-surface">
            {/* Corner — sticky to the left; shows board density at a glance */}
            <div className="shrink-0 bg-surface flex flex-col items-center justify-center gap-0.5 sticky left-0 z-30 px-2" style={{ width: swimlaneColWidth }}>
              <span className="text-[10px] text-fg-muted font-medium tabular-nums">
                {board.columns.length} col{board.columns.length !== 1 ? "s" : ""}
              </span>
              <span className="text-[10px] text-fg-muted font-medium tabular-nums">
                {board.swimlanes.length} lane{board.swimlanes.length !== 1 ? "s" : ""}
              </span>
              <span className="text-[10px] text-fg-faint tabular-nums">
                {board.cards.length} card{board.cards.length !== 1 ? "s" : ""}
              </span>
            </div>

            {/* Far-left separator: drag resizes the swimlane sidebar; click inserts column at pos 0 */}
            <ColumnSeparator
              isAdmin={isAdmin}
              onOpenAdd={() => { setInsertPosition(0); setShowAddColumn(true); }}
              currentWidth={swimlaneColWidth}
              setWidth={setSwimlaneColumnWidth}
              sepIndex={0}
              hoveredSepIndex={hoveredSepIndex}
              onSepHoverChange={setHoveredSepIndex}
            />

            <SortableContext items={board.columns.map((c) => `col:${c.id}`)} strategy={horizontalListSortingStrategy}>
              {board.columns.map((col, idx) => (
                <React.Fragment key={col.id}>
                  <ColumnHeader
                    column={col}
                    cards={board.cards.filter((c) => c.column === col.id)}
                    boardId={board.id}
                    isAdmin={isAdmin}
                    onColumnUpdated={onColumnUpdated}
                    onRequestDelete={(col) => setConfirmDeleteColumn(col)}
                    collapsed={collapsedColumnIds.has(col.id)}
                    hidden={hiddenColumnIds.has(col.id)}
                    abbreviation={columnAbbreviations.get(col.id)}
                    width={colWidths.get(col.id) ?? DEFAULT_COL_WIDTH}
                    onToggleCollapse={() => toggleCollapsedColumn(col.id)}
                    hardWipEnforced={board.enforce_wip_hard}
                  />
                  <ColumnSeparator
                    isAdmin={isAdmin}
                    onOpenAdd={() => { setInsertPosition(idx + 1); setShowAddColumn(true); }}
                    currentWidth={colWidths.get(col.id) ?? DEFAULT_COL_WIDTH}
                    setWidth={(w) => setColumnWidth(col.id, w)}
                    sepIndex={idx + 1}
                    hoveredSepIndex={hoveredSepIndex}
                    onSepHoverChange={setHoveredSepIndex}
                  />
                </React.Fragment>
              ))}
            </SortableContext>

            {activeColumn && <ColumnTrashZone />}
          </div>

          {/* Empty state: no columns */}
          {board.columns.length === 0 && (
            <div className="flex flex-col items-center justify-center h-64 gap-3 text-fg-tertiary">
              <p className="text-sm">No columns — add one to continue.</p>
              {isAdmin && (
                <button
                  onClick={() => setShowAddColumn(true)}
                  className="text-sm bg-button-primary text-on-primary px-4 py-2 rounded font-medium hover:bg-button-primary-hover transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
                >
                  + Add column
                </button>
              )}
            </div>
          )}

          {/* Swimlane rows */}
          {board.columns.length > 0 && (
            // SortableContext always receives the full swimlanes array regardless of focus mode
            // so that DnD reordering remains functional even in focus mode.
            <SortableContext items={board.swimlanes.map((s) => `swim:${s.id}`)} strategy={verticalListSortingStrategy}>
              {(() => {
                const visible = board.swimlanes.filter((s) => !hiddenSwimlaneIds.has(s.id));
                return visible.map((swimlane, idx) => (
                  <React.Fragment key={swimlane.id}>
                    <RowSeparator
                      isAdmin={isAdmin}
                      onInsert={() => { setInsertSwimlanePosition(idx); setShowAddSwimlane(true); }}
                      currentHeight={idx > 0 ? (viewPrefs.swimlaneHeights[visible[idx - 1].id] ?? undefined) : undefined}
                      setHeight={idx > 0 ? (h) => setSwimlaneHeight(visible[idx - 1].id, h) : undefined}
                      hoveredSepX={hoveredSepX}
                      colCenterXs={colCenterXs}
                    />
                    <SwimlaneRow
                      swimlane={swimlane}
                      sidebarWidth={swimlaneColWidth}
                      setSidebarWidth={setSwimlaneColumnWidth}
                      onResizeStart={handleResizeStart}
                      colWidths={colWidths}
                      setColumnWidth={setColumnWidth}
                      onInsertColumn={(colId) => {
                        setInsertPosition(board.columns.findIndex((c) => c.id === colId));
                        setShowAddColumn(true);
                      }}
                      hoveredSepIndex={hoveredSepIndex}
                      onSepHoverChange={setHoveredSepIndex}
                      minHeight={viewPrefs.swimlaneHeights[swimlane.id]}
                      setSwimlaneHeight={(h) => setSwimlaneHeight(swimlane.id, h)}
                      columns={board.columns}
                      cards={board.cards.filter((c) => c.swimlane === swimlane.id)}
                      boardId={board.id}
                      isAdmin={isAdmin}
                      canEdit={canEdit}
                      closeEditorOnEnter={closeEditorOnEnter}
                      collapsedColumnIds={collapsedColumnIds}
                      hiddenColumnIds={hiddenColumnIds}
                      filteredCardIds={filteredCardIds}
                      selectedCardIds={selectedCardIds}
                      highlightedCardId={highlightedCardId}
                      onToggleCardSelection={toggleCardSelection}
                      onCardClick={(card) => { clearSelection(); setSelectedCard(card); }}
                      onCardAdded={onCardAdded}
                      onSwimlaneUpdated={onSwimlaneUpdated}
                      onSwimlaneDeleted={onSwimlaneDeleted}
                      collapsed={collapsedSwimlaneIds.has(swimlane.id)}
                      onToggleCollapse={() => toggleCollapsedSwimlane(swimlane.id)}
                      onFocus={enterFocus}
                      onExitFocus={exitFocus}
                      isFocused={focusedSwimlaneId === swimlane.id}
                      hideLabels={viewPrefs.hideLabels}
                      hideDueDate={viewPrefs.hideDueDate}
                      hideAssignee={viewPrefs.hideAssignee}
                      hidePriority={viewPrefs.hidePriority}
                      hideLastMoved={viewPrefs.hideLastMoved}
                      userTimezone={userTimezone}
                      userDateFormat={userDateFormat}
                      compact={cardLayout === "compact"}
                      staleness_threshold_days={board.staleness_threshold_days ?? 14}
                      stale_warning_pct={board.stale_warning_pct ?? 50}
                    />
                  </React.Fragment>
                ));
              })()}
              {/* Bottom separator — resizes the last swimlane */}
              {(() => {
                const visible = board.swimlanes.filter((s) => !hiddenSwimlaneIds.has(s.id));
                const last = visible[visible.length - 1];
                return (
                  <RowSeparator
                    isAdmin={isAdmin}
                    onInsert={() => { setInsertSwimlanePosition(null); setShowAddSwimlane(true); }}
                    currentHeight={last ? (viewPrefs.swimlaneHeights[last.id] ?? undefined) : undefined}
                    setHeight={last ? (h) => setSwimlaneHeight(last.id, h) : undefined}
                    hoveredSepX={hoveredSepX}
                    colCenterXs={colCenterXs}
                  />
                );
              })()}
            </SortableContext>
          )}

          {/* Empty state: has columns but no swimlanes */}
          {board.columns.length > 0 && board.swimlanes.length === 0 && (
            <div className="flex flex-col items-center justify-center h-64 gap-3 text-fg-tertiary">
              <p className="text-sm">No swimlanes — add one to continue.</p>
              {isAdmin && (
                <button
                  onClick={() => setShowAddSwimlane(true)}
                  className="text-sm bg-button-primary text-on-primary px-4 py-2 rounded font-medium hover:bg-button-primary-hover transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
                >
                  + Add swimlane
                </button>
              )}
            </div>
          )}
          </div>{/* end min-w-max wrapper */}
        </div>{/* end board-scroll */}

        {drawerOpen && (
          <BoardActivityDrawer
            feed={activityFeed}
            onClose={() => setDrawerOpen(false)}
            onOpenHistory={() => setSearchParams({ view: "history" }, { replace: true })}
          />
        )}
        </div>{/* end flex-row wrapper */}

        <DragOverlay>
          {activeCard && <CardItem card={activeCard} overlay userTimezone={userTimezone} userDateFormat={userDateFormat} compact={cardLayout === "compact"} staleness_threshold_days={board.staleness_threshold_days ?? 14} stale_warning_pct={board.stale_warning_pct ?? 50} />}
          {activeColumn && (
            <div className="px-3 py-3 border border-info bg-surface rounded shadow-xl opacity-90" style={{ width: colWidths.get(activeColumn.id) ?? DEFAULT_COL_WIDTH }}>
              <div className="flex items-center gap-2">
                <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: activeColumn.color }} />
                <span className="font-semibold text-fg-secondary text-sm">{activeColumn.name}</span>
              </div>
            </div>
          )}
          {activeSwimlane && (
            <div className="px-3 py-3 border border-info bg-surface rounded shadow-xl opacity-90 flex items-center gap-2" style={{ width: swimlaneColWidth }}>
              <span className="w-1 h-8 rounded-full shrink-0" style={{ backgroundColor: activeSwimlane.color }} />
              <span className="font-semibold text-fg text-sm truncate">{activeSwimlane.name}</span>
            </div>
          )}
        </DragOverlay>
      </DndContext>
      </SectionErrorBoundary>

      {selectedCardIds.size > 0 && canEdit && (
        <BulkActionToolbar
          board={board}
          selectedCardIds={selectedCardIds}
          onCardsUpdated={(cards) => cards.forEach(onCardUpdated)}
          onCardsDeleted={(ids) => ids.forEach(onCardDeleted)}
          onCardsArchived={(ids) => { ids.forEach(onCardArchived); if (ids.length > 0) showArchiveToast(); }}
          onClearSelection={clearSelection}
          currentUser={currentUser}
        />
      )}

      {selectedCard && (
        <SectionErrorBoundary section="Card detail">
          <CardDetail
            card={selectedCard}
            board={board}
            onClose={() => setSelectedCard(null)}
            onDeleted={(id) => { onCardDeleted(id); setSelectedCard(null); }}
            onUpdated={onCardUpdated}
            onArchived={(id) => { onCardArchived(id); setSelectedCard(null); showArchiveToast(); }}
            onMoveCard={async (cardId, columnId, swimlaneId, position) => onMoveCard(cardId, columnId, swimlaneId, position)}
            userDateFormat={userDateFormat}
            userTimeFormat={userTimeFormat}
            userTimezone={userTimezone}
            currentUser={currentUser}
            closeEditorOnEnter={closeEditorOnEnter}
          />
        </SectionErrorBoundary>
      )}

      {isAdmin && showAddColumn && (
        <AddColumnModal
          boardId={board.id}
          onAdded={handleColumnAdded}
          onClose={() => { setShowAddColumn(false); setInsertPosition(null); }}
        />
      )}

      {isAdmin && showAddSwimlane && (
        <AddSwimlaneModal
          boardId={board.id}
          onAdded={(swimlane) => { handleSwimlaneAdded(swimlane); setShowAddSwimlane(false); setInsertSwimlanePosition(null); }}
          onClose={() => { setShowAddSwimlane(false); setInsertSwimlanePosition(null); }}
        />
      )}

      {showSettings && (
        <BoardSettingsModal
          board={board}
          isAdmin={isAdmin}
          onClose={() => setShowSettings(false)}
          viewPrefs={viewPrefs}
          onToggleHiddenColumn={toggleHiddenColumn}
          onToggleHiddenSwimlane={toggleHiddenSwimlane}
          onSetCardFieldPref={setCardFieldPref}
          onBoardDeleted={onBoardDeleted}
          onUpdateBoardSettings={onUpdateBoardSettings}
        />
      )}

      {showShortcuts && (
        <KeyboardShortcutsOverlay
          onClose={() => setShowShortcuts(false)}
          onRestartTour={currentUser ? async () => {
            await replayTour();
            setShowShortcuts(false);
          } : undefined}
        />
      )}

      <CommandPalette
        open={paletteOpen}
        boardCards={board.cards}
        columns={board.columns}
        isAdmin={isAdmin}
        onClose={() => setPaletteOpen(false)}
        onOpenCard={(card) => { clearSelection(); setSelectedCard(card); }}
        onAction={(id) => {
          if (id === "my-cards") {
            if (currentUser) {
              setFilters({ ...filters, assigneeIds: [currentUser.id] });
              setShowFilters(true);
            }
          } else if (id === "shortcuts") {
            setShowShortcuts(true);
          } else if (id === "history") {
            setView("history");
          } else if (id === "settings") {
            setShowSettings(true);
          }
        }}
      />

      {showExport && (
        <BoardExportModal
          boardId={board.id}
          onClose={() => setShowExport(false)}
        />
      )}

      {showArchived && (
        <ArchivedCardsPanel
          board={board}
          onClose={() => setShowArchived(false)}
          onUnarchived={(card) => { onCardUnarchived(card); }}
          currentUser={currentUser}
        />
      )}

      {currentUser && !currentUser.has_completed_tour && (
        <OnboardingTour
          onComplete={() => {
            if (currentUser && onUserUpdated) {
              onUserUpdated({ ...currentUser, has_completed_tour: true });
            }
          }}
        />
      )}

      {confirmDeleteColumn && (() => {
        const cardCount = board.cards.filter((c) => c.column === confirmDeleteColumn.id).length;
        return (
          <ModalWrapper
            open
            onClose={() => setConfirmDeleteColumn(null)}
            title="Delete column?"
            maxWidth="max-w-sm"
          >
            <p className="text-fg-tertiary text-sm mb-1">
              <span className="text-fg font-medium">{confirmDeleteColumn.name}</span> will be permanently deleted.
            </p>
            {cardCount > 0 && (
              <p className="text-danger text-sm mb-1">
                {cardCount} active card{cardCount !== 1 ? "s" : ""} in this column will also be deleted.
              </p>
            )}
            <p className="text-danger text-sm mb-1">
              Any archived cards in this column will also be permanently deleted.
            </p>
            <p className="text-fg-muted text-sm mb-5">This cannot be undone.</p>
            <div className="flex items-center justify-end gap-3">
              <button
                onClick={() => setConfirmDeleteColumn(null)}
                className="text-fg-secondary hover:text-fg hover:bg-surface-hover px-3 py-1.5 text-sm rounded transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
              >
                Cancel
              </button>
              <button
                onClick={() => {
                  onColumnDeleted(confirmDeleteColumn.id);
                  setConfirmDeleteColumn(null);
                }}
                className="bg-danger-bg hover:bg-danger-bg-hover text-on-danger px-3 py-1.5 text-sm rounded font-medium focus:outline-none focus:ring-2 focus:ring-danger-emphasis"
              >
                Delete
              </button>
            </div>
          </ModalWrapper>
        );
      })()}
    </>
  );
}
