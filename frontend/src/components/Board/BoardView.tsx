import React, { useState, useCallback, useEffect, useRef, useMemo } from "react";
import { shareLinkIssuedAtFromEvent, shareLinkPatchFromEvent, stripPerUserBoardFields } from "../../utils/boardEventPayload";
import { boardColorsInUse } from "../../utils/boardColors";
import { getCardChildrenRollup, getCardParent, getCardStatus } from "../../api/cards";
import { CARD_PARENT_REFETCH_EVENT } from "../Card/cardParent";
import { resetTour } from "../../api/auth";
import { getGroup } from "../../api/groups";
import { useLocation, useSearchParams } from "react-router-dom";
import SummaryView from "./SummaryView";
import { useJoinedToast } from "../Common/useJoinedToast";
import AnalyticsView from "./AnalyticsView";
import MovementHistoryView from "./MovementHistoryView";
import { useBoardSocket } from "../../hooks/useBoardSocket";
import { useEscapeStack } from "../../hooks/useEscapeStack";
import { useLiveAnnouncer, laneStateMessage, boardStateMessage } from "../../hooks/useLiveAnnouncer";
import { useDragSensors } from "../../hooks/useDragSensors";
import { markBoardTreePointerEvent } from "../../hooks/useCardSheetPlacement";
import type { BoardEvent } from "../../hooks/useBoardSocket";
import { BoardOfflineBanner, BoardEmptyState, BoardNoMatchState, ViewOnlyNotice } from "./BoardStates";
import { noMatchLine } from "./boardStateCopy";
import ConnectionStatus from "../Common/ConnectionStatus";
import {
  DndContext,
  DragOverlay,
  closestCenter,
  useDroppable,
  useSensors,
} from "@dnd-kit/core";
import type { DragEndEvent, DragStartEvent, DragOverEvent, CollisionDetection } from "@dnd-kit/core";
import { SortableContext, horizontalListSortingStrategy, verticalListSortingStrategy, arrayMove } from "@dnd-kit/sortable";
import type { BoardMembership, Card, CardMovedEventPayload, CardParent, Column, CustomFieldDefinition, Label, ShareLinkUpdatedPayload, Swimlane, SwimlaneCustomFieldDefinition, User, WebhookChangedPayload } from "../../types";
import { userDisplayName } from "../../types";
import { mergeSwimlaneFromBroadcast } from "../../utils/swimlaneMerge";
import { placementVerdict, trippedLimitSentence } from "../../utils/placementLimits";
import { resolveRollupField } from "../../utils/laneRollup";
import { entryCriteriaFor, entryCriteriaSentence, needsEntryConfirm } from "../../utils/columnPolicy";
import PolicyConfirmModal from "./PolicyConfirmModal";
import { useBoardContext } from "../../contexts/BoardContext";
import ColumnHeader from "./ColumnHeader";
import { ADD_CARD_EVENT } from "../../utils/addCardEvent";
import ColumnSeparator from "./ColumnSeparator";
import { boardGridMinWidth, boardGridTemplate, clampColumnWidth, columnTrack, trackFloor, useBoardViewWidthVar, type BoardTrack } from "./boardGrid";
import RowSeparator from "./RowSeparator";
import SwimlaneRow from "./SwimlaneRow";
import PhoneBoard from "./PhoneBoard";
import { cellOrderOf } from "../../utils/phoneReorder";
import { useIsPhoneViewport } from "../../hooks/useIsPhoneViewport";
import CardItem from "../Card/CardItem";
import { RollupLoadingContext } from "../Card/rollupLoading";
import { parseCardDetailTab, rememberCardDetailTab, type CardDetailTab } from "../Card/cardDetailTabMemory";
import CardDetail from "../Card/CardDetail";
import CardPeekSheet from "../Card/CardPeekSheet";
import AddColumnModal from "./AddColumnModal";
import AddSwimlaneModal from "../Swimlane/AddSwimlaneModal";
import BoardSettingsModal from "./BoardSettingsModal";
import { canEditSwimlaneFieldOrder } from "../../utils/swimlaneFieldOrder";
import BoardExportModal from "./BoardExportModal";
import { useOverflowSeenPref } from "../../hooks/useOverflowSeenPref";
import { useIsLargeViewport } from "../../hooks/useIsLargeViewport";
import OverflowMenu from "../Layout/OverflowMenu";
import type { OverflowItem } from "../Layout/OverflowMenu";
import { formatShortcut, formatAriaKeyshortcuts } from "../../utils/platform";
import SingleSelectDropdown from "../Common/SingleSelectDropdown";
import { OverlayIcon, PresetIcon } from "./toolbarIcons";
import BoardViewMenu from "./BoardViewMenu";
import FilterBar, { countActiveFilters, EMPTY_FILTER } from "./FilterBar";
import SavedFiltersDropdown from "./SavedFiltersDropdown";
import SavedFilterTabs from "./SavedFilterTabs";
import FilterPanel from "./FilterPanel";
import KeyboardShortcutsOverlay from "./KeyboardShortcutsOverlay";
import { SHOW_BOARD_SHORTCUTS_EVENT } from "../Layout/shellNavModel";
import Tooltip from "../Common/Tooltip";
import HideFilterBarButton, { focusFiltersTrigger } from "./HideFilterBarButton";
import BulkActionToolbar from "./BulkActionToolbar";
import CardContextMenu, { type CardMenuAnchor, type CardMenuCloseReason } from "../Card/CardContextMenu";
import CardDeleteConfirm from "../Card/CardDeleteConfirm";
import { BOARD_SCROLL_SELECTOR, findBoardCardElement } from "../../hooks/useCardSheetPlacement";
import {
  CARD_ACTION_EVENT, CARD_TARGET_QUERY_EVENT, MOVES_PAUSED_REASON, archiveCards, assignCards, cardActionEntries, cardLink,
  cardTargetSummary, contextMenuTargetIds, moveCardsToColumn, parseMoveChoice, reorderChoices, resolveCardTarget, setCardsPriority, successMessage,
  type CardActionContext, type CardActionDetail, type CardActionId, type CardTargetQueryDetail, type ReorderStep, type SubColumnStep, subColumnChoices,
} from "../../utils/cardActions";
import { ToastRegionSlot } from "../../contexts/ToastContext";
import { useToast } from "../../contexts/useToast";
import { cardMovedActivity, cardSubColumnIndex, isGatedStage, notifyLeaveWarning, stageSubColumns, subColumnNeighbors } from "../../utils/stages";
import ArchivedCardsPanel from "./ArchivedCardsPanel";
import OnboardingTour from "./OnboardingTour";
import LensView from "./Lens/LensView";
import LensConnectionModal from "./LensConnectionModal";
import { getLensConnection } from "../../api/gitLens";
import type { LensConnection } from "../../types";
import { useViewPrefs } from "../../hooks/useViewPrefs";
import { useCardLayoutPref } from "../../hooks/useCardLayoutPref";
import { useCardDensityOverride } from "../../hooks/useCardDensityOverride";
import LensToolbar from "./Lens/LensToolbar";
import { isBoardTabDeemphasized, LENS_ONLY_BOARD_TOOLTIP } from "./lensTabState";
import { lensFilterActiveCount } from "./Lens/lensDims";
import { FilterIcon } from "./toolbarIcons";
import { useBoardPan } from "../../hooks/useBoardPan";
import { usePersistedFilters } from "../../hooks/usePersistedFilters";
import { useSavedFilters } from "../../hooks/useSavedFilters";
import { useBoardResync } from "../../hooks/useBoardResync";
import { useDeferredResync } from "../../hooks/useDeferredResync";
import SectionErrorBoundary from "../SectionErrorBoundary";
import BoardActivityDrawer from "./BoardActivityDrawer";
import type { ActivityEntry, DrawerTab } from "./BoardActivityDrawer";
import { useCardSearch } from "../../hooks/useCardSearch";
import { todayInTimezone } from "../../utils/date";
import { useGridOverlayPref } from "../../hooks/useGridOverlayPref";
import { useBoardPreset } from "../../hooks/useBoardPreset";
import { formatPresetDifference, getBoardPreset, listBoardPresets, presetSummary } from "../../boardPresets/registry";
import { PRESET_COMMAND_EVENT, type PresetCommand } from "../../boardPresets/activePresetStore";
import type { BoardPresetId } from "../../types";
import { usePresetNoticeToast } from "./usePresetNoticeToast";
import { useOverlayClock } from "../../hooks/useOverlayClock";
import { dwellOverlay } from "../../gridOverlays/builtin/dwell";
import { NONE_OVERLAY_ID, getGridOverlay, listGridOverlays, resolveGridOverlayId } from "../../gridOverlays/registry";
import { buildGridOverlayState } from "../../gridOverlays/slot";
import GridOverlayLegend from "./GridOverlay/GridOverlayLegend";
import { filterCards, hasActiveClientFilters, pruneStaleFilters } from "../../utils/filterCards";
import { parseShowChip, showChipCardIds, showChipCounts, type ShowChipKey } from "../../utils/showChips";
import ShowChips from "./ShowChips";
import ModalWrapper from "../shared/ModalWrapper";
import { useInstanceFlags } from "../../contexts/InstanceFlagsContext";
import { isImeComposing } from "../../utils/imeComposition";
import { firstNotDoneColumn, wouldBecomeIntakeColumn } from "../../utils/intakeColumn";
import { parseParentFilterParam } from "../../utils/parentFilter";
import { countUnusableLaneRules, laneFilterFields, laneIdsHiddenByFilter, parseLaneFilterParam, pruneLaneFilter, serializeLaneFilterParam, withHideUnmatched, withLaneItems } from "../../utils/laneFilter";
import { useLaneFilterNotice } from "../../hooks/useLaneFilterNotice";

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
      aria-label="Drop here to delete column"
      // Absolutely placed so it never adds a track to the shared grid (#2300).
      className={`absolute inset-y-0 right-0 w-20 flex items-center justify-center px-2 border-l transition-colors ${
        isOver
          ? "bg-danger/50 border-danger/60"
          : "bg-danger/30 border-line"
      }`}
    >
      <span className={`text-xs font-medium whitespace-nowrap ${isOver ? "text-fg" : "text-fg-secondary"}`}>
        <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4 mx-auto mb-0.5" viewBox="0 0 20 20" fill="currentColor">
          <path fillRule="evenodd" d="M9 2a1 1 0 00-.894.553L7.382 4H4a1 1 0 000 2v10a2 2 0 002 2h8a2 2 0 002-2V6a1 1 0 100-2h-3.382l-.724-1.447A1 1 0 0011 2H9zM7 8a1 1 0 012 0v6a1 1 0 11-2 0V8zm5-1a1 1 0 00-1 1v6a1 1 0 102 0V8a1 1 0 00-1-1z" clipRule="evenodd" />
        </svg>
        Delete
      </span>
    </div>
  );
}

// All board sub-view tab names. "lens" is conditionally available (only when
// the board has a lens connection and the current user has git_lens_enabled).
type BoardViewName = "board" | "summary" | "history" | "analytics" | "lens";

/**
 * The toolbar's tab strip. On a phone it is narrower than its tabs (#2348), so the active tab is scrolled
 * into view when the view changes and a right-edge fade shows that more tabs sit past the edge. The fade is a
 * mask (no color token needed) and only applies below 640px while the strip is scrolled short of its end.
 * Every view's toolbar (Board, Summary, History, Analytics, Lens) renders its tabs through this strip
 * (#2395): each view mounts its own toolbar, so a strip only in the board view never saw the active tab
 * change, and the other views clipped a fifth (Lens) tab with no fade.
 */
export function ViewTabStrip({ view, children }: { view: string; children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [fade, setFade] = useState(false);
  const measure = useCallback(() => {
    const el = ref.current;
    if (el) setFade(el.scrollWidth - el.clientWidth - el.scrollLeft > 1);
  }, []);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const active = el.querySelector<HTMLElement>('[aria-current="page"]');
    // jsdom has no scrollIntoView.
    if (active && typeof active.scrollIntoView === "function") active.scrollIntoView({ inline: "nearest", block: "nearest" });
    measure();
  }, [view, measure]);
  useEffect(() => {
    window.addEventListener("resize", measure);
    // A tab that mounts late (Lens waits on a connection and a flag) or changes width resizes the
    // content without a scroll or window resize, so watch the strip and its content box (#2395).
    // jsdom has no ResizeObserver; the listeners alone are the fallback.
    let ro: ResizeObserver | undefined;
    const el = ref.current;
    if (el && typeof ResizeObserver !== "undefined") {
      ro = new ResizeObserver(measure);
      ro.observe(el);
      if (el.firstElementChild) ro.observe(el.firstElementChild);
    }
    return () => {
      window.removeEventListener("resize", measure);
      ro?.disconnect();
    };
  }, [measure]);
  return (
    <div
      ref={ref}
      onScroll={measure}
      data-tour-step="view-tabs"
      data-testid="view-tab-strip"
      data-fade={fade ? "true" : undefined}
      className={`min-w-0 max-w-full overflow-x-auto max-sm:order-1 max-sm:flex-1 ${
        fade ? "max-sm:[mask-image:linear-gradient(to_right,#000_calc(100%-24px),transparent)]" : ""
      }`}
    >
      {children}
    </div>
  );
}

export function ViewToggle({
  view,
  onChange,
  showLens = false,
  deemphasizeBoard = false,
}: {
  view: BoardViewName;
  onChange: (v: BoardViewName) => void;
  /** Whether to render the read-only "Lens" tab (gated on connection + flag). */
  showLens?: boolean;
  /**
   * Mute the Board tab (lens configured + zero native swimlanes, #1063). Stays a
   * normal, enabled, one-click button — only its weight and a tooltip change.
   */
  deemphasizeBoard?: boolean;
}) {
  // Bare-letter shortcut per view. Rendered in the tooltip and exposed via
  // `aria-keyshortcuts` so screen readers can announce the binding. Keys are
  // platform-agnostic (single printable character — same on Mac/Linux/Win).
  const btn = (
    label: string,
    val: BoardViewName,
    shortcut: string,
    tourStep?: string,
    muted = false,
  ) => (
    <Tooltip
      content={
        muted
          ? `${LENS_ONLY_BOARD_TOOLTIP} (${shortcut.toUpperCase()})`
          : `${label} (${shortcut.toUpperCase()})`
      }
    >
      <button
        onClick={() => onChange(val)}
        className={`text-sm px-3 h-10 max-sm:h-11 border-b-2 transition focus:outline-none focus:ring-2 focus:ring-inset focus:ring-primary-emphasis ${
          view === val
            ? "text-fg font-bold border-primary"
            : muted
              ? "text-fg-secondary italic border-transparent hover:text-fg"
              : "text-fg-secondary border-transparent hover:text-fg"
        }`}
        aria-current={view === val ? "page" : undefined}
        aria-keyshortcuts={shortcut.toUpperCase()}
        {...(muted ? { "data-deemphasized": "true" } : {})}
        {...(tourStep ? { "data-tour-step": tourStep } : {})}
      >
        {label}
      </button>
    </Tooltip>
  );
  return (
    <div className="flex w-max items-center gap-1">
      {btn("Board", "board", "b", undefined, showLens && deemphasizeBoard)}
      {showLens && btn("Lens", "lens", "l")}
      {btn("Summary", "summary", "s")}
      {btn("History", "history", "h", "history")}
      <Tooltip content="Analytics (A)">
        <button
          onClick={() => onChange("analytics")}
          className={`text-sm px-3 h-10 max-sm:h-11 border-b-2 transition focus:outline-none focus:ring-2 focus:ring-inset focus:ring-primary-emphasis ${
            view === "analytics"
              ? "text-fg font-bold border-primary"
              : "text-fg-secondary border-transparent hover:text-fg"
          }`}
          aria-current={view === "analytics" ? "page" : undefined}
          aria-keyshortcuts="A"
        >
          <span className="flex items-center gap-1.5">
            Analytics
            {/* #2236: one opaque bg-surface chip in every tab state. A translucent fill took its
                contrast from the tab underneath (1.17:1 on the active bg-primary in light mode,
                3.55 dark on the hover bg-surface-active); an opaque fill makes the ratio
                independent of the tab: 8.67 dark / 7.31 light. See frontend/CLAUDE.md § Color tokens. */}
            <span className="px-1 py-0 text-xs font-medium rounded leading-4 bg-surface text-warning-on-tint ring-1 ring-inset ring-warning/40">
              Beta
            </span>
          </span>
        </button>
      </Tooltip>
    </div>
  );
}

// Icon constants for the overflow menu. Kept at module scope so the JSX
// nodes are stable across renders and the items useMemo is not invalidated
// by fresh icon references every render.
// Layout icons live in ./toolbarIcons so the lens toolbar renders the exact
// same nodes — board↔lens parity is a design requirement (#1064).

const ViewMenuIcon = (
  <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" aria-hidden="true">
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="M9 4v16M15 4v16" />
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

// Window in which an event echoing the actor's own member add does not
// trigger a second re-read (#1706).
const MEMBER_ECHO_MS = 2000;

// First-open resync threshold (#1968). The socket joins the board's broadcast
// group only during its handshake, after `/full/` returned, so a frame committed
// in between is in neither the snapshot nor the stream. When the socket's first
// open comes more than this long after the latest `/full/` response was applied
// (a slow handshake, or a first connect that failed and retried), the board
// re-reads once. Below it the gap is the normal mount-to-handshake time, and
// re-reading on every board open would double the cost of the heaviest read.
// The real gap starts when the server read the snapshot, so it also includes
// the time spent serving `/full/`; anchoring at request start would count
// that, but would re-read every slow (large) board on every open. A frame
// inside a gap below the threshold is still missed until the next resync.
const FIRST_OPEN_RESYNC_MS = 1000;


/** Above this many ids, a `card.parent_changed` re-reads the board, not each card (#1104). */
const PARENT_REFETCH_MAX_CARDS = 20;

/** Coalescing key of the "Card archived" toast. */
const ARCHIVE_TOAST_KEY = "archive";
const CARD_NOT_FOUND_TOAST_KEY = "card-not-found";
const CARD_ACTION_TOAST_KEY = "card-action";

export default function BoardView({ onBoardDeleted, userTimezone = "", userDateFormat = "MM/DD/YYYY", userTimeFormat = "12h", closeEditorOnEnter = false, currentUser = null, onUserUpdated }: Props) {
  // #1913: instance flags come from site-config, not the deprecated User copies.
  const { maintenance_mode: maintenanceMode, demo_mode: demoMode } = useInstanceFlags();
  const {
    board: boardOrNull,
    moveCard: onMoveCardRaw,
    forceMoveCardTo: forceMoveCardToRaw,
    moveError,
    clearMoveError,
    addCard: onCardAdded,
    removeCard,
    archiveCard,
    archiveCardByUid,
    unarchiveCard,
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
    applyCustomFieldDefinitions: onCustomFieldDefinitionsApplied,
    applySwimlaneFieldDefinitions: onSwimlaneFieldDefinitionsApplied,
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
    applyCardParents,
    applyCardChildrenRollups,
    silentReload,
    getLastFullFetchAt,
  } = useBoardContext();
  // Backstop for #2325: every Move path (drag, menus, bulk, peek/detail forms, the entry
  // checklist, "Move anyway") ends in one of these two. A control that was already open
  // when the socket dropped still reaches them, so they refuse while moves are paused. The ref
  // is read at call time, so a stale closure cannot slip a move through.
  const movesPausedRef = useRef(false);
  const { notify: notifyToast, dismiss: dismissToast } = useToast();
  // The board at call time, for the leave warning's pre-move copy of the card.
  const latestBoardRef = useRef(boardOrNull);
  latestBoardRef.current = boardOrNull;
  // These two are also the one place a single-card move raises the leave
  // warning (#1102): drag, entry checklist, peek, phone, card detail and the
  // forced move all end here. The card menu and bulk toolbar move through
  // moveCardsToColumn and call the same notifyLeaveWarning.
  const onMoveCard = useCallback<typeof onMoveCardRaw>(async (...args) => {
    if (movesPausedRef.current) return { ok: false, error: new Error(MOVES_PAUSED_REASON) };
    const b = latestBoardRef.current;
    const before = b?.cards.find((c) => c.id === args[0]);
    const outcome = await onMoveCardRaw(...args);
    if (b && before && !(outcome && outcome.ok === false)) notifyLeaveWarning(notifyToast, [before], b.columns, args[1]);
    return outcome;
  }, [onMoveCardRaw, notifyToast]);
  const forceMoveCardTo = useCallback<typeof forceMoveCardToRaw>(async (...args) => {
    if (movesPausedRef.current) return { ok: false, error: new Error(MOVES_PAUSED_REASON) };
    const b = latestBoardRef.current;
    const before = b?.cards.find((c) => c.id === args[0]);
    const outcome = await forceMoveCardToRaw(...args);
    if (b && before && !(outcome && outcome.ok === false)) notifyLeaveWarning(notifyToast, [before], b.columns, args[1]);
    return outcome;
  }, [forceMoveCardToRaw, notifyToast]);

  // BoardView is only rendered when board is non-null (guarded by the parent).
  // The non-null assertion keeps the existing contract without changing every
  // downstream reference from BoardFull to BoardFull | null.
  const board = boardOrNull!;

  // Mirror the current board into a ref so cross-component event handlers
  // (e.g. GlobalCommandPalette's open-card dispatch) can resolve a card by id
  // without re-registering the listener on every cards-array identity change.
  const boardRef = useRef(board);
  boardRef.current = board;

  // Re-fetch board state when the user returns to a backgrounded tab.
  useBoardResync(silentReload);

  // The member add/update response and events omit the site-admin flag unless
  // a site admin made the change (#1706), so a viewer who sees the lock (board
  // admin or site admin) re-reads the board to get it. The actor's own add
  // re-reads once; its echo event within MEMBER_ECHO_MS does not repeat it.
  const memberReloadAtRef = useRef(0);
  // A membership frame never carries `has_all_content_access` (#1301), so an
  // admin reader re-reads `/full/` for any subject whose value is not yet known
  // in state, even when the frame carries `is_site_admin`. Without it the Members
  // tab would offer a role picker on an all-content row.
  const allContentUnknown = useCallback((userId: number) => {
    const row = boardRef.current?.members.find((m) => m.user.id === userId);
    return row?.has_all_content_access === undefined;
  }, []);
  // Subjects the latest re-read is known to cover, subjects whose frame arrived
  // inside the window and is waiting for one trailing re-read, and that timer.
  // A frame for a member the latest re-read already covers is an echo and is
  // dropped (#1706). A frame for a different member may postdate that re-read,
  // so it earns a single trailing re-read at the window's end instead of being
  // lost, which would leave that row without its all-content flag (#1301).
  const memberCoveredRef = useRef<Set<number>>(new Set());
  const memberPendingRef = useRef<Set<number>>(new Set());
  const memberTrailingRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const silentReloadRef = useRef(silentReload);
  silentReloadRef.current = silentReload;
  useEffect(() => () => {
    if (memberTrailingRef.current !== null) clearTimeout(memberTrailingRef.current);
  }, []);
  const reloadForMemberFlag = useCallback((subjects: number[] = []) => {
    const role = boardRef.current?.current_user_role;
    if (role !== "admin" && role !== "site_admin") return;
    const now = Date.now();
    const elapsed = now - memberReloadAtRef.current;
    if (elapsed >= MEMBER_ECHO_MS) {
      memberReloadAtRef.current = now;
      memberCoveredRef.current = new Set(subjects);
      silentReloadRef.current();
      return;
    }
    if (subjects.length > 0 && subjects.every((id) => memberCoveredRef.current.has(id))) return;
    subjects.forEach((id) => memberPendingRef.current.add(id));
    if (memberTrailingRef.current !== null) return;
    memberTrailingRef.current = setTimeout(() => {
      memberTrailingRef.current = null;
      memberReloadAtRef.current = Date.now();
      memberCoveredRef.current = memberPendingRef.current;
      memberPendingRef.current = new Set();
      silentReloadRef.current();
    }, MEMBER_ECHO_MS - elapsed);
  }, []);

  // #1444 — bumped on invite socket events so the Members tab's pending
  // invite list (Board Settings) refetches while it is open.
  const [inviteReloadSignal, setInviteReloadSignal] = useState(0);
  // #1967 — issued_at of the latest share_link.updated that issued a link,
  // passed to BoardSettingsModal so it can tell a rotation made elsewhere.
  const [shareLinkIssuedAt, setShareLinkIssuedAt] = useState<string | null>(null);
  // #2057 — the latest admin-only webhook.changed frame, for an open Webhooks
  // tab. `seq` makes two identical frames two changes.
  const [webhookChange, setWebhookChange] = useState<(WebhookChangedPayload & { seq: number }) | null>(null);
  // #2057 — bumped on each socket reconnect so an open Webhooks tab re-reads
  // its list: webhook.changed is broadcast-only, and frames sent while the
  // socket was down are not in the /full/ resync.
  const [socketReconnectSeq, setSocketReconnectSeq] = useState(0);

  // #1444 — arriving from a board invite (JoinPage / the OAuth return in
  // App.tsx) carries what happened in navigation state.
  const location = useLocation();
  // Raised once as a persistent `success` toast in the shared region (#2107).
  const [joinedTitle] = useState<string | null>(() => {
    const st = location.state as { joinedBoard?: string; joinedRole?: string; created?: boolean } | null;
    if (!st?.joinedBoard) return null;
    return st.created !== false
      ? `You've joined ${st.joinedBoard} as a ${st.joinedRole ?? "member"}. Welcome!`
      : `You already have access to ${st.joinedBoard}.`;
  });
  useJoinedToast(joinedTitle);

  // Delete and archive both remove the card from local state, but archive also
  // moves it into archived_card_count, which the settings modal's delete gate
  // reads (#1289) — so they are distinct handlers.
  const onCardDeleted = removeCard;
  const onCardArchived = archiveCard;
  const isAdmin = board.current_user_role === "admin" || board.current_user_role === "site_admin";
  // While the instance is in maintenance mode (#783) every write this user
  // could attempt would come back 503, so fold it into the existing per-board
  // write gate rather than bolting a second one alongside it. Routing it
  // through canEdit means every affordance already gated on "you may edit this
  // board" — drag handles, add-card cells, kebabs, inline editors — turns off
  // together, so people are not invited to compose work that cannot be saved.
  // Site admins are exempt server-side and so are exempt here; their writes
  // genuinely still succeed.
  const blockedByMaintenance =
    maintenanceMode && !(currentUser?.is_site_admin ?? false);
  const canEdit =
    !blockedByMaintenance && (isAdmin || board.current_user_role === "member");
  // #843 — mirror of the backend per-board export gate. Owner / site_admin
  // always bypass; everyone else must meet ``board.export_min_role``. When
  // the threshold flips via WebSocket, the Export button re-evaluates on
  // re-render and hides itself, and the auto-close effect below dismisses
  // an open export modal so the user doesn't click into a 403.
  // An unrecognized threshold is treated as admin-only, as on the server (#1725).
  const EXPORT_ROLE_RANK: Record<string, number> = { viewer: 0, collaborator: 1, member: 2, admin: 3 };
  const exportMinRole = board.export_min_role || "viewer";
  const canExport =
    board.current_user_role === "site_admin" ||
    board.current_user_role === "admin" ||
    (board.current_user_role != null &&
      EXPORT_ROLE_RANK[board.current_user_role] >= (EXPORT_ROLE_RANK[exportMinRole] ?? EXPORT_ROLE_RANK.admin));

  const validColumnIds = useMemo(() => new Set(board.columns.map((c) => c.id)), [board.columns]);
  const validSwimlaneIds = useMemo(() => new Set(board.swimlanes.map((s) => s.id)), [board.swimlanes]);
  const { prefs: viewPrefs, setShowSubColumns, toggleHiddenColumn, toggleCollapsedColumn, expandAllColumns, collapseAllColumns, toggleHiddenSwimlane, toggleCollapsedSwimlane, collapseAllSwimlanes, expandAllSwimlanes, setColumnWidth, setSwimlaneHeight } = useViewPrefs(board.id, validColumnIds, validSwimlaneIds);
  const [cardLayout, setCardLayout] = useCardLayoutPref();
  // #974 — per-user override of the board admin's card_density default,
  // layered on top of it (never mutates board.card_density itself, so an
  // admin flipping the board setting never stomps a user's personal
  // choice). Resolved once here and fed through the same `density` prop
  // that already flows down to SwimlaneRow -> BoardCell -> CardItem.
  const [cardDensityOverride, setCardDensityOverride] = useCardDensityOverride(board.id);
  // #1147 — which grid overlay is shading the cells. Board-scoped, per-user, and
  // `none` by default, so an un-configured board is byte-for-byte the pre-#1147 one.
  const [gridOverlayLocal, setGridOverlayId, clearGridOverlayId] = useGridOverlayPref(board.id);
  // #1146 — board presets. Density and overlay are resolved here, once: a
  // `?preset=` link, then this user's own choices, then the board's default
  // preset, then the board itself. With no board default and no link this is
  // exactly `override ?? board.card_density` and `local ?? none`, as before.
  // Declared here, ahead of its other readers further down, because the preset
  // hook needs it; one instance so two functional updates never race.
  const [searchParams, setSearchParams] = useSearchParams();
  // An in-app link to another board (`/boards/9?card=301`, `?settings=rules`) changes the URL while
  // this, the previous board's view, is still mounted until the new board loads. Its deep-link
  // effects must leave those params for the board they name, or they strip them and report the
  // card as missing here (#2210). A path that names no board (a bare render) means this board.
  const routeBoardId = /^\/boards\/(\d+)/.exec(location.pathname)?.[1];
  const isRouteBoard = routeBoardId === undefined || Number(routeBoardId) === board.id;
  const boardPreset = useBoardPreset({
    boardId: board.id,
    board,
    densityOverride: cardDensityOverride,
    setDensityOverride: setCardDensityOverride,
    localOverlay: gridOverlayLocal,
    setLocalOverlay: setGridOverlayId,
    clearLocalOverlay: clearGridOverlayId,
    searchParams,
    setSearchParams,
  });
  const effectiveCardDensity = boardPreset.display.density;
  const gridOverlayId = boardPreset.display.overlay;
  const gridOverlay = useMemo(() => getGridOverlay(gridOverlayId), [gridOverlayId]);
  const presetOptions = useMemo(
    () =>
      listBoardPresets().map((p) => ({
        value: p.id,
        label: p.name,
        description: p.id === board.default_preset ? `Board default · ${presetSummary(p)}` : presetSummary(p),
      })),
    [board.default_preset],
  );
  const activePreset = boardPreset.activePreset;
  const presetModified = boardPreset.differences.length > 0;
  // The primitive reports a click on the selected option as null. For a preset
  // that means "this one again": a reset when modified, nothing when not.
  // Re-choosing the active, unmodified preset changes nothing, but a silent menu close
  // reads as a dropped click (#2124). Say so in the shared toast region, which also
  // announces it. A separate key from the apply notice so it never replaces that Undo.
  const notifyPresetAlreadyActive = (name: string) => {
    notifyToast({
      key: "preset-already-active",
      variant: "info",
      title: `\u201c${name}\u201d is already applied`,
      durationMs: 4000,
      testId: "preset-already-active",
    });
  };
  const handlePresetChange = (next: BoardPresetId | null) => {
    const id = next ?? activePreset?.id ?? null;
    if (id === null) return;
    const same = id === activePreset?.id;
    if (same && !presetModified) {
      if (activePreset) notifyPresetAlreadyActive(activePreset.name);
      return;
    }
    boardPreset.applyPreset(id, same ? "reset" : "apply");
  };
  // Phone width (#2277): one column at a time, no drag.
  const isPhone = useIsPhoneViewport();
  const presetPickerRef = useRef<HTMLSpanElement>(null);
  const focusPresetTrigger = useCallback(() => {
    // On phones the View button is `max-sm:hidden` (#2340), so a focus() on it would
    // drop focus to <body>. The Filter trigger (a sibling in the same toolbar row)
    // is the visible entry to the View panel there.
    const filterTrigger = isPhone
      ? presetPickerRef.current?.parentElement?.querySelector<HTMLButtonElement>('button[data-tour-step="filter"]')
      : null;
    (filterTrigger ?? presetPickerRef.current?.querySelector<HTMLButtonElement>("button[aria-haspopup]"))?.focus();
  }, [isPhone]);
  const presetNotice = boardPreset.notice;
  const presetMenuActions = [
    ...(presetModified && activePreset
      ? [{ key: "reset", label: `Reset to \u201c${activePreset.name}\u201d`, onSelect: () => boardPreset.applyPreset(activePreset.id, "reset") }]
      : []),
    ...(presetNotice ? [{ key: "undo", label: `Undo: ${presetNotice.message}`, onSelect: boardPreset.undoNotice }] : []),
  ];
  // The preset notice (#1146) is an `info` toast in the shared region (#2107). The
  // hook lives here, not in a view branch, so it survives switching between
  // Board, Summary, History, Analytics and the Lens: a ⌘K command or a
  // ?preset= link can apply a preset in any of them, and its Undo must be offered.
  usePresetNoticeToast({
    notice: boardPreset.notice,
    onUndo: boardPreset.undoNotice,
    onDismiss: boardPreset.dismissNotice,
    onReturnFocus: focusPresetTrigger,
  });

  // ⌘K "Apply preset: …" / "Reset to preset: …" (#1146) arrive from the shell-level
  // palette as a window event and take the picker's own apply path, so they raise
  // the same Undo notice. Read through a ref so the listener subscribes once.
  const presetCommandRef = useRef({ boardPreset, activePreset, presetModified });
  presetCommandRef.current = { boardPreset, activePreset, presetModified };
  const notifyPresetAlreadyActiveRef = useRef(notifyPresetAlreadyActive);
  notifyPresetAlreadyActiveRef.current = notifyPresetAlreadyActive;
  useEffect(() => {
    const onPresetCommand = (e: Event) => {
      const command = (e as CustomEvent<PresetCommand>).detail;
      const { boardPreset: bp, activePreset: active, presetModified: modified } = presetCommandRef.current;
      if (command?.kind === "reset") {
        if (active && modified) bp.applyPreset(active.id, "reset");
      } else if (command?.kind === "apply" && getBoardPreset(command.presetId)) {
        const same = command.presetId === active?.id;
        if (same && !modified) {
          if (active) notifyPresetAlreadyActiveRef.current(active.name);
          return;
        }
        bp.applyPreset(command.presetId, same ? "reset" : "apply");
      }
    };
    window.addEventListener(PRESET_COMMAND_EVENT, onPresetCommand);
    return () => window.removeEventListener(PRESET_COMMAND_EVENT, onPresetCommand);
  }, []);
  const gridOverlayNow = useOverlayClock(gridOverlay?.refreshMs);
  const gridOverlayOptions = useMemo(
    () => listGridOverlays().map((o) => ({ value: o.id, label: o.label })),
    [],
  );
  // Screen-reader confirmation that the overlay changed — the tint appearing is the
  // only other feedback, and a tint is not available to every user. Disjoint from the
  // drag announcer below it: one fires on a pointer drag, the other on a toolbar click.
  const [overlayAnnouncement, setOverlayAnnouncement] = useState("");
  const handleGridOverlayChange = useCallback(
    (next: string | null) => {
      const resolved = resolveGridOverlayId(next);
      setGridOverlayId(resolved);
      setOverlayAnnouncement(
        resolved === NONE_OVERLAY_ID ? "Overlay off" : `Overlay: ${getGridOverlay(resolved)?.label ?? resolved}`,
      );
    },
    [setGridOverlayId],
  );
  // useCardLayoutPref's setter only accepts a direct value, so keyboard
  // handlers (registered outside cardLayout's dep array) read the latest
  // layout through this ref to avoid closing over a stale value.
  const cardLayoutRef = useRef(cardLayout);
  cardLayoutRef.current = cardLayout;

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
  // Mirror `allExpanded` into a ref so the single-key `e` shortcut handler
  // in the keydown effect below can read the current value without needing
  // to re-register every time a column or swimlane collapses or expands.
  // Page-level announcer for the bulk lane/column controls that unmount or live outside
  // any menu: the `e` shortcut and the collapsed-lanes strip button (#2338).
  const { message: bulkAnnouncement, announce: announceBulk } = useLiveAnnouncer();
  const allExpandedRef = useRef(allExpanded);
  allExpandedRef.current = allExpanded;


  const {
    savedFilters,
    loading: savedFiltersLoading,
    saveFilter,
    removeFilter,
    hydrateFilter,
    refreshFilters,
    onSavedFilterEvicted,
  } = useSavedFilters(board.id);

  // Set while this session's own settings modal is deleting the board (#2041).
  const selfDeletingRef = useRef(false);
  // Filled in below, once the drag state and the deferred resync exist.
  const onColumnLeftDoneRef = useRef<() => void>(() => {});
  const boardHasLinkedChildren = useCallback(
    () => !!boardRef.current?.cards.some((c) => c.parent),
    [],
  );
  const handleColumnUpdated = useCallback((column: Column) => {
    const wasDone = boardRef.current?.columns.find((c) => c.id === column.id)?.is_done;
    onColumnUpdated(column);
    if (wasDone && !column.is_done) onColumnLeftDoneRef.current();
    // A child's "N of M siblings done" counts cards in done columns, and the server sends the parent
    // board only `card.children_bulk_changed`. A flip here changes every sibling's line (#2443).
    if (!!wasDone !== !!column.is_done && boardHasLinkedChildren()) silentReloadRef.current();
  }, [onColumnUpdated, boardHasLinkedChildren]);
  // The archived-cards panel is not backed by board.cards, so it listens to
  // the card frames directly (#2062).
  const cardEventListeners = useRef(new Set<(event: BoardEvent) => void>());
  const subscribeCardEvents = useCallback((listener: (event: BoardEvent) => void) => {
    cardEventListeners.current.add(listener);
    return () => { cardEventListeners.current.delete(listener); };
  }, []);
  // `card.parent_changed {card_ids}` (#1104) carries ids only: `parent` is
  // computed per reader, so each card is re-read. A long list (a parent with
  // many children was renamed) re-reads the board instead of N cards. The
  // card detail's own link and unlink ask for the same refetch through the
  // `visiban:card-parent-refetch` window event.
  const parentReadSeqRef = useRef(new Map<number, number>());
  const refetchCardParents = useCallback((ids: readonly number[]) => {
    const boardId = boardRef.current?.id;
    if (boardId === undefined || ids.length === 0) return;
    if (ids.length > PARENT_REFETCH_MAX_CARDS) {
      silentReload();
      return;
    }
    // Reads race: a link then a quick unlink, or two pings close together, can
    // land out of order. Each read takes a per-card sequence number and only
    // the latest one for that card is applied, like silentReload's fetchSeqRef.
    const seqs = parentReadSeqRef.current;
    const issued = ids.map((id) => {
      const n = (seqs.get(id) ?? 0) + 1;
      seqs.set(id, n);
      return n;
    });
    void Promise.allSettled(ids.map((id) => getCardParent(boardId, id))).then((results) => {
      const parents = new Map<number, CardParent | null>();
      results.forEach((r, i) => {
        if (r.status === "fulfilled" && seqs.get(ids[i]) === issued[i]) parents.set(ids[i], r.value);
      });
      if (parents.size > 0) applyCardParents(parents);
    });
  }, [applyCardParents, silentReload]);
  // `card.parent_changed {card_ids, siblings: true}` (#2443): a write to one child changed the
  // "N of M siblings done" every other child of the same parent shows. The listed cards share
  // ONE parent, and `parent` is the same object on each of them for this reader (same parent,
  // same board, same roles), so one read is applied to all, however many siblings: no per-card
  // fan-out and no board reload. Only cards on this board are read. A representative that is
  // no longer a child (it was unlinked in between) says nothing about the rest, so they fall
  // back to their own reads.
  const refetchSiblingParents = useCallback((ids: readonly number[]) => {
    const boardId = boardRef.current?.id;
    const shown = new Set(boardRef.current?.cards.map((c) => c.id));
    const onBoard = ids.filter((id) => shown.has(id));
    if (boardId === undefined || onBoard.length === 0) return;
    const seqs = parentReadSeqRef.current;
    const issued = onBoard.map((id) => {
      const n = (seqs.get(id) ?? 0) + 1;
      seqs.set(id, n);
      return n;
    });
    const [first, ...rest] = onBoard;
    void getCardParent(boardId, first).then((parent) => {
      if (parent === null) {
        if (seqs.get(first) === issued[0]) applyCardParents(new Map([[first, null]]));
        refetchCardParents(rest);
        return;
      }
      const parents = new Map<number, CardParent | null>();
      onBoard.forEach((id, i) => { if (seqs.get(id) === issued[i]) parents.set(id, parent); });
      if (parents.size > 0) applyCardParents(parents);
    }, () => { /* a failed read keeps the last value; the next ping or resync retries */ });
  }, [applyCardParents, refetchCardParents]);
  // `card.children_changed {parent_id}` (#2210) carries ids only: the rollup
  // is computed per reader, so the parent card is re-read. Same per-card
  // sequence guard as the parent reads: only the latest read is applied.
  const rollupReadSeqRef = useRef(new Map<number, number>());
  // Parents with no rollup yet whose first read is in flight: their card shows
  // the footer skeleton (and announces "Loading children") instead of nothing.
  const [rollupLoadingIds, setRollupLoadingIds] = useState<ReadonlySet<number>>(() => new Set());
  const setRollupLoading = useCallback((id: number, on: boolean) => {
    setRollupLoadingIds((prev) => {
      if (prev.has(id) === on) return prev;
      const next = new Set(prev);
      if (on) next.add(id); else next.delete(id);
      return next;
    });
  }, []);
  const refetchChildrenRollup = useCallback((parentId: number) => {
    const boardId = boardRef.current?.id;
    if (boardId === undefined) return;
    const hasRollup = boardRef.current?.cards.find((c) => c.id === parentId)?.children_rollup !== undefined;
    if (!hasRollup && boardRef.current?.cards_can_have_children === true) setRollupLoading(parentId, true);
    const seqs = rollupReadSeqRef.current;
    const n = (seqs.get(parentId) ?? 0) + 1;
    seqs.set(parentId, n);
    void getCardChildrenRollup(boardId, parentId).then((r) => {
      if (seqs.get(parentId) !== n) return;
      if (r !== undefined) applyCardChildrenRollups(new Map([[parentId, r]]));
      setRollupLoading(parentId, false);
    }, () => {
      /* a failed read keeps the last rollup; the next ping or resync retries */
      if (seqs.get(parentId) === n) setRollupLoading(parentId, false);
    });
  }, [applyCardChildrenRollups, setRollupLoading]);
  // An unarchived card is appended with no `parent` (frames and write
  // responses never carry it) and applyCardParents skips ids not yet on the
  // board, so read it once the append is queued (#1104).
  // The same payload also carries no `children_rollup` (it is per reader), so
  // a restored or newly created parent card would show no footer until a
  // reload or a ping; read it too, on a parent-tier board only (#2210).
  const refetchRollupIfParentTier = useCallback((cardId: number) => {
    if (boardRef.current?.cards_can_have_children === true) refetchChildrenRollup(cardId);
  }, [refetchChildrenRollup]);
  const onCardUnarchived = useCallback((card: Card) => {
    unarchiveCard(card);
    refetchCardParents([card.id]);
    refetchRollupIfParentTier(card.id);
  }, [unarchiveCard, refetchCardParents, refetchRollupIfParentTier]);
  useEffect(() => {
    const onRefetch = (e: Event) => {
      const ids = (e as CustomEvent<{ cardIds?: number[] }>).detail?.cardIds;
      if (Array.isArray(ids)) refetchCardParents(ids.filter((id) => typeof id === "number"));
    };
    window.addEventListener(CARD_PARENT_REFETCH_EVENT, onRefetch);
    return () => window.removeEventListener(CARD_PARENT_REFETCH_EVENT, onRefetch);
  }, [refetchCardParents]);
  const handleSocketEvent = useCallback((event: BoardEvent) => {
    const d = event.data;
    // Order matters: notify the archived panel BEFORE the branches below evict
    // or archive the card from board.cards. Its card.deleted guard checks
    // board.cards to tell an active card (not its concern) from an archived
    // one, so it must still see the card as active (#2062).
    if (event.event === "card.archived" || event.event === "card.unarchived" || event.event === "card.deleted") {
      cardEventListeners.current.forEach((l) => l(event));
    }
    if (event.event === "card.created") {
      onCardAdded(d as unknown as Card);
      refetchRollupIfParentTier((d as unknown as Card).id);
    } else if (event.event === "card.moved") {
      // card.moved payload is { card, movement } — consistent with the REST
      // response — plus, since 1.3, sibling_positions: the cards the move
      // renumbered (#1890). A frame from an older server has no such key, and
      // only the card is applied, as before. The frame's event_id orders it
      // against other moves that set the same cards' positions.
      const moved = d as unknown as CardMovedEventPayload;
      onCardUpdated(moved.card, moved.sibling_positions, event.event_id);
    } else if (event.event === "card.updated") {
      const updatedCard = d as unknown as Card;
      onCardUpdated(updatedCard);
      // card.updated also fires for comment/checklist/attachment mutations
      // (they don't touch the card row itself, so there's no narrower signal
      // to key off) — nudge the open CardDetail panel to refetch those
      // collections when this is the card it has open (#1310).
      if (selectedCardIdRef.current === updatedCard.id) {
        setCardDetailRefreshTick((t) => t + 1);
      }
    } else if (event.event === "card.parent_changed") {
      const ids = (d as { card_ids?: unknown }).card_ids;
      // A large container rename (#2416) sends `reload: true` instead of every id.
      if ((d as { reload?: unknown }).reload === true) silentReload();
      else if (Array.isArray(ids) && (d as { siblings?: unknown }).siblings === true) {
        refetchSiblingParents(ids.filter((id): id is number => typeof id === "number"));
      } else if (Array.isArray(ids)) refetchCardParents(ids.filter((id): id is number => typeof id === "number"));
    } else if (event.event === "card.children_changed") {
      const parentId = (d as { parent_id?: unknown }).parent_id;
      if (typeof parentId === "number") {
        refetchChildrenRollup(parentId);
        // An ids-only ping (#2209 row 13): the open parent's Children tab re-reads over REST, where the
        // server resolves what this viewer may see. Nothing from the frame is shown.
        if (selectedCardIdRef.current === parentId) setChildrenRefreshTick((t) => t + 1);
      }
    } else if (event.event === "card.children_bulk_changed") {
      // A child-board column change (#2500): this board's parent ids, or `reload` above the cap.
      // Only ids shown here are read, each once, and above the same cap as the ids-list
      // `card.parent_changed` the board reloads instead of reading card by card.
      const ids = (d as { parent_ids?: unknown }).parent_ids;
      const open = selectedCardIdRef.current;
      if ((d as { reload?: unknown }).reload === true) {
        silentReload();
        // The open card's Children tab shows each child's column `is_done`; it re-reads over REST.
        if (open != null) setChildrenRefreshTick((t) => t + 1);
      } else if (Array.isArray(ids)) {
        const shown = new Set(boardRef.current?.cards.map((c) => c.id));
        const wanted = [...new Set(ids.filter((id): id is number => typeof id === "number" && shown.has(id)))];
        if (wanted.length > PARENT_REFETCH_MAX_CARDS) silentReload();
        else wanted.forEach((id) => refetchChildrenRollup(id));
        if (open != null && wanted.includes(open)) setChildrenRefreshTick((t) => t + 1);
      }
    } else if (event.event === "card.deleted") {
      evictCardByUid((d as { card_uid: string }).card_uid);
    } else if (event.event === "card.archived") {
      archiveCardByUid((d as { card_uid: string }).card_uid);
    } else if (event.event === "card.unarchived") {
      onCardUnarchived(d as unknown as Card);
    } else if (event.event === "column.created") {
      onColumnAdded(d as unknown as Column);
    } else if (event.event === "column.updated") {
      handleColumnUpdated(d as unknown as Column);
    } else if (event.event === "column.deleted") {
      // Use state-only eviction — the delete already happened on the server;
      // calling onColumnDeleted would fire a redundant DELETE API request.
      evictColumn((d as { column_uid: string }).column_uid);
    } else if (event.event === "column.reordered") {
      onColumnOrderApplied((d as { columns: Column[] }).columns);
    } else if (event.event === "swimlane.created") {
      onSwimlaneAdded(d as unknown as Swimlane);
    } else if (event.event === "swimlane.updated") {
      // Merge, never replace: the broadcast is built from the *public*
      // SwimlaneSerializer, so a straight replace would blank this admin's
      // contact_email, notes, and every admin-only row field value (#1140).
      onSwimlaneUpdated((b) => mergeSwimlaneFromBroadcast(
        b.swimlanes,
        d as unknown as Swimlane,
        b.swimlane_custom_field_definitions,
      ));
    } else if (event.event === "swimlane.deleted") {
      // Use state-only eviction — the delete already happened on the server;
      // calling onSwimlaneDeleted would fire a redundant DELETE API request.
      evictSwimlane((d as { swimlane_uid: string }).swimlane_uid);
    } else if (event.event === "swimlane.reordered") {
      onSwimlaneOrderApplied((d as { swimlanes: Swimlane[] }).swimlanes);
    } else if (event.event === "label.created") {
      onLabelAdded(d as unknown as Label);
    } else if (event.event === "label.updated") {
      onLabelUpdated(d as unknown as Label);
    } else if (event.event === "label.deleted") {
      onLabelDeleted((d as { label_uid: string }).label_uid);
    } else if (event.event === "custom_field.created") {
      // An upsert, not an append: a `/full/` response replays this updater
      // over its snapshot, which may already list the field (#2130), and the
      // Fields tab may have added it from its own create response.
      const created = d as unknown as CustomFieldDefinition;
      onCustomFieldDefinitionsApplied((prev) => (
        prev.some((f) => f.id === created.id) ? prev.map((f) => (f.id === created.id ? created : f)) : [...prev, created]
      ));
    } else if (event.event === "custom_field.updated") {
      const updated = d as unknown as CustomFieldDefinition;
      onCustomFieldDefinitionsApplied((prev) => prev.map((f) => (f.id === updated.id ? updated : f)));
    } else if (event.event === "custom_field.deleted") {
      const { custom_field_uid } = d as { custom_field_uid: string };
      onCustomFieldDefinitionsApplied((prev) => prev.filter((f) => f.uid !== custom_field_uid));
    } else if (event.event === "custom_field.reordered") {
      onCustomFieldDefinitionsApplied((d as { custom_fields: CustomFieldDefinition[] }).custom_fields);
    } else if (event.event === "swimlane_custom_field.created") {
      // An upsert, like custom_field.created above (#2130).
      const created = d as unknown as SwimlaneCustomFieldDefinition;
      onSwimlaneFieldDefinitionsApplied((prev) => (
        prev.some((f) => f.id === created.id) ? prev.map((f) => (f.id === created.id ? created : f)) : [...prev, created]
      ));
    } else if (event.event === "swimlane_custom_field.updated") {
      const updated = d as unknown as SwimlaneCustomFieldDefinition;
      onSwimlaneFieldDefinitionsApplied((prev) => prev.map((f) => (f.id === updated.id ? updated : f)));
    } else if (event.event === "swimlane_custom_field.deleted") {
      const { swimlane_custom_field_uid } = d as { swimlane_custom_field_uid: string };
      onSwimlaneFieldDefinitionsApplied((prev) => prev.filter((f) => f.uid !== swimlane_custom_field_uid));
    } else if (event.event === "swimlane_custom_field.reordered") {
      onSwimlaneFieldDefinitionsApplied(
        (d as { swimlane_custom_fields: SwimlaneCustomFieldDefinition[] }).swimlane_custom_fields
      );
    } else if (event.event === "member.added") {
      onMemberAdded(d as unknown as BoardMembership);
      if (!("is_site_admin" in d) || allContentUnknown((d as unknown as BoardMembership).user.id)) reloadForMemberFlag([(d as unknown as BoardMembership).user.id]);
      // Joined through an invite (#1444): that invite is now used.
      if ((d as { invite?: unknown }).invite) setInviteReloadSignal((n) => n + 1);
    } else if (event.event === "invite_link.created" || event.event === "invite_link.revoked") {
      // Refetch signal only ({id}); the admin-only list is re-read by the
      // Members tab when it is open.
      setInviteReloadSignal((n) => n + 1);
    } else if (event.event === "member.updated") {
      const updatedMembership = d as unknown as BoardMembership;
      onMemberUpdated(updatedMembership);
      if (!("is_site_admin" in updatedMembership) || allContentUnknown(updatedMembership.user.id)) reloadForMemberFlag([updatedMembership.user.id]);
      // If the role change affects the current user, sync current_user_role
      // immediately. Without this, canEdit/isAdmin are computed from the stale
      // value set during the last /full/ fetch and the user retains the wrong
      // UI affordances until they reload the page.
      if (currentUser && updatedMembership.user.id === currentUser.id) {
        mergeBoardState({ current_user_role: updatedMembership.role });
        // Refetch on a self-role change (#1140). Swimlane state is *merged*
        // from broadcasts rather than replaced, precisely so an admin does not
        // lose their admin-only row values on an unrelated edit — but that
        // same merge would otherwise keep those values alive in the tab of a
        // user who has just been demoted out of admin, since the socket is
        // only closed on removal from the board, never on a downgrade. A
        // refetch reissues /full/ under the new role, and the server then
        // simply does not send what they may no longer see.
        silentReload();
      }
    } else if (event.event === "member.removed") {
      onMemberRemoved((d as { user_id: number }).user_id);
    } else if (event.event === "board.updated") {
      // Another user changed board-level settings — merge the patch into local
      // state without calling the API. The mutation already happened on the
      // server; onUpdateBoardSettings would fire a redundant PATCH request.
      // is_starred in this payload is the ACTING user's value (#1559); drop it
      // so another user's edit cannot flip this viewer's star.
      mergeBoardState(stripPerUserBoardFields(d as Partial<typeof board>));
    } else if (event.event === "share_link.updated") {
      // Admin-only frame (#1967): the server sends it to admin sockets only,
      // because board.updated never carries the share fields. Merging it
      // keeps this tab's share state current, including an open Sharing tab,
      // when another admin revokes or rotates the link or it lapses
      // server-side. Never carries the token.
      const sharePayload = d as unknown as ShareLinkUpdatedPayload;
      mergeBoardState(shareLinkPatchFromEvent(sharePayload));
      // Rotation signal for an open Sharing tab's one-time reveal: kept beside
      // board state, not in it (BoardFull mirrors the /full/ serializer).
      const issuedAt = shareLinkIssuedAtFromEvent(sharePayload);
      if (issuedAt !== null) setShareLinkIssuedAt(issuedAt);
    } else if (event.event === "webhook.changed") {
      // Admin-only invalidation (#2057): the Webhooks tab refetches its list.
      // Ids and codes only; nothing here is merged into board state.
      const change = d as unknown as WebhookChangedPayload;
      setWebhookChange((prev) => ({ ...change, seq: (prev?.seq ?? 0) + 1 }));
    } else if (event.event === "board.deleted") {
      // Deleted by someone else: re-read over REST so the 404 swaps in the
      // "isn't available" page (#2041). The deleter's own session also gets
      // this event, but it navigates back itself (BoardSettingsModal), so it
      // keeps the old path; otherwise it would flash the unavailable page.
      if (selfDeletingRef.current) onBoardDeleted?.();
      else silentReload();
    } else if (event.event === "board.star_changed") {
      // Star is per-user state; only apply when the event belongs to the
      // current user's session (e.g. another tab for the same user).
      const payload = d as { user_id?: number; is_starred?: boolean };
      if (currentUser && payload.user_id === currentUser.id) {
        mergeBoardState({ is_starred: !!payload.is_starred });
      }
    } else if (event.event === "saved_filter.created") {
      // Broadcast payload is {filter_id, user_id} only — the full state_json is not
      // broadcast to all board members. Refetch the filter list for the owning user's
      // other sessions; other members' lists are unaffected.
      const payload = d as { filter_id: number; user_id: number };
      if (currentUser && payload.user_id === currentUser.id) {
        refreshFilters();
      }
    } else if (event.event === "saved_filter.deleted") {
      const payload = d as { filter_id: number; user_id: number };
      if (currentUser && payload.user_id === currentUser.id) {
        onSavedFilterEvicted(payload.filter_id);
      }
    } else if (event.event === "lens_connection.configured") {
      // Lens config is board-wide; reflect changes from other admins' sessions.
      // Tab visibility (gitLensEnabled && lensConnection !== null) handles the flag.
      setLensConnection(d as unknown as LensConnection);
    } else if (event.event === "lens_connection.removed") {
      setLensConnection(null);
    }
  }, [refetchCardParents, refetchSiblingParents, refetchChildrenRollup, refetchRollupIfParentTier, onCardAdded, onCardUpdated, onCardUnarchived, evictCardByUid, archiveCardByUid, onColumnAdded, handleColumnUpdated, evictColumn, onColumnOrderApplied, onSwimlaneAdded, onSwimlaneUpdated, evictSwimlane, onSwimlaneOrderApplied, onLabelAdded, onLabelUpdated, onLabelDeleted, onCustomFieldDefinitionsApplied, silentReload, reloadForMemberFlag, allContentUnknown, onSwimlaneFieldDefinitionsApplied, onMemberAdded, onMemberUpdated, onMemberRemoved, mergeBoardState, onBoardDeleted, currentUser, refreshFilters, onSavedFilterEvicted]);

  // Collect a subset of WS events into the activity feed for the drawer.
  // Runs alongside handleSocketEvent — does not interfere with board state updates.
  const collectActivityEvent = useCallback((event: BoardEvent) => {
    let entry: ActivityEntry | null = null;
    const d = event.data as Record<string, unknown>;
    if (event.event === "card.moved") {
      // In-stage moves carry no `movement` (#1102); the helper names the sub-column.
      entry = { id: crypto.randomUUID(), timestamp: new Date(), kind: "move", ...cardMovedActivity(d) };
    } else if (event.event === "card.created") {
      const card = d as { title?: string; created_by?: { display_name?: string } };
      entry = {
        id: crypto.randomUUID(),
        timestamp: new Date(),
        kind: "create",
        actor: card.created_by?.display_name ?? "Someone",
        headline: `created ${card.title ?? "a card"}`,
        subject: card.title,
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

  // Lens filter-row visibility (mirrors the board's local `showFilters`). Opens on
  // mount when a shared link already carries an active lens filter.
  const [lensShowFilters, setLensShowFilters] = useState(() => lensFilterActiveCount(searchParams) > 0);
  const [lensLaneCount, setLensLaneCount] = useState<number | undefined>(undefined);
  const [activeCard, setActiveCard] = useState<Card | null>(null);
  const [activeColumn, setActiveColumn] = useState<Column | null>(null);
  // Alt-gating for the column trash zone (#965). The destructive drop target
  // only appears while a column drag is in progress *and* the user holds ⌥
  // (Alt). Reorder and delete should not look like the same gesture.
  const [altHeldDuringColumnDrag, setAltHeldDuringColumnDrag] = useState(false);
  const [activeSwimlane, setActiveSwimlane] = useState<Swimlane | null>(null);
  // Reconnect resync (#1463) waits for any in-flight drag to finish so the
  // refetch cannot replace board state under the dragged item.
  const reconnectResync = useDeferredResync(
    silentReload,
    activeCard !== null || activeColumn !== null || activeSwimlane !== null,
  );
  // Cards in a done column carry no `column_entered_at`, and no card event follows a
  // change to the column's flag, so the dwell overlay (#459) would leave a column blank
  // after it stops being done. Nothing else reads the field, so with the overlay off this
  // only remembers that a re-read is owed, and the reload waits for a drag like any other.
  const dwellOverlayActive = gridOverlay?.id === dwellOverlay.id;
  const columnEntryStaleRef = useRef(false);
  onColumnLeftDoneRef.current = () => {
    if (dwellOverlayActive) reconnectResync();
    else columnEntryStaleRef.current = true;
  };
  useEffect(() => {
    if (dwellOverlayActive && columnEntryStaleRef.current) {
      columnEntryStaleRef.current = false;
      reconnectResync();
    }
  }, [dwellOverlayActive, reconnectResync]);
  // The server closes with a plain 1000 when this user is removed from the
  // board; re-read so the REST 404 swaps in the unavailable page (#2041). Not
  // while this session is itself deleting the board.
  const onServerClose = useCallback(() => {
    if (!selfDeletingRef.current) silentReload();
  }, [silentReload]);
  // First open (#1968): reuses the reconnect path (drag-deferred silentReload)
  // when the load-to-connect gap was long enough to have lost frames; see
  // FIRST_OPEN_RESYNC_MS. An unknown fetch time counts as a long gap.
  //
  // The socket is already in the broadcast group when this runs, so every
  // later commit arrives as a frame and the re-read's snapshot includes what
  // the gap dropped. A card frame that lands while the re-read is in flight is
  // kept over an older snapshot copy by useBoard's mergeFullSnapshot (#2038),
  // and any other frame is replayed over the snapshot (#2130), as on every
  // reconnect and tab-focus resync.
  const lastFullFetchAtRef = useRef(getLastFullFetchAt);
  lastFullFetchAtRef.current = getLastFullFetchAt;
  const onFirstConnected = useCallback(() => {
    const fetchedAt = lastFullFetchAtRef.current?.() ?? null;
    if (fetchedAt === null || Date.now() - fetchedAt > FIRST_OPEN_RESYNC_MS) reconnectResync();
  }, [reconnectResync]);
  const onReconnected = useCallback(() => {
    reconnectResync();
    setSocketReconnectSeq((n) => n + 1);
  }, [reconnectResync]);
  const { status: socketStatus, lastEventAt: socketLastEventAt, reconnectAttempt: socketReconnectAttempt } = useBoardSocket(board.id, combinedSocketHandler, { onReconnected, onFirstConnected, onServerClose });
  // Access loss reaches the client as a 4001/4003 close (status "failed") or,
  // for a direct member removal, a server-sent 1000 (onServerClose above).
  // Re-read the board over REST so a revoked or deleted board swaps in the
  // "isn't available" page (#2041) instead of sitting on a dead, stale board;
  // a 200 means the failure was something else (the session probe owns
  // sign-out) and changes nothing. Skipped while this session is deleting the
  // board itself, whose own flow navigates away.
  useEffect(() => {
    if (socketStatus === "failed" && !selfDeletingRef.current) silentReload();
  }, [socketStatus, silentReload]);
  // Offline pauses moves (#2325, spec § States): while the socket is down, drag is off
  // and every Move path (card menu, bulk toolbar, card detail and peek Move) is disabled
  // with this reason in text, so a move never lands on a board others changed meanwhile.
  // Same states as the offline banner, which says so.
  const movesPaused = socketStatus === "reconnecting" || socketStatus === "failed";
  movesPausedRef.current = movesPaused;
  // The "Move anyway" toast lives in App, outside this socket's reach: dismiss a held refusal
  // when moves pause so its override cannot retry on a board that may have changed.
  useEffect(() => {
    if (movesPaused && moveError) clearMoveError();
  }, [movesPaused, moveError, clearMoveError]);
  const [dndAnnouncement, setDndAnnouncement] = useState("");
  const dndHoverThrottleRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [selectedCard, setSelectedCard] = useState<Card | null>(null);
  // Card peek (#2273): the read-only side sheet that Shift+click, Shift+Enter and Show summary open. Open card
  // hands the card to selectedCard (the full detail sheet); the two never show
  // together, and neither does the peek with the activity drawer.
  const [peekCardId, setPeekCardId] = useState<number | null>(null);
  // Bumped whenever a `card.updated` socket event arrives for the currently
  // open card, so CardDetail can refetch its comments/checklist/attachments
  // without the whole panel remounting (#1310).
  const [cardDetailRefreshTick, setCardDetailRefreshTick] = useState(0);
  // Bumped by a `card.children_changed` or `card.children_bulk_changed` (#2500) ping for the open card, so only its Children tab re-reads (#2209).
  const [childrenRefreshTick, setChildrenRefreshTick] = useState(0);
  // Mirrors selectedCard's id into a ref so handleSocketEvent (defined above,
  // before selectedCard exists) can consult it without joining the callback's
  // dependency array — the same forward-reference pattern focusedSwimlaneIdRef
  // uses below for the "e" shortcut handler.
  const selectedCardIdRef = useRef<number | null>(null);
  selectedCardIdRef.current = selectedCard?.id ?? null;
  const [highlightedCardId, setHighlightedCardId] = useState<number | null>(null);
  // Refs for the two card-lookup timers (fade + not-found banner). Cleaned up on
  // unmount so setState never runs after teardown (#870).
  const highlightedCardTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // A `warning` toast for 4 s (#2107, was an in-flow notice). Used for a deep link
  // to a card that is not on the board, and when the open card leaves the board
  // (#1615). Keyed so a second one replaces the first.
  const showCardNotFound = useCallback((msg: string) => {
    notifyToast({ key: CARD_NOT_FOUND_TOAST_KEY, variant: "warning", title: msg, durationMs: 4000, testId: "card-not-found-toast" });
  }, [notifyToast]);
  useEffect(() => {
    return () => {
      if (highlightedCardTimerRef.current !== null) {
        clearTimeout(highlightedCardTimerRef.current);
        highlightedCardTimerRef.current = null;
      }
      // #1305 — found via the timer-ref audit: this one's callback only nulls
      // itself out (no setState), so it was never a setState-after-unmount
      // risk, but it's still a dangling timer left running past teardown.
      if (dndHoverThrottleRef.current !== null) {
        clearTimeout(dndHoverThrottleRef.current);
        dndHoverThrottleRef.current = null;
      }
    };
  }, []);

  // Alt key tracking during a column drag (#965). The listeners only register
  // while a column drag is in progress, keeping the global key handler footprint
  // empty at rest. `keydown` fires repeatedly while held — we still toggle once
  // and let `keyup` flip back. Drop on `blur` to handle Cmd-Tab away mid-drag.
  useEffect(() => {
    if (!activeColumn) {
      if (altHeldDuringColumnDrag) setAltHeldDuringColumnDrag(false);
      return;
    }
    const onDown = (e: KeyboardEvent) => {
      if (e.altKey) setAltHeldDuringColumnDrag(true);
    };
    const onUp = (e: KeyboardEvent) => {
      if (!e.altKey) setAltHeldDuringColumnDrag(false);
    };
    const onBlur = () => setAltHeldDuringColumnDrag(false);
    document.addEventListener("keydown", onDown);
    document.addEventListener("keyup", onUp);
    window.addEventListener("blur", onBlur);
    return () => {
      document.removeEventListener("keydown", onDown);
      document.removeEventListener("keyup", onUp);
      window.removeEventListener("blur", onBlur);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- onDown/onUp/onBlur are recreated each run but only read activeColumn via closure
  }, [activeColumn]);

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
  // Mirror focusedSwimlaneId into a ref so the `e` shortcut can consult the
  // current focus state without forcing the keydown listener to re-subscribe
  // every time the URL changes.
  const focusedSwimlaneIdRef = useRef(focusedSwimlaneId);
  focusedSwimlaneIdRef.current = focusedSwimlaneId;

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

  // Open Board settings → Webhooks from ?settings=webhooks, the deep link a
  // webhook_disabled notification carries (#863). The param is always
  // stripped; a non-admin (or the demo, where the tab does not exist) sees no
  // error, just the board.
  useEffect(() => {
    // ?settings=rules (#2448) is the "Change on X" link in another board's Child
    // cards blockers: it opens this board's Rules tab, same admin-only silence.
    const target = searchParams.get("settings");
    if (target !== "webhooks" && target !== "rules") return;
    if (!isRouteBoard) return;
    if (isAdmin && !demoMode) {
      setSettingsInitialTab(target);
      if (target === "webhooks") setWebhookDeepLink(true);
      setShowSettings(true);
    }
    setSearchParams((prev) => { prev.delete("settings"); return prev; }, { replace: true });
  }, [isAdmin, demoMode, isRouteBoard, searchParams, setSearchParams]);

  // Auto-open card from ?card= query param (e.g. from notification deep-link).
  // When the card is not in the active board view, call the /status/ endpoint to
  // distinguish "archived" (show targeted message) from "deleted/missing" (generic).
  useEffect(() => {
    const cardId = Number(searchParams.get("card"));
    if (!cardId || !isRouteBoard) return;
    const card = board.cards.find((c) => c.id === cardId);
    if (card) {
      // `&tab=comments|history|details` (#967) overrides the session's
      // remembered card tab; an unknown value keeps it, silently.
      const deepLinkTab = parseCardDetailTab(searchParams.get("tab"));
      if (deepLinkTab) {
        rememberCardDetailTab(deepLinkTab);
        setTabRequest((r) => ({ tab: deepLinkTab, n: (r?.n ?? 0) + 1 }));
      }
      // Children tab round trip (#2209): `from_parent` names the parent whose Children tab opened this
      // card, so its header offers "‹ <parent>"; `focus_child` is the child that link returns focus to.
      const fromParent = Number(searchParams.get("from_parent")) || null;
      const focusChild = Number(searchParams.get("focus_child")) || null;
      setChildrenNav(fromParent || focusChild ? { cardId, fromParent, focusChild } : null);
      setSelectedCard(card);
      setHighlightedCardId(cardId);
      if (highlightedCardTimerRef.current !== null) {
        clearTimeout(highlightedCardTimerRef.current);
      }
      highlightedCardTimerRef.current = setTimeout(() => {
        setHighlightedCardId(null);
        highlightedCardTimerRef.current = null;
      }, 1500);
      setSearchParams((prev) => { prev.delete("card"); prev.delete("tab"); prev.delete("from_parent"); prev.delete("focus_child"); if (!prev.has("view")) prev.set("view", "board"); return prev; }, { replace: true });
    } else {
      setSearchParams((prev) => { prev.delete("card"); prev.delete("tab"); prev.delete("from_parent"); prev.delete("focus_child"); if (!prev.has("view")) prev.set("view", "board"); return prev; }, { replace: true });
      // Check whether the card is archived so we can show a contextual message.
      getCardStatus(board.id, cardId)
        .then((status) => {
          showCardNotFound(
            status?.archived
              ? "This card has been archived."
              : "Card not found — it may have been deleted.",
          );
        })
        // Status lookup itself failed (e.g. network error) — fall back to the
        // generic missing-card message rather than leaving the user with no
        // feedback at all for their deep link.
        .catch(() => showCardNotFound("Card not found — it may have been deleted."));
    }
  }, [board.cards, board.id, isRouteBoard, searchParams, setSearchParams, showCardNotFound]);
  const [showAddColumn, setShowAddColumn] = useState(false);
  // When non-null, new column is inserted at this index (0 = first)
  const [insertPosition, setInsertPosition] = useState<number | null>(null);
  const [showAddSwimlane, setShowAddSwimlane] = useState(false);
  // When non-null, new swimlane is inserted at this index (0 = first)
  const [insertSwimlanePosition, setInsertSwimlanePosition] = useState<number | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  // Set only by the lane band shortcuts that open Board settings on the Swimlane fields tab: the legacy "N fields" grid's
  // "Change field order" link (#1458), the lane menu's "Change field order…", and the tiered details' manage link
  // (#2439); every other opener
  // leaves it undefined so Board settings opens on Members as before.
  const [settingsInitialTab, setSettingsInitialTab] = useState<"swimlane-fields" | "webhooks" | "fields" | "rules" | undefined>(undefined);
  // #863: set only by the ?settings=webhooks deep link from a webhook_disabled notification.
  const [webhookDeepLink, setWebhookDeepLink] = useState(false);
  const closeSettings = useCallback(() => {
    setShowSettings(false);
    setSettingsInitialTab(undefined);
    setWebhookDeepLink(false);
  }, []);
  // #2388 — the View menu's "On the card: ... Change" opens Board settings on Card fields.
  const openCardFields = useCallback(() => {
    setSettingsInitialTab("fields");
    setShowSettings(true);
  }, []);
  const openSwimlaneFieldOrder = useCallback(() => {
    setSettingsInitialTab("swimlane-fields");
    setShowSettings(true);
  }, []);

  // --- Issue board lens (read-only GitHub/GitLab mirror) ---
  // The Lens tab is shown only when the board has a lens connection AND the
  // current user has the git_lens_enabled feature flag. We fetch the connection
  // once per board (skipped entirely when the flag is off) so the tab and the
  // Board Settings entry know whether a lens exists.
  const gitLensEnabled = currentUser?.git_lens_enabled ?? false;
  const [lensConnection, setLensConnection] = useState<LensConnection | null>(null);
  const [showLensModal, setShowLensModal] = useState(false);
  useEffect(() => {
    if (!gitLensEnabled) {
      setLensConnection(null);
      return;
    }
    let cancelled = false;
    getLensConnection(board.id)
      .then((conn) => { if (!cancelled) setLensConnection(conn); })
      .catch(() => { if (!cancelled) setLensConnection(null); }); // 404 = no lens configured
    return () => { cancelled = true; };
  }, [board.id, gitLensEnabled]);
  const showLensTab = gitLensEnabled && lensConnection !== null;
  // #1063: mute the Board tab only for a lens-only board (zero native swimlanes).
  const deemphasizeBoardTab = showLensTab && isBoardTabDeemphasized(lensConnection, board.swimlanes.length);
  // Mirror into a ref so the bare-letter `l` shortcut handler (registered with a
  // narrow dep array) can consult the latest availability without re-subscribing.
  const showLensTabRef = useRef(showLensTab);
  showLensTabRef.current = showLensTab;

  // If the Lens tab disappears while it's active (flag flipped off, or the
  // connection was removed), fall back to the board view. Done in an effect so
  // we never call setState during render. `view` and `setView` are read from the
  // searchParams-derived values below; this effect is intentionally placed after
  // they are available (see the view derivation a few lines down).

  const { filters: persistedFilters, setFilters: setPersistedFilters } = usePersistedFilters(
    board.id,
    board.custom_field_definitions.filter((d) => d.show_on_card).map((d) => d.id),
  );

  // Parse filter state from URL params on mount; URL params override localStorage when present.
  const initialFilters = useMemo<typeof persistedFilters>(() => {
    const fAssignees = searchParams.get("f_assignees");
    const fLabels = searchParams.get("f_labels");
    const fPriorities = searchParams.get("f_priorities");
    const fDue = searchParams.get("f_due");
    const fSearch = searchParams.get("f_search");
    // #1149 — "Blocked only" travels in a shared filter link as f_blocked=1.
    const fBlocked = searchParams.get("f_blocked");
    // #2205 — lane rules travel as f_lanes=1.<compact JSON>, parsed defensively.
    const fLanes = searchParams.get("f_lanes");
    // #2214 — "Hide lanes with no matching cards" travels as its own param, so the
    // versioned f_lanes format (and older clients reading it) is untouched.
    const fHideUnmatched = searchParams.get("f_hide_unmatched");
    // #2209 — the Parent filter travels as f_parent=<card id>|any|none: the Children tab's "Open on <board>".
    const fParent = searchParams.get("f_parent");
    const hasUrlFilters = fAssignees !== null || fLabels !== null || fPriorities !== null || fDue !== null || fSearch !== null || fBlocked !== null || fLanes !== null || fHideUnmatched !== null || fParent !== null;
    if (!hasUrlFilters) return persistedFilters;
    const laneFilter = withHideUnmatched(parseLaneFilterParam(fLanes), fHideUnmatched === "1");
    const parentFilter = parseParentFilterParam(fParent);
    return {
      ...(laneFilter ? { laneFilter } : {}),
      ...(parentFilter !== undefined ? { parentFilter } : {}),
      search: fSearch ?? "",
      assigneeIds: fAssignees ? fAssignees.split(",").map(Number).filter((n) => !isNaN(n)) : [],
      labelIds: fLabels ? fLabels.split(",").map(Number).filter((n) => !isNaN(n)) : [],
      priorities: fPriorities
        ? (fPriorities.split(",").filter((v) => ["low", "medium", "high", "urgent"].includes(v)) as typeof persistedFilters["priorities"])
        : [],
      dueDate: (["overdue", "today", "this_week", "none"] as const).includes(fDue as never)
        ? (fDue as typeof persistedFilters["dueDate"])
        : null,
      // #371 — custom field filters aren't URL-shareable in this phase; a
      // URL-driven filter link never carries one, so it always starts empty.
      // The visible-controls set still carries over from localStorage so an
      // incoming filter link doesn't collapse whichever custom-field
      // controls the user already had open.
      customFields: {},
      visibleCustomFieldFilterIds: persistedFilters.visibleCustomFieldFilterIds,
      blockedOnly: fBlocked === "1",
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps -- only run on mount; searchParams and persistedFilters are stable on first render
  }, []);

  const [filters, setFiltersState] = useState(initialFilters);
  // setFilters accepts only a resolved value (it syncs to localStorage and
  // URL params), so palette-event handlers registered with a narrow dep array
  // read the latest filter state through this ref. It holds the pruned
  // (effective) filters so a handler that spreads them into a write cannot
  // copy a deleted label/field reference back to the URL or storage (#1928).
  const effectiveFiltersRef = useRef(filters);

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
        next.dueDate === null &&
        !next.blockedOnly;
      if (isEmptyFilter) {
        prev.delete("f_blocked");
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
        if (next.blockedOnly) prev.set("f_blocked", "1");
        else prev.delete("f_blocked");
      }
      const lanes = serializeLaneFilterParam(next.laneFilter);
      if (lanes) prev.set("f_lanes", lanes);
      else prev.delete("f_lanes");
      if (next.laneFilter?.hideUnmatched) prev.set("f_hide_unmatched", "1");
      else prev.delete("f_hide_unmatched");
      if (next.parentFilter !== undefined) prev.set("f_parent", String(next.parentFilter));
      else prev.delete("f_parent");
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

  const [showFilters, setShowFilters] = useState(false);
  const filterBarFirstRef = useRef<HTMLButtonElement>(null);
  // Tracks which saved filter preset is currently active. Cleared to null whenever the
  // user edits any filter dimension manually — a manual edit means the preset no longer
  // represents the live filter state.
  const [activeFilterId, setActiveFilterId] = useState<number | null>(null);
  // Forwarded to SavedFiltersDropdown so the "+ Save current" pill in SavedFilterTabs can
  // programmatically open the dropdown's save flow without duplicating the save-form UI.
  const savedFiltersDropdownTriggerRef = useRef<HTMLButtonElement>(null);
  // #2274 — one drawer, two tabs. null = closed. Archived cards live in its
  // Archived tab, so Y / the View menu / the archive toast open that tab.
  const [drawerView, setDrawerView] = useState<DrawerTab | null>(null);
  // Structural exclusion with the card sheet (#2274): the drawer is never open
  // while a card is selected, whatever order the two states change in.
  const drawerOpen = drawerView !== null && selectedCard === null;
  const setDrawerOpen = useCallback(
    (v: boolean | ((p: boolean) => boolean)) =>
      setDrawerView((cur) => ((typeof v === "function" ? v(cur !== null) : v) ? (cur ?? "recent") : null)),
    [],
  );
  const [activityFeed, setActivityFeed] = useState<ActivityEntry[]>([]);
  const [showShortcuts, setShowShortcuts] = useState(false);
  const showArchived = drawerView === "archived" && selectedCard === null;
  const setShowArchived = useCallback(
    (v: boolean | ((p: boolean) => boolean)) =>
      setDrawerView((cur) => ((typeof v === "function" ? v(cur === "archived") : v) ? "archived" : cur === "archived" ? null : cur)),
    [],
  );
  const [showExport, setShowExport] = useState(false);
  // #843 — close the standalone export modal if a board.updated broadcast
  // raises the threshold above the user's role while they have the modal
  // open. Without this, a non-admin sees an Export button that silently
  // 403s when clicked.
  useEffect(() => {
    if (showExport && !canExport) setShowExport(false);
  }, [showExport, canExport]);
  const [overflowSeen, markOverflowSeen] = useOverflowSeenPref();
  const [overflowOpen, setOverflowOpen] = useState(false);
  const isLargeViewport = useIsLargeViewport();
  // Phones (#2340): one Filter button opens both panels. Its "View options" button hands
  // the Filter trigger to the View panel, which anchors to it and returns focus there.
  const filterTriggerRef = useRef<HTMLButtonElement | null>(null);
  const [viewOpenRequest, setViewOpenRequest] = useState(0);
  const openViewFromFilter = useCallback((trigger: HTMLButtonElement) => {
    filterTriggerRef.current = trigger;
    setViewOpenRequest((n) => n + 1);
  }, []);
  const [confirmDeleteColumn, setConfirmDeleteColumn] = useState<Column | null>(null);
  // A drop into a confirm-on-entry column waiting on its checklist (#1101).
  const [pendingPolicyMove, setPendingPolicyMove] = useState<{
    cardId: number; columnId: number; swimlaneId: number; position: number; gatesPassed?: number;
  } | null>(null);
  // Name-typed confirmation input for column delete (#965). Only required when the
  // column has cards — empty columns keep the simple Cancel/Delete flow. Reset on
  // every open/close of the dialog.
  const [deleteColumnInput, setDeleteColumnInput] = useState("");
  // Derive view from ?view= search param; any unrecognised value falls back to "board".
  // Using replace: true when switching tabs so the browser Back button skips tab transitions
  // and users can bookmark/share a specific sub-view URL.
  const VALID_VIEWS = ["board", "summary", "history", "analytics", "lens"] as const;
  const rawView = searchParams.get("view");
  // #1063: with no explicit ?view=, land on the Lens when one is configured; an
  // explicit ?view=board (the user clicked Board) is always honored.
  // A ?card= / ?focus= deep link targets native content, so it keeps the Board default.
  const hasNativeDeepLink = searchParams.has("card") || searchParams.has("focus");
  const defaultView: BoardViewName = showLensTab && !hasNativeDeepLink ? "lens" : "board";
  const view: BoardViewName = (VALID_VIEWS as readonly string[]).includes(rawView ?? "") ? (rawView as BoardViewName) : defaultView;
  // Assign-on-render ref (same pattern as cardLayoutRef) so the keydown handler
  // can route `f` to the lens filter row when the lens tab is showing without
  // re-subscribing. Must sit AFTER `view` is derived — `view` is a plain const,
  // so reading it earlier is a temporal-dead-zone crash that tsc cannot see.
  const viewRef = useRef(view);
  viewRef.current = view;
  const setView = (v: BoardViewName) =>
    setSearchParams(
      (prev) => {
        prev.set("view", v);
        return prev;
      },
      { replace: true }
    );
  // Fall back to the board view if the Lens tab vanishes while it's active.
  useEffect(() => {
    if (view === "lens" && !showLensTab) {
      setSearchParams((prev) => { prev.set("view", "board"); return prev; }, { replace: true });
    }
    // setSearchParams is stable; view + showLensTab are the decision inputs.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- setSearchParams intentionally excluded, see comment above
  }, [view, showLensTab]);
  const [selectedCardIds, setSelectedCardIds] = useState<Set<number>>(new Set());
  const [hoveredSepIndex, setHoveredSepIndex] = useState<number | null>(null);
  const lastHoveredSwimlaneId = useRef<number | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [scrollEl, setScrollEl] = useState<HTMLDivElement | null>(null);
  useBoardPan(scrollEl);

  // "Card archived" is a `success` toast in the shared region (#2060,
  // frontend/CLAUDE.md § Toasts), keyed so a second archive replaces it. It
  // keeps its shipped 5 s rather than the 4 s success default, since it
  // carries an action to read and reach.
  const showArchiveToast = useCallback(() => {
    notifyToast({
      key: ARCHIVE_TOAST_KEY,
      variant: "success",
      title: "Card archived",
      durationMs: 5000,
      action: {
        label: "View in Archived",
        onAction: () => { setShowArchived(true); dismissToast(ARCHIVE_TOAST_KEY); },
      },
      testId: "archive-toast",
    });
  }, [notifyToast, dismissToast]);

  const toggleCardSelection = useCallback((cardId: number) => {
    setSelectedCardIds((prev) => {
      const next = new Set(prev);
      if (next.has(cardId)) next.delete(cardId);
      else next.add(cardId);
      return next;
    });
  }, []);

  const clearSelection = useCallback(() => setSelectedCardIds(new Set()), []);

  // A card can leave board.cards without this client acting on it: another
  // user deletes or archives it, or deletes the column or swimlane it was in
  // (the server sends only the container's *.deleted event for a cascade, no
  // per-card card.deleted, #1615). Close the detail panel on such a card, so
  // it does not keep editing a card that is gone (the bulk selection is pruned
  // the same way further down), and say why, since any unsaved draft in the
  // panel goes with it. Every path that opens CardDetail takes its card from
  // board.cards, which always holds every unarchived card on the board
  // (filters and search narrow what is rendered, not board.cards, and /full/
  // is not paginated), so a card absent from it has really left the board. A
  // delete or archive made from the panel itself closes it first, so this
  // effect does not fire for it.
  const selectedCardId = selectedCard?.id ?? null;
  // selectedCard is a snapshot taken when the panel opened. Hand CardDetail the
  // live copy from board.cards so a conflict refresh or forced move that
  // replaces the card reaches it (#1773); falls back to the snapshot for the
  // render before the not-found effect below closes the panel.
  const liveSelectedCard = selectedCard ? (board.cards.find((c) => c.id === selectedCard.id) ?? selectedCard) : null;
  const peekCard = peekCardId !== null ? (board.cards.find((c) => c.id === peekCardId) ?? null) : null;
  // Exclusivity (#2273): the detail sheet or the activity drawer opening closes
  // the peek; a card removed remotely closes it too.
  useEffect(() => {
    if (selectedCard || drawerOpen || showArchived || (peekCardId !== null && !peekCard)) setPeekCardId(null);
  }, [selectedCard, drawerOpen, showArchived, peekCardId, peekCard]);
  // The peek renders only in the board branch; leaving the board view ends it,
  // so returning does not reopen it and steal focus.
  useEffect(() => {
    if (view !== "board") setPeekCardId(null);
  }, [view]);
  useEffect(() => {
    if (selectedCardId === null) return;
    if (board.cards.some((c) => c.id === selectedCardId)) return;
    setSelectedCard(null);
    showCardNotFound("The card you had open was deleted or archived, so it was closed.");
  }, [board.cards, selectedCardId, showCardNotFound]);

  // ── Card context menu and ⌘K card actions (#2059) ──────────────────────
  // One executor for both surfaces. The menu opens from CardItem; the palette
  // reaches it through window events (§ Command palette ownership), asking
  // which cards it would act on with CARD_TARGET_QUERY_EVENT and dispatching
  // CARD_ACTION_EVENT. Availability comes from cardActionEntries(), the same
  // role gating as the bulk toolbar and the card detail sheet.
  const [cardMenu, setCardMenu] = useState<{ cardIds: number[]; originId: number; anchor: CardMenuAnchor } | null>(null);
  // Bumped by a ?card=&tab= deep link so an already-open card switches tab (#967).
  const [tabRequest, setTabRequest] = useState<{ tab: CardDetailTab; n: number } | undefined>(undefined);
  const [childrenNav, setChildrenNav] = useState<{ cardId: number; fromParent: number | null; focusChild: number | null } | null>(null);
  const [blockFormRequest, setBlockFormRequest] = useState<{ mode: "block" | "unblock"; seq: number } | null>(null);
  const [deleteTargetIds, setDeleteTargetIds] = useState<number[] | null>(null);
  // Outcome of a menu/palette action (#2059, #2107). A failure is a `danger`
  // toast (persists until dismissed, WCAG 2.2.1); a `shown` success is a
  // `success` toast, for an effect not visible on the board (Copy link, a delete
  // that removes the card). An `announced` success (Move, Assign, Priority,
  // Archive: the board itself changed in view) raises no toast, only the sr-only
  // status below. One key, so a later result replaces an earlier one.
  const [cardActionAnnouncement, setCardActionAnnouncement] = useState("");
  const cardActionStatusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The bulk toolbar's status slot (#2173), controlled here so a context-menu
  // or palette result over this same selection reports where the user is
  // already looking instead of in a toast above the toolbar.
  const [bulkMessage, setBulkMessage] = useState<string | null>(null);
  // A refusal describes the selection it was written for, so it is retired when
  // the selection gains a card it was not written for. A selection that only
  // SHRINKS keeps it: after a partial archive/delete the succeeded cards leave
  // the board, the prune effect drops them from the selection, and clearing
  // here would wipe the very failure text the user needs to read. (Deselecting
  // a card by hand also keeps it; emptying the selection unmounts the toolbar,
  // and a fresh selection starts from an empty slot because the ref is empty.)
  const prevSelectedIdsRef = useRef<Set<number>>(new Set());
  // Bumped whenever the selection gains a card or empties: an action that
  // started over an earlier selection compares it after its await and falls
  // back to the toast instead of writing its result under a different selection.
  const selectionGenRef = useRef(0);
  useEffect(() => {
    const prev = prevSelectedIdsRef.current;
    prevSelectedIdsRef.current = selectedCardIds;
    if (selectedCardIds.size === 0 || [...selectedCardIds].some((id) => !prev.has(id))) {
      selectionGenRef.current += 1;
      setBulkMessage(null);
    }
  }, [selectedCardIds]);
  useEffect(() => () => {
    if (cardActionStatusTimerRef.current !== null) clearTimeout(cardActionStatusTimerRef.current);
  }, []);
  // These two toasts belong to this board's view: they must not follow the user to
  // the next board or the dashboard (a danger toast never times out).
  useEffect(() => () => {
    dismissToast(CARD_ACTION_TOAST_KEY);
    dismissToast(CARD_NOT_FOUND_TOAST_KEY);
  }, [dismissToast]);
  // The toolbar is up exactly while a selection exists and the user can edit
  // (the render condition below); mirrored in a ref for the stable callbacks.
  const toolbarUpRef = useRef(false);
  // The clear-then-set tick of the toolbar message; cleared on unmount so a
  // pending set never lands on an unmounted board.
  const bulkMessageTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (bulkMessageTimerRef.current !== null) clearTimeout(bulkMessageTimerRef.current);
  }, []);
  toolbarUpRef.current = selectedCardIds.size > 0 && canEdit;
  const reportCardAction = useCallback((text: string, requested: "failed" | "shown" | "announced", selectionResult = false) => {
    // A failure or partial result of an action whose target set is the whole
    // selection goes to the toolbar's slot while it is up. A full success
    // clears the selection (unmounting the toolbar), so success still goes to
    // the toast or the announcer; a single card outside the selection keeps
    // the toast.
    if (selectionResult && requested === "failed" && toolbarUpRef.current) {
      dismissToast(CARD_ACTION_TOAST_KEY);
      // Clear first, then set on the next tick: an identical repeat message
      // would change nothing in the live region and so not be announced again.
      setBulkMessage(null);
      if (bulkMessageTimerRef.current !== null) clearTimeout(bulkMessageTimerRef.current);
      bulkMessageTimerRef.current = setTimeout(() => {
        bulkMessageTimerRef.current = null;
        setBulkMessage(text);
      }, 0);
      return;
    }
    // Announce-only is for a change visible on the board grid; from Summary,
    // History, Analytics or Lens the grid is not in view, so show it too.
    const kind = requested === "announced" && viewRef.current !== "board" ? "shown" : requested;
    if (cardActionStatusTimerRef.current !== null) clearTimeout(cardActionStatusTimerRef.current);
    cardActionStatusTimerRef.current = null;
    if (kind === "announced") {
      dismissToast(CARD_ACTION_TOAST_KEY);
      setCardActionAnnouncement(text);
      cardActionStatusTimerRef.current = setTimeout(() => {
        setCardActionAnnouncement("");
        cardActionStatusTimerRef.current = null;
      }, 4000);
      return;
    }
    setCardActionAnnouncement("");
    notifyToast({
      key: CARD_ACTION_TOAST_KEY,
      variant: kind === "failed" ? "danger" : "success",
      title: text,
      testId: "card-action-toast",
    });
  }, [notifyToast, dismissToast]);

  const isBoardModerator = board.members.some(
    (m) => currentUser != null && m.user.id === currentUser.id && m.is_moderator,
  );
  const cardActionContext: CardActionContext = {
    role: board.current_user_role,
    currentUserId: currentUser?.id ?? null,
    isModerator: isBoardModerator,
    demoMode,
    maintenanceBlocked: blockedByMaintenance,
    movesPaused,
  };
  // Latest state for the stable callbacks and window listeners below.
  const cardActionStateRef = useRef({ selectedCardIds, selectedCard, peekCardId, cardActionContext });
  cardActionStateRef.current = { selectedCardIds, selectedCard, peekCardId, cardActionContext };

  const openCardMenu = useCallback((card: Card, anchor: CardMenuAnchor) => {
    setCardMenu({ cardIds: contextMenuTargetIds(card.id, cardActionStateRef.current.selectedCardIds), originId: card.id, anchor });
  }, []);

  // Card face click (#2358): a plain click opens the detail panel (swapping it when
  // open), Shift+click opens the read-only peek. While the peek is open a plain
  // click swaps the peek; "Open card" is the way into the detail panel from it.
  const handleCardClick = (card: Card, opts?: { peek?: boolean }) => {
    clearSelection();
    if (selectedCard) { setSelectedCard(card); return; }
    setDrawerOpen(false);
    setShowArchived(false);
    if (opts?.peek || peekCardId !== null) { setPeekCardId(card.id); return; }
    setSelectedCard(card);
  };

  // Focus goes back to the card the menu was opened on (or the board region
  // when the action removed it), so a surface the action opens captures the
  // card as its opener and returns focus there on close (#1775).
  const focusCardOrBoard = (cardId: number) => {
    (findBoardCardElement(cardId) ?? document.querySelector<HTMLElement>(BOARD_SCROLL_SELECTOR))?.focus();
  };

  const runCardActionRef = useRef<(cardIds: number[], action: CardActionId, value?: number | string | null) => Promise<void>>(async () => {});
  runCardActionRef.current = async (cardIds, action, value) => {
    const current = boardRef.current;
    if (!current) return;
    const cards = cardIds.map((id) => current.cards.find((c) => c.id === id)).filter((c): c is Card => !!c);
    if (cards.length === 0) return;
    // Never run what the menu shows disabled; the server is still the authority.
    const entry = cardActionEntries(cards, cardActionStateRef.current.cardActionContext).find((e) => e.id === action);
    if (!entry?.enabled) return;
    const selected = cardActionStateRef.current.selectedCardIds;
    const startedGen = selectionGenRef.current;
    const wasWholeSelection = cards.length === selected.size && cards.every((c) => selected.has(c.id));
    // Evaluated when the result lands: a card added to the selection while the
    // request ran makes the selection a different one, so the result must not
    // be written under it (nor clear it).
    const isWholeSelection = () => wasWholeSelection && selectionGenRef.current === startedGen;
    const finish = (failure: string | null, success: string, alreadyShown = false) => {
      if (failure) { reportCardAction(failure, "failed", isWholeSelection()); return; }
      // Skip the result when another toast already reported and announced the same
      // outcome ("Card archived"), on the board view (a second live announcement) and
      // off it (a second toast).
      if (!alreadyShown) reportCardAction(success, "announced");
      // § Bulk operations rule 1: a selection clears only on full success.
      if (isWholeSelection()) clearSelection();
    };
    switch (action) {
      case "open":
      case "block":
      case "unblock": {
        clearSelection();
        setSelectedCard(cards[0]);
        // Only the board and analytics views render the card sheet.
        if (viewRef.current !== "board" && viewRef.current !== "analytics") setView("board");
        if (action !== "open") setBlockFormRequest({ mode: action, seq: Date.now() });
        return;
      }
      case "summary": {
        // The read-only peek (#2358): the touch and menu path to what Shift+click opens.
        clearSelection();
        setDrawerOpen(false);
        setShowArchived(false);
        setPeekCardId(cards[0].id);
        return;
      }
      case "copy-link": {
        try {
          await navigator.clipboard.writeText(cardLink(current.id, cards[0].id));
          reportCardAction(successMessage("copy-link", cards), "shown");
        } catch {
          reportCardAction("Couldn't copy the link. The browser blocked clipboard access.", "failed");
        }
        return;
      }
      case "move": {
        // A column id, or a sub-column stop of a split stage (MoveStop).
        const target = parseMoveChoice(value as number | string | null);
        const column = target ? current.columns.find((c) => c.id === target.columnId) : undefined;
        if (!target || !column) return;
        const r = await moveCardsToColumn(current.id, cards, column, cardActionStateRef.current.cardActionContext, target.gatesPassed);
        r.done.forEach((c) => onCardUpdated(c));
        notifyLeaveWarning(notifyToast, cards.filter((c) => r.done.some((d) => d.id === c.id)), current.columns, column.id);
        finish(r.failureMessage, successMessage("move", cards, column.name));
        return;
      }
      case "assign": {
        const userId = value == null ? null : Number(value);
        const member = current.members.find((m) => m.user.id === userId);
        const r = await assignCards(current.id, cards, userId, cardActionStateRef.current.cardActionContext);
        r.done.forEach((c) => onCardUpdated(c));
        finish(r.failureMessage, successMessage("assign", cards, member ? userDisplayName(member.user) : undefined));
        return;
      }
      case "priority": {
        const priority = String(value) as Card["priority"];
        const r = await setCardsPriority(current.id, cards, priority, cardActionStateRef.current.cardActionContext);
        r.done.forEach((c) => onCardUpdated(c));
        finish(r.failureMessage, successMessage("priority", cards, priority));
        return;
      }
      case "archive": {
        const r = await archiveCards(current.id, cards, cardActionStateRef.current.cardActionContext);
        r.done.forEach((id) => onCardArchived(id));
        if (r.done.length > 0) {
          showArchiveToast();
          // The archived face took focus with it; land on the board, not <body>.
          setTimeout(() => {
            if (document.activeElement === document.body) document.querySelector<HTMLElement>(BOARD_SCROLL_SELECTOR)?.focus();
          }, 0);
        }
        finish(r.failureMessage, successMessage("archive", cards), r.done.length > 0);
        return;
      }
      case "delete":
        setDeleteTargetIds(cards.map((c) => c.id));
        return;
    }
  };
  const runCardAction = useCallback(
    (cardIds: number[], action: CardActionId, value?: number | string | null) => runCardActionRef.current(cardIds, action, value),
    [],
  );

  const cardMenuRef = useRef(cardMenu);
  cardMenuRef.current = cardMenu;
  // Synchronous focus: on Tab the browser moves on from the card itself.
  // An outside press leaves focus wherever the press put it.
  const closeCardMenu = useCallback((reason: CardMenuCloseReason) => {
    const menu = cardMenuRef.current;
    if (menu && reason !== "outside") focusCardOrBoard(menu.originId);
    setCardMenu(null);
  }, []);

  // The palette's side of the contract: answer target queries, run actions.
  useEffect(() => {
    const onQuery = (ev: Event) => {
      const detail = (ev as CustomEvent<CardTargetQueryDetail>).detail;
      const current = boardRef.current;
      if (!detail || !current) return;
      const { selectedCardIds: sel, selectedCard: open, peekCardId: peeked, cardActionContext: ctx } = cardActionStateRef.current;
      const target = detail.cardIds
        ? { cardIds: detail.cardIds, source: "result" as const }
        : resolveCardTarget({
            // The peek withholds the context menu and the bulk selection, so the
            // peeked card is the palette's target while it is open (#2273).
            openCardId: open?.id ?? peeked,
            // A focused card counts only if it is on this board.
            focusedCardId: detail.focusedCardId != null && current.cards.some((c) => c.id === detail.focusedCardId) ? detail.focusedCardId : null,
            selectedIds: sel,
          });
      if (!target) { detail.response = null; return; }
      const cards = target.cardIds.map((id) => current.cards.find((c) => c.id === id)).filter((c): c is Card => !!c);
      if (cards.length === 0) { detail.response = null; return; }
      detail.response = {
        cardIds: cards.map((c) => c.id),
        source: target.source,
        summary: cardTargetSummary(cards, target.source),
        actions: cardActionEntries(cards, ctx),
      };
    };
    const onAction = (ev: Event) => {
      const detail = (ev as CustomEvent<CardActionDetail>).detail;
      if (!detail || !Array.isArray(detail.cardIds)) return;
      void runCardAction(detail.cardIds, detail.action, detail.value);
    };
    window.addEventListener(CARD_TARGET_QUERY_EVENT, onQuery);
    window.addEventListener(CARD_ACTION_EVENT, onAction);
    return () => {
      window.removeEventListener(CARD_TARGET_QUERY_EVENT, onQuery);
      window.removeEventListener(CARD_ACTION_EVENT, onAction);
    };
  }, [runCardAction]);

  // The menu is never left open over a card that is gone or a sheet that opened.
  useEffect(() => {
    if (cardMenu && (selectedCard || !board.cards.some((c) => c.id === cardMenu.originId))) setCardMenu(null);
  }, [cardMenu, selectedCard, board.cards]);
  // #2274 — the drawer and the card sheet (peek) never show together: opening
  // either closes the other. Each effect fires only on its own change, so the
  // one that was opened last wins.
  useEffect(() => { if (drawerView !== null) setSelectedCard(null); }, [drawerView]);
  useEffect(() => { if (selectedCard) setDrawerView(null); }, [selectedCard]);
  // Closing the drawer returns focus to the Activity button, or to the board
  // region if that button is not on the toolbar. A card opening closes it too;
  // then the sheet owns focus, and focus is left alone unless it was dropped.
  const activityButtonRef = useRef<HTMLButtonElement>(null);
  const drawerWasOpenRef = useRef(false);
  useEffect(() => {
    const wasOpen = drawerWasOpenRef.current;
    drawerWasOpenRef.current = drawerOpen;
    if (!wasOpen || drawerOpen || selectedCard) return;
    const a = document.activeElement;
    if (a && a !== document.body) return;
    const btn = activityButtonRef.current;
    if (btn && btn.isConnected) btn.focus();
    else document.querySelector<HTMLElement>("[data-board-scroll]")?.focus();
  }, [drawerOpen, selectedCard]);
  // A sheet closing ends its block-form request.
  useEffect(() => { if (!selectedCard) setBlockFormRequest(null); }, [selectedCard]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // ⌘\ / Ctrl+\ — toggle activity drawer (fires even from input fields)
      if ((e.metaKey || e.ctrlKey) && e.key === "\\") {
        e.preventDefault();
        setDrawerOpen((v) => !v);
        return;
      }
      // ⌘K handling lives in GlobalCommandPalette at the shell / board-page
      // level so it fires on every sub-tab and every authenticated route.
      // Do not re-register it here — the listener would fire twice. (#869)
      const tag = (e.target as HTMLElement).tagName;
      if (
        tag === "INPUT" ||
        tag === "TEXTAREA" ||
        tag === "SELECT" ||
        (e.target as HTMLElement).closest?.('[contenteditable="true"]')
      ) return;
      // An open Filter panel or View menu is a dialog over the board: focus on a
      // row or button inside it must not fire the board's single-key shortcuts
      // (h, a, e, y, f, /, .) behind it (#2301). Scoped to those popovers, not
      // every role="dialog", so the card detail's behavior is unchanged.
      if ((e.target as HTMLElement).closest?.('[data-shortcut-scope="popover"]')) return;
      // ⌘⇧E / Ctrl+Shift+E — open export modal (only when export is permitted)
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === "e" || e.key === "E")) {
        if (!canExport) return;
        e.preventDefault();
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
      // ⌘⇧L / Ctrl+Shift+L — toggle card layout (compact ↔ expanded). Uses
      // two modifiers deliberately: the `L` unshifted is a plain letter and
      // would clash with any future single-key shortcut, and card layout is
      // a low-frequency action where a richer chord is acceptable.
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === "l" || e.key === "L")) {
        e.preventDefault();
        setCardLayout(cardLayoutRef.current === "compact" ? "expanded" : "compact");
        return;
      }
      if (e.key === "b") {
        // View tabs: `b` Board, `s` Summary, `h` History, `a` Analytics.
        // Reuses setView's replace-history behavior so tab switching doesn't
        // pollute the browser back-button stack.
        e.preventDefault();
        setView("board");
        return;
      } else if (e.key === "s") {
        e.preventDefault();
        setView("summary");
        return;
      } else if (e.key === "h") {
        e.preventDefault();
        setView("history");
        return;
      } else if (e.key === "a") {
        e.preventDefault();
        setView("analytics");
        return;
      } else if (e.key === "l") {
        // `l` switches to the read-only Lens view — only when the tab is
        // actually available (lens connection present + git_lens_enabled).
        if (!showLensTabRef.current) return;
        e.preventDefault();
        setView("lens");
        return;
      } else if (e.key === "e") {
        // `e` collapses/expands everything — mirrors the SplitButton primary
        // (onCollapsePrimary) so there is a single source of "what does the
        // default collapse action do right now?". Uses refs so the listener
        // doesn't re-subscribe on every board or view-prefs identity change.
        e.preventDefault();
        const latestBoard = boardRef.current;
        if (focusedSwimlaneIdRef.current !== null) exitFocus();
        const collapsing = allExpandedRef.current;
        announceBulk(boardStateMessage(collapsing, latestBoard.swimlanes.length, latestBoard.columns.length));
        if (collapsing) {
          collapseAllColumns(latestBoard.columns.map((c) => c.id));
          collapseAllSwimlanes(latestBoard.swimlanes.map((s) => s.id));
        } else {
          expandAllColumns();
          expandAllSwimlanes();
        }
        return;
      } else if (e.key === "y") {
        // `y` toggles the Archived tab of the Activity drawer. Avoids `a` because that's
        // reserved for the Analytics view tab above.
        e.preventDefault();
        setShowArchived((v) => !v);
        return;
      }
      if (e.key === "f") {
        e.preventDefault();
        // The lens has its own filter row on the shared Row 2; `f` must toggle
        // whichever one is actually on screen. Without this the shortcut
        // silently toggled the hidden board row while the lens was showing.
        // Closing with focus inside the row would drop it to <body>; hand it to the
        // toolbar Filters trigger, matching the row's own hide button (#2459). The saved-filter
        // tab pills sit outside role="search" but unmount with the row, so they carry data-filter-row.
        const focusInRow = !!document.activeElement?.closest('[role="search"], [data-filter-row]');
        if (viewRef.current === "lens") {
          setLensShowFilters((v) => !v);
          if (focusInRow) focusFiltersTrigger();
          return;
        }
        setShowFilters((v) => {
          if (!v) {
            // Opening: focus first interactive element in the filter bar
            setTimeout(() => filterBarFirstRef.current?.focus(), 0);
          } else if (focusInRow) {
            focusFiltersTrigger();
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
      } else if (e.key === ".") {
        // Bare `.` — open the overflow menu. Guarded by the input-tag check
        // above so a period typed into a text field does not fire. 
        e.preventDefault();
        setOverflowOpen((v) => !v);
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
    // View-switch, collapse-toggle, archived-toggle, and card-layout handlers
    // all consume stable setState setters / useCallback-memoised board-pref
    // functions, and read board + focus state through refs, so the listener
    // never needs to re-subscribe when those inputs change. We pin only the
    // deps that actually change the handler's decision surface.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- see comment above; only the decision-surface deps are pinned
  }, [toggleCollapsedSwimlane, canExport, isAdmin, announceBulk]);

  // `?`, the account menu and the palette all go through the shell's one
  // shortcuts-help handler (#2473, ShortcutsHelpHost). On a board it asks here
  // first with a cancelable event; claiming it shows the board's full list,
  // so the shell's off-board help never opens on top of it.
  useEffect(() => {
    const open = (e: Event) => {
      e.preventDefault();
      setShowShortcuts(true);
    };
    window.addEventListener(SHOW_BOARD_SHORTCUTS_EVENT, open);
    return () => window.removeEventListener(SHOW_BOARD_SHORTCUTS_EVENT, open);
  }, []);

  // Replay the onboarding tour — best-effort reset on the server, then flip
  // the local user's has_completed_tour flag so the tour re-arms. Shared by
  // the Shortcuts overlay "Restart tour" button (the overflow menu no longer
  // carries a replay item); Settings has its own reset path.
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

  // Board-scoped palette actions are dispatched by GlobalCommandPalette as
  // window events so the palette owner does not need to reach into BoardView
  // internals. Each handler corresponds to an action surfaced in the palette
  // result list. (#869)
  useEffect(() => {
    const openCard = (ev: Event) => {
      const detail = (ev as CustomEvent<{ cardId: number }>).detail;
      if (!detail) return;
      const card = boardRef.current?.cards.find((c) => c.id === detail.cardId);
      if (card) {
        clearSelection();
        setSelectedCard(card);
        // The lens branch renders no CardDetail; a native card must open on the board.
        if (viewRef.current === "lens") setView("board");
      }
    };
    const filterMyCards = () => {
      if (!currentUser) return;
      setFilters({ ...effectiveFiltersRef.current, assigneeIds: [currentUser.id] });
      setShowFilters(true);
    };
    const showHistory = () => setView("history");
    const openSettings = () => setShowSettings(true);
    window.addEventListener("visiban:open-card", openCard);
    window.addEventListener("visiban:filter-my-cards", filterMyCards);
    window.addEventListener("visiban:show-history", showHistory);
    window.addEventListener("visiban:open-settings", openSettings);
    return () => {
      window.removeEventListener("visiban:open-card", openCard);
      window.removeEventListener("visiban:filter-my-cards", filterMyCards);
      window.removeEventListener("visiban:show-history", showHistory);
      window.removeEventListener("visiban:open-settings", openSettings);
    };
    // The listener captures `setView` from its closure; even though the
    // local `setView` identity changes per render, it always delegates to
    // the stable setSearchParams, so a captured-from-prior-render copy is
    // still correct. setFilters/setShowFilters/setShowSettings are stable
    // useState setters. boardRef tracks the latest board state so card
    // resolution works without re-registering on every cards-array change.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- see comment above; setView/setFilters/etc. are stable or ref-backed
  }, [currentUser?.id, clearSelection]);

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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- deliberately gated on board.id alone, see comment above (avoids the toggleCollapsedSwimlane <-> viewPrefs write loop)
  }, [board.id]);

  // Server-side text search — debounced 300ms, aborts stale requests.
  // searchMatchIds is null when query is empty or on error (silent fallback → show all cards).
  const { searchMatchIds, isSearching, truncation: searchTruncation } = useCardSearch(board.id, filters.search);

  // Search is handled server-side (useCardSearch → GET /api/boards/{id}/cards/?search=)
  // because it uses trigram indexes (migration 0030) for efficient title+description matching.
  // Assignee/label/priority/due-date filters run client-side against board.cards since all
  // cards are already loaded via the /full/ endpoint. The two results are intersected here.
  // Note: server search matches title+description only; client-side filterCards additionally
  // matches assignee name and label name — this is intentional (client has richer context).
  // Use the user's stored timezone so that "Today" / "Overdue" boundaries are computed
  // at midnight in their local time, not the browser's locale. Read on every render and
  // passed into the memo below as a dependency rather than called inside it: it is a
  // clock read, and caching it would freeze the day boundary for a session left open
  // across local midnight with a due-date filter active.
  const todayStr = todayInTimezone(userTimezone);

  // Memoized (#1147): this used to be a bare IIFE that allocated a fresh Set on every
  // render whenever a filter was active, which silently defeated any downstream useMemo
  // keyed on it — including the grid overlay's per-cell map.
  // A label, custom-field (#1928) or sub-column (#2367) filter naming one that no longer exists on the board (deleted
  // here or by another session; saved/persisted/URL filters can carry one)
  // would match no card and show no chip to dismiss (#1888). Ignore such ids
  // as a derived value only; they are never written back to the URL or
  // persisted state (BoardView stays mounted across a board switch with the
  // previous board's filters, so a write-back would copy them to the new board).
  const boardLabels = board.labels;
  const boardCustomFieldDefs = board.custom_field_definitions;
  // #2367 — a sub-column filter naming a removed sub-column is pruned like a deleted label.
  const boardColumns = board.columns;
  // #2205 — the swimlane fields this viewer may rule on; a lane rule on any
  // other field (deleted, or admin-only for a non-admin) is pruned the same way.
  const swimlaneFieldDefs = board.swimlane_custom_field_definitions;
  const laneFields = useMemo(() => laneFilterFields(swimlaneFieldDefs ?? [], isAdmin), [swimlaneFieldDefs, isAdmin]);
  const effectiveFilters = useMemo(() => {
    const pruned = pruneStaleFilters(filters, {
      labels: boardLabels,
      custom_field_definitions: boardCustomFieldDefs,
      columns: boardColumns,
    });
    const laneFilter = pruneLaneFilter(pruned.laneFilter, laneFields);
    if (laneFilter === pruned.laneFilter) return pruned;
    const next = { ...pruned, laneFilter };
    if (!laneFilter) delete next.laneFilter;
    return next;
  }, [filters, boardLabels, boardCustomFieldDefs, boardColumns, laneFields]);

  // #2205 / #2251 — lanes the lane rules reject. The rules decide WHICH lanes show; focus
  // mode decides which one is expanded. The focused lane always shows, even when it fails
  // the rules, so it is dropped from the hidden set (and from the "N lanes hidden" count).
  const laneRuleRejectedIds = useMemo(
    () => laneIdsHiddenByFilter(board.swimlanes, effectiveFilters.laneFilter, laneFields),
    [board.swimlanes, effectiveFilters.laneFilter, laneFields],
  );
  const focusedLaneFailsRules = focusedSwimlaneId !== null && laneRuleRejectedIds.has(focusedSwimlaneId);
  const laneFilterHiddenIds = useMemo(() => {
    if (!focusedLaneFailsRules) return laneRuleRejectedIds;
    const next = new Set(laneRuleRejectedIds);
    next.delete(focusedSwimlaneId as number);
    return next;
  }, [laneRuleRejectedIds, focusedLaneFailsRules, focusedSwimlaneId]);
  // #2337 — rules the stored filter carries on fields this viewer cannot use;
  // effectiveFilters drops them, and the lane filter popover says so.
  const ignoredLaneRuleCount = useMemo(
    () => countUnusableLaneRules(filters.laneFilter, swimlaneFieldDefs ?? [], isAdmin),
    [filters.laneFilter, swimlaneFieldDefs, isAdmin],
  );
  const laneFilterKey = useMemo(() => serializeLaneFilterParam(effectiveFilters.laneFilter) ?? "", [effectiveFilters.laneFilter]);
  const lanesTriggerRef = useRef<HTMLButtonElement>(null);
  const { notice: laneNotice, dismiss: dismissLaneNotice, markLocalEdit: markLaneLocalEdit } = useLaneFilterNotice({
    swimlanes: board.swimlanes,
    hiddenIds: laneFilterHiddenIds,
    filterKey: laneFilterKey,
    focusedSwimlaneId,
    // The peeked card counts too: focus sits in the sheet while it is open, so its lane would otherwise hide silently.
    openCardSwimlaneId: liveSelectedCard?.swimlane ?? peekCard?.swimlane ?? null,
  });
  // A lane edited from this client (row rename, field values) is "mine" for the notice.
  const handleLocalSwimlaneUpdated = useCallback((s: Swimlane) => {
    markLaneLocalEdit(s.id);
    onSwimlaneUpdated(s);
  }, [markLaneLocalEdit, onSwimlaneUpdated]);
  const openLaneFilters = useCallback(() => {
    setShowFilters(true);
    setTimeout(() => lanesTriggerRef.current?.click(), 0);
  }, []);

  effectiveFiltersRef.current = effectiveFilters;

  // Show chips (#2272): a quick view in the URL (`?show=`), deliberately not in
  // the persisted or saved filter state. It narrows the Filter panel's result
  // further, so both apply; column and lane counts keep reading the whole board.
  const showChip = parseShowChip(searchParams.get("show"));
  const setShowChip = useCallback((next: ShowChipKey) => {
    setSearchParams((prev) => {
      if (next === "all") prev.delete("show");
      else prev.set("show", next);
      return prev;
    }, { replace: true });
  }, [setSearchParams]);
  const showChipCountsValue = useMemo(
    () => showChipCounts(board.cards, board.columns),
    // todayStr: the clock read that moves the overdue boundary at local midnight.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- todayStr is a re-compute trigger, not an input
    [board.cards, board.columns, todayStr],
  );

  // The Filter panel and search result alone, before the Show chip narrows it.
  // `hiddenCount` and its "Clear" control belong to this set: a chip is cleared
  // from the Show row, not from the filter bar.
  const panelFilteredCardIds: Set<number> | null = useMemo(() => {
    const filters = effectiveFilters;
    const clientFiltersActive = hasActiveClientFilters(filters);
    if (!clientFiltersActive && searchMatchIds === null) return null;
    // Only server search is active — use its result directly as a Set.
    if (!clientFiltersActive && searchMatchIds !== null) return searchMatchIds;
    // filterCards handles the server search intersection via its searchResults param.
    return new Set(filterCards(board.cards, filters, searchMatchIds ? [...searchMatchIds] : null, todayStr, board.custom_field_definitions, new Set(board.columns.filter((c) => c.is_done).map((c) => c.id)), { columns: board.columns, swimlanes: board.swimlanes, definitions: board.custom_field_definitions }));
  }, [effectiveFilters, searchMatchIds, board.cards, board.columns, board.swimlanes, todayStr, board.custom_field_definitions]);

  const filteredCardIds: Set<number> | null = useMemo(() => {
    if (showChip === "all") return panelFilteredCardIds;
    const chipIds = showChipCardIds(board.cards, board.columns, showChip);
    if (panelFilteredCardIds === null) return chipIds;
    return new Set([...chipIds].filter((id) => panelFilteredCardIds.has(id)));
  }, [panelFilteredCardIds, board.cards, board.columns, showChip]);

  // #2324 — filters or a Show chip match no card: every lane shrinks to its band
  // ("No matching cards") and a panel below the lanes offers Show all cards.
  // Never on an empty board ("No cards yet" owns that) or when the lane rules hide
  // every lane ("No lanes match" owns that), so the three notices exclude each other.
  // #2214 — "Hide lanes with no matching cards": while a card filter or chip is
  // active, a lane with no matching card is hidden instead of shown empty (or as a
  // "No matching cards" band; one predicate, so the two cannot disagree). Kept apart
  // from laneFilterHiddenIds, which counts lanes the lane RULES hide. The focused
  // lane always shows, as it does for the rules.
  const hideUnmatchedLanes = effectiveFilters.laneFilter?.hideUnmatched === true;
  const unmatchedLaneIds = useMemo(() => {
    if (!hideUnmatchedLanes || filteredCardIds === null) return null;
    const matched = new Set(board.cards.filter((c) => filteredCardIds.has(c.id)).map((c) => c.swimlane));
    return new Set(board.swimlanes.filter((s) => !matched.has(s.id) && s.id !== focusedSwimlaneId).map((s) => s.id));
  }, [hideUnmatchedLanes, filteredCardIds, board.cards, board.swimlanes, focusedSwimlaneId]);
  const renderHiddenSwimlaneIds = useMemo(() => {
    if (laneFilterHiddenIds.size === 0 && !unmatchedLaneIds?.size) return hiddenSwimlaneIds;
    return new Set([...hiddenSwimlaneIds, ...laneFilterHiddenIds, ...(unmatchedLaneIds ?? [])]);
  }, [hiddenSwimlaneIds, laneFilterHiddenIds, unmatchedLaneIds]);
  // Every lane is hidden by the rules, by "hide unmatched", or one each. Requires the rules to hide at
  // least one lane: with none hidden by rules, an all-unmatched board is the no-match panel's job.
  // "Hide unmatched" completes the set only while some card matches: when no card matches, the no-match
  // panel (chip line, Show all cards) is the right recovery, not "No lanes match" with only Clear lane filters.
  const unmatchedCompletesLanes = (filteredCardIds?.size ?? 0) > 0;
  const laneHiddenByRulesOrUnmatched = (id: number) =>
    laneFilterHiddenIds.has(id) || (unmatchedCompletesLanes && (unmatchedLaneIds?.has(id) ?? false));
  const allLanesFilteredOut = board.swimlanes.length > 0 && laneFilterHiddenIds.size > 0
    && board.swimlanes.every((s) => laneHiddenByRulesOrUnmatched(s.id));
  const hiddenLaneTotal = board.swimlanes.filter((s) => laneHiddenByRulesOrUnmatched(s.id)).length;
  // The collapsed-lanes strip counts only lanes the reader can see collapsed:
  // focus collapses every other lane, including ones the lane rules or "hide unmatched" hide (#2251).
  const visibleCollapsedLaneCount = useMemo(
    () => [...collapsedSwimlaneIds].filter((id) => !laneFilterHiddenIds.has(id) && !(unmatchedLaneIds?.has(id) ?? false)).length,
    [collapsedSwimlaneIds, laneFilterHiddenIds, unmatchedLaneIds],
  );
  const noCardMatch = !allLanesFilteredOut && board.cards.length > 0 && filteredCardIds !== null && filteredCardIds.size === 0;
  const showAllCards = useCallback(() => {
    // Lane rules and "hide unmatched" are lane settings, not card filters: Show all cards keeps them.
    setFilters(filters.laneFilter ? { ...EMPTY_FILTER, laneFilter: filters.laneFilter } : EMPTY_FILTER);
    setActiveFilterId(null);
    setShowChip("all");
    // The button unmounts; land on the All cards chip rather than <body>.
    setTimeout(() => document.querySelector<HTMLElement>('[data-show-chip="all"]')?.focus(), 0);
  }, [setFilters, setShowChip, filters.laneFilter]);

  /**
   * #1147 — the active overlay's per-cell values for the whole grid, built once per
   * board render and handed down to every `SwimlaneRow`.
   *
   * Scope choices, both deliberate:
   *  - *hidden* columns/swimlanes are excluded, so a card parked in a column the user
   *    hid cannot inflate the scale and wash out every visible tint;
   *  - *collapsed* columns/swimlanes are NOT excluded — collapsing is a reading
   *    gesture, and re-scaling the whole board because a lane folded would make the
   *    tints untrustworthy.
   * Cards are the filtered (visible) set, so the overlay never contradicts the grid.
   */
  const gridOverlayState = useMemo(
    () =>
      buildGridOverlayState(gridOverlay, {
        columns: board.columns.filter((c) => !hiddenColumnIds.has(c.id)),
        swimlanes: board.swimlanes.filter((s) => !renderHiddenSwimlaneIds.has(s.id)),
        cards: filteredCardIds ? board.cards.filter((c) => filteredCardIds.has(c.id)) : board.cards,
        isFiltered: filteredCardIds !== null,
        now: gridOverlayNow,
      }),
    [gridOverlay, gridOverlayNow, board.columns, board.swimlanes, board.cards, hiddenColumnIds, renderHiddenSwimlaneIds, filteredCardIds],
  );

  // The intake column (#2298) comes from the full column list in array order, never a view-filtered one.
  const intakeColumnId = useMemo(() => firstNotDoneColumn(board.columns)?.id ?? null, [board.columns]);

  const handleColumnAdded = useCallback((col: Column) => {
    onColumnAdded(col);
    if (insertPosition !== null) {
      const currentIds = board.columns.map((c) => c.id);
      const newOrder = [
        ...currentIds.slice(0, insertPosition),
        col.id,
        ...currentIds.slice(insertPosition),
      ];
      // onColumnsReordered (useBoard.reorderColumns) does its own optimistic
      // update + rollback on failure and never rejects.
      void onColumnsReordered(newOrder);
    }
  }, [board.columns, insertPosition, onColumnAdded, onColumnsReordered]);

  const handleSwimlaneAdded = useCallback((swimlane: Swimlane) => {
    markLaneLocalEdit(swimlane.id);
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
      // onSwimlanesReordered (useBoard.reorderSwimlanes) does its own optimistic
      // update + rollback on failure and never rejects.
      void onSwimlanesReordered(newOrder);
    }
  }, [board.swimlanes, insertSwimlanePosition, onSwimlaneAdded, onSwimlanesReordered, markLaneLocalEdit]);


  // Mouse drags start after 5px; touch drags on press-and-hold (#1287).
  const sensors = useDragSensors();
  // Drag-and-drop is suspended while the card detail sheet is open (#1914):
  // the board behind it stays clickable so a click swaps the open card, but
  // nothing starts a drag. (The old full-screen backdrop blocked drags too.)
  const noSensors = useSensors();

  // Unique 3-char abbreviations for collapsed column headers.
  // Algorithm: strip spaces, take first 3 chars uppercased; if two columns share
  // the same base, suffix the later ones with a digit (e.g. "DON", "DO2").
  // Colors already in use, offered by the four column / swimlane modals' custom color popover (#2098).
  const boardColors = useMemo(
    () => boardColorsInUse({ columns: board.columns, swimlanes: board.swimlanes, labels: board.labels }),
    [board.columns, board.swimlanes, board.labels],
  );

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

  // The left label panel is gone (#2271): swimlane bands span the grid, so grid math starts at 0.
  // `viewPrefs.swimlaneColumnWidth` is still read and written for old saved prefs, but unused.

  // Header "add card" (#2270, #2317): opens the new-card input in the chosen lane's cell for this
  // column, through the cell's own listener, so the cell keeps owning its draft and its focus return.
  // A collapsed lane has no cells, so it is expanded first and the request waits for them to render.
  const [pendingAddCard, setPendingAddCard] = useState<{ columnId: number; swimlaneId: number } | null>(null);
  const dispatchAddCard = useCallback((columnId: number, swimlaneId: number) => {
    const cell = document.querySelector<HTMLElement>(
      `[data-board-cell][data-column-id="${columnId}"][data-swimlane-id="${swimlaneId}"]`,
    );
    if (!cell) return false;
    cell.dispatchEvent(new CustomEvent(ADD_CARD_EVENT));
    return true;
  }, []);
  // Phone layout (#2277): there are no cells to dispatch to, so the request is handed to PhoneBoard.
  const [phoneAddRequest, setPhoneAddRequest] = useState<{ columnId: number; swimlaneId: number; nonce: number } | null>(null);
  const clearPhoneAddRequest = useCallback(() => setPhoneAddRequest(null), []);
  const requestAddCard = useCallback((columnId: number, swimlaneId: number) => {
    if (isPhone) {
      setPhoneAddRequest({ columnId, swimlaneId, nonce: Date.now() });
      return;
    }
    if (collapsedSwimlaneIds.has(swimlaneId)) {
      toggleCollapsedSwimlane(swimlaneId);
      setPendingAddCard({ columnId, swimlaneId });
      return;
    }
    dispatchAddCard(columnId, swimlaneId);
  }, [isPhone, collapsedSwimlaneIds, toggleCollapsedSwimlane, dispatchAddCard]);
  useEffect(() => {
    if (!pendingAddCard || collapsedSwimlaneIds.has(pendingAddCard.swimlaneId)) return;
    const { columnId, swimlaneId } = pendingAddCard;
    // Cells commit with the expand render, so the first try normally lands; one frame of grace
    // covers a lane that mounts its cells a tick later.
    if (dispatchAddCard(columnId, swimlaneId)) {
      setPendingAddCard(null);
      return;
    }
    const raf = requestAnimationFrame(() => {
      dispatchAddCard(columnId, swimlaneId);
      setPendingAddCard(null);
    });
    return () => cancelAnimationFrame(raf);
  }, [pendingAddCard, collapsedSwimlaneIds, dispatchAddCard]);
  // Lanes the header "+" can target, in board order (lanes hidden by the user or a lane filter have no cells).
  const addCardLanes = useMemo(
    () => board.swimlanes
      .filter((s) => !renderHiddenSwimlaneIds.has(s.id))
      .map((s) => ({ id: s.id, name: s.name, color: s.color, collapsed: collapsedSwimlaneIds.has(s.id) })),
    [board.swimlanes, renderHiddenSwimlaneIds, collapsedSwimlaneIds],
  );

  const noMatchPanel = noCardMatch ? (
    <BoardNoMatchState line={noMatchLine(showChip, panelFilteredCardIds?.size ?? null)} onShowAll={showAllCards} />
  ) : null;

  // #2324 — Import cards links to the group's import flow (owner ruling 2026-11-16),
  // offered only when the server says this viewer may place boards in the group
  // (the same can_place_boards that gates GroupDetail's Import). Fetched only while
  // the board is empty; any failure means no button. The server enforces it again.
  const boardIsEmpty = board.cards.length === 0;
  const [importGroup, setImportGroup] = useState<{ id: number; ok: boolean } | null>(null);
  useEffect(() => {
    const gid = board.group;
    if (!boardIsEmpty || gid == null) return;
    let live = true;
    getGroup(gid).then(
      (g) => { if (live) setImportGroup({ id: gid, ok: g.can_place_boards === true }); },
      () => { if (live) setImportGroup({ id: gid, ok: false }); },
    );
    return () => { live = false; };
  }, [board.group, boardIsEmpty]);
  const importHref = importGroup?.ok && importGroup.id === board.group ? `/groups/${board.group}?import=1` : undefined;
  const emptyBoardPanel = view === "board" && boardIsEmpty && !allLanesFilteredOut && board.columns.length > 0 ? (
    <BoardEmptyState
      firstColumnName={board.columns[0].name}
      onAddCard={canEdit && board.columns[0].allow_card_creation && addCardLanes.length > 0
        ? () => requestAddCard(board.columns[0].id, addCardLanes[0].id)
        : undefined}
      importHref={importHref}
    />
  ) : null;
  // Saved per-column widths (#1990 resize), clamped to 160..600. Under the shared
  // grid template they are track weights, not px widths: see `columnTrack`.
  const colWidths = useMemo(() => {
    const map = new Map<number, number>();
    for (const col of board.columns) map.set(col.id, clampColumnWidth(viewPrefs.columnWidths[col.id]));
    return map;
  }, [board.columns, viewPrefs.columnWidths]);
  const isNarrowColumn = useCallback(
    (colId: number) => hiddenColumnIds.has(colId) || collapsedColumnIds.has(colId),
    [hiddenColumnIds, collapsedColumnIds],
  );

  // One shared grid template for the header row, every lane and every row
  // separator (#2300): one fr track per column, weighted by its saved width
  // (`minmax(0, 1fr)` at the default 220px), 40px for a hidden or collapsed
  // stub, 8px between. Every row reads this one string, so a resize moves the
  // header cell and every lane cell of that column together.
  // A gated stage (#1102) takes one column's width per sub-column (#2531) while "Show sub-columns"
  // is on (#2278); off, it renders at normal width with progress bars.
  const showSubColumns = viewPrefs.showSubColumns !== false;
  const gridTracks = useMemo<BoardTrack[]>(
    () => board.columns.map((col) => (isNarrowColumn(col.id) ? "narrow" : columnTrack(colWidths.get(col.id), showSubColumns && isGatedStage(col) ? stageSubColumns(col).length : false))),
    [board.columns, isNarrowColumn, colWidths, showSubColumns],
  );
  const gridTemplate = useMemo(() => boardGridTemplate(gridTracks), [gridTracks]);
  const gridMinWidth = useMemo(() => boardGridMinWidth(gridTracks), [gridTracks]);
  // Each column track's floor, read by a separator drag (measureTrackLeftOf) to
  // keep the resized edge under the pointer when the min width holds the grid open.
  const gridTrackFloors = useMemo(() => gridTracks.map((gridTrack) => trackFloor(gridTrack)).join(" "), [gridTracks]);
  useBoardViewWidthVar(scrollEl);

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

  // What dropping a card into a cell would trip (#1150), strictest first. The
  // board's own state is the input, so the prediction matches the server's
  // rules (utils/placementLimits) but never replaces its answer.
  const getDropVerdict = useCallback(
    (cardId: number, column: Column, swimlane: Swimlane) => {
      const card = board.cards.find((c) => c.id === cardId);
      if (!card) return [];
      return placementVerdict({ flags: board, columns: board.columns, cards: board.cards, card, column, lane: swimlane });
    },
    [board],
  );

  // Entry criteria a dragged card would meet in *column* (#1101): none when it
  // is already there. Stable per board so the memoized cells don't re-render.
  const getEntryCriteria = useCallback(
    (cardId: number, column: Column) => {
      const card = board.cards.find((c) => c.id === cardId);
      return card ? entryCriteriaFor(card, column) : [];
    },
    [board.cards],
  );

  // Send a drag-and-drop move and announce its outcome once known. Shared by
  // a plain drop and a drop confirmed through the entry checklist (#1101).
  const commitCardMove = (card: Card, targetColumnId: number, targetSwimlaneId: number, position: number, gatesPassed?: number) => {
    // The entry checklist can be open when the socket drops (#2325).
    if (movesPausedRef.current) {
      setDndAnnouncement("Move canceled, moves are paused while the board is offline");
      return;
    }
    const targetCol = board.columns.find((c) => c.id === targetColumnId);
    const targetSwim = board.swimlanes.find((s) => s.id === targetSwimlaneId);
    // onMoveCard (useBoard.moveCard) does its own optimistic update, rollback,
    // and visible error surfacing (moveError) on failure and never rejects. Only
    // announce the outcome once known: announcing "moved" up front told screen
    // reader users a failed move had succeeded (#1761).
    // Warn and record only (#1102 phase 1): onMoveCard raises the leave warning.
    const subName = gatesPassed !== undefined && targetCol ? stageSubColumns(targetCol)[gatesPassed]?.name : undefined;
    // The fifth argument only when a sub-column was chosen, so plain moves keep their call shape.
    const sent = gatesPassed === undefined
      ? onMoveCard(card.id, targetColumnId, targetSwimlaneId, position)
      : onMoveCard(card.id, targetColumnId, targetSwimlaneId, position, gatesPassed);
    void Promise.resolve(sent).then((outcome) => {
      if (outcome && outcome.ok === false) {
        // The move_failed / limit toast is announced assertively by the shared
        // toast region and already carries the cause; blank this status region
        // so the failure is read once (#1761, #2060).
        setDndAnnouncement("");
      } else if (targetCol && targetSwim) {
        setDndAnnouncement(`Card '${card.title}' moved to column '${targetCol.name}'${subName ? `, sub-column '${subName}'` : ""}, swimlane '${targetSwim.name}'`);
      }
    });
  };


  // Sub-columns as keyboard stops (#2327): the card menu's Move to… steps to
  // the neighboring sub-column through the same Move path, keeping the cell
  // (no column change, so no WIP check and no CardMovement on the server).
  const stepCardSubColumn = (card: Card, step: SubColumnStep) => {
    if (!cardActionEntries([card], cardActionContext).find((e) => e.id === "move")?.enabled) return;
    const col = board.columns.find((c) => c.id === card.column);
    const subs = stageSubColumns(col);
    if (!col || subs.length === 0) return;
    const from = cardSubColumnIndex(card, col);
    const to = step === "sub-previous" ? from - 1 : from + 1;
    if (to < 0 || to >= subs.length) return;
    void Promise.resolve(onMoveCard(card.id, card.column, card.swimlane, card.position, to)).then((outcome) => {
      if (outcome && outcome.ok === false) { setDndAnnouncement(""); return; }
      setDndAnnouncement(`Card '${card.title}' moved to sub-column '${subs[to].name}' in '${col.name}'`);
      focusCardSoon(card.id);
    });
  };

  // Keyboard reorder within a cell (#2327): the card menu's Move to… offers
  // "Move earlier / later in this cell" (no new shortcut keys). Same slots and
  // visible-neighbor rule as the phone peek sheet's steps (`cellOrderOf`), so a
  // step never passes a card the filter hides.
  const reorderCardInCell = (card: Card, step: ReorderStep) => {
    // The menu's own gate, re-read: the board may have gone offline since it opened.
    if (!cardActionEntries([card], cardActionContext).find((e) => e.id === "move")?.enabled) return;
    const order = cellOrderOf(board.cards, card, filteredCardIds, board.columns.find((c) => c.id === card.column));
    const position = step === "earlier" ? order.earlier : order.later;
    if (position === null) return;
    const place = step === "earlier" ? order.index : order.index + 2;
    void Promise.resolve(onMoveCard(card.id, card.column, card.swimlane, position)).then((outcome) => {
      // A refusal raises its own announced toast (#2060); say nothing twice.
      if (outcome && outcome.ok === false) { setDndAnnouncement(""); return; }
      setDndAnnouncement(`Card '${card.title}' moved to place ${place} of ${order.count} in its cell`);
      focusCardSoon(card.id);
    });
  };

  // Focus returns to the moved card after the checklist closes either way
  // (#1101). After the modal's own focus restore, which only acts when focus
  // would otherwise be lost.
  // A confirmed move re-renders the card in its new cell, so the element may
  // not exist on the first frame: retry for a few frames before giving up.
  const focusCardSoon = (cardId: number, framesLeft = 10) => {
    requestAnimationFrame(() => {
      const el = document.querySelector<HTMLElement>(`[data-card-id="${cardId}"]`);
      if (el) el.focus();
      else if (framesLeft > 0) focusCardSoon(cardId, framesLeft - 1);
    });
  };

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
    const [, colId, swimId] = overId.split(":");
    const col = board.columns.find((c) => c.id === Number(colId));
    const swim = board.swimlanes.find((s) => s.id === Number(swimId));
    if (!col || !swim) return;
    // The cell's verdict (#1150): a keyboard drag hears what a pointer drag
    // sees as the drop ring, e.g. "Swimlane "Payouts" is at its WIP limit
    // (5/5), admins can override."
    const cardId = Number(e.active.id);
    const verdict = Number.isNaN(cardId) ? [] : getDropVerdict(cardId, col, swim);
    // Entry criteria (#1101) are read only when no limit blocks the drop: a
    // blocked move is refused before anyone would check them.
    const criteria = verdict.length > 0 || Number.isNaN(cardId) ? [] : getEntryCriteria(cardId, col);
    const suffix = verdict.length > 0
      ? `. ${verdict.map((element) => trippedLimitSentence(element)).join(" ")}`
      : criteria.length > 0 ? `. ${entryCriteriaSentence(col.name, criteria)}` : "";
    // The throttle keeps a fast pointer drag from flooding the live region,
    // but it must never swallow a blocked cell's verdict, which is the only
    // non-visual carrier of the drop ring: a cell with a verdict always
    // announces (ux-review on #1150). Entry criteria are the only non-visual
    // carrier of the drop message the same way (#1101).
    if (dndHoverThrottleRef.current && verdict.length === 0 && criteria.length === 0) return;
    if (dndHoverThrottleRef.current) clearTimeout(dndHoverThrottleRef.current);
    dndHoverThrottleRef.current = setTimeout(() => {
      dndHoverThrottleRef.current = null;
    }, 300);
    setDndAnnouncement(`Over column '${col.name}', swimlane '${swim.name}'${suffix}`);
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
      // onColumnsReordered (useBoard.reorderColumns) does its own optimistic
      // update + rollback on failure and never rejects.
      void onColumnsReordered(reordered.map((c) => c.id));
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
      // onSwimlanesReordered (useBoard.reorderSwimlanes) does its own optimistic
      // update + rollback on failure and never rejects.
      void onSwimlanesReordered(reordered.map((s) => s.id));
      return;
    }

    setActiveCard(null);
    if (!over) {
      setDndAnnouncement("Move canceled, card returned to original position");
      return;
    }
    // A drag that started before the socket dropped must not land while moves are paused (#2325).
    if (movesPaused) {
      setDndAnnouncement("Move canceled, moves are paused while the board is offline");
      return;
    }
    // Guard: card drops must land on a cell: zone. col:/swim: zones are not valid targets for cards.
    // Without this, over.id like "col:3" causes swimId = undefined → NaN → null → backend 404.
    if (!String(over.id).startsWith("cell:")) {
      setDndAnnouncement("Move canceled, card returned to original position");
      return;
    }
    // A split cell's targets are its sub-columns: `cell:{col}:{lane}:{index}` (#2278).
    const [, colId, swimId, gateSeg] = String(over.id).split(":");
    const gatesPassed = gateSeg !== undefined ? Number(gateSeg) : undefined;
    const cardId = Number(activeId);
    const card = board.cards.find((c) => c.id === cardId);
    if (!card) return;

    const targetColumnId = Number(colId);
    const targetSwimlaneId = Number(swimId);
    const targetCol = board.columns.find((c) => c.id === targetColumnId);
    const targetSwim = board.swimlanes.find((s) => s.id === targetSwimlaneId);

    const siblings = board.cards
      .filter((c) => c.column === targetColumnId && c.swimlane === targetSwimlaneId && c.id !== cardId)
      .sort((a, b) => a.position - b.position);

    // Confirm on entry (#1101): hold the move for the checklist. A limit block
    // wins, in the same order the server applies: when the drop would trip a
    // limit, send it as is so the refusal raises MoveBlockedToast, and open
    // no checklist for a move that will not happen.
    if (
      targetCol && targetSwim && needsEntryConfirm(card, targetCol)
      && getDropVerdict(cardId, targetCol, targetSwim).length === 0
    ) {
      setPendingPolicyMove({ cardId, columnId: targetColumnId, swimlaneId: targetSwimlaneId, position: siblings.length, gatesPassed });
      return;
    }

    // A drop into the card's own sub-column within its own cell changes nothing.
    if (
      gatesPassed !== undefined && card.column === targetColumnId && card.swimlane === targetSwimlaneId
      && targetCol && cardSubColumnIndex(card, targetCol) === gatesPassed
    ) {
      setDndAnnouncement("Move canceled, card returned to original position");
      return;
    }
    commitCardMove(card, targetColumnId, targetSwimlaneId, siblings.length, gatesPassed);
  };

  // A held drop goes stale when, over the socket, its card or target column
  // disappears or the column stops asking for confirmation (#1101). Cancel it
  // rather than leave a checklist for a move that no longer applies.
  useEffect(() => {
    if (!pendingPolicyMove) return;
    const card = board.cards.find((c) => c.id === pendingPolicyMove.cardId);
    const target = board.columns.find((c) => c.id === pendingPolicyMove.columnId);
    if (card && target && needsEntryConfirm(card, target)) return;
    setPendingPolicyMove(null);
    setDndAnnouncement("Move canceled, the column or its policy changed");
    focusCardSoon(pendingPolicyMove.cardId);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- focusCardSoon is a plain helper with no state; re-run only when the inputs to the check change
  }, [pendingPolicyMove, board.cards, board.columns]);

  const activeCount = countActiveFilters(effectiveFilters);

  const hiddenCount = panelFilteredCardIds !== null
    ? board.cards.filter((c) => !c.archived_at).length - panelFilteredCardIds.size
    : 0;

  // Overflow menu items are computed unconditionally — the memo must sit above
  // the early-return branches for summary/history/analytics views so the hook
  // order stays stable across re-renders.
  const overflowItems: OverflowItem[] = useMemo(() => {
    const items: OverflowItem[] = [];

    // Keyboard shortcuts only (#2435): Export and Settings are toolbar buttons
    // beside it, so the overflow menu no longer carries them.
    items.push({
      id: "shortcuts",
      label: "Keyboard shortcuts",
      icon: ShortcutsIcon,
      shortcut: "?",
      onSelect: () => {
        setShowShortcuts(true);
      },
    });

    return items;
  }, []);

  // Screen-reader-only announcement for card-action results that change the
  // board in view (#2059); every other result is a toast (#2107). Rendered by
  // EVERY view branch below. Always mounted so the text swap is announced.
  const cardActionNotice = (
    <div className="sr-only">
      <p role="status" aria-live="polite" aria-atomic="true" data-testid="card-action-status">{cardActionAnnouncement}</p>
      <p role="status" aria-live="polite" aria-atomic="true" data-testid="bulk-lane-status">{bulkAnnouncement}</p>
    </div>
  );

  // Lens view — read-only GitHub/GitLab issue mirror. If the tab disappears
  // while it's active (flag flipped off, or connection removed), fall back to
  // the board view rather than rendering a dead tab.
  if (view === "lens") {
    // The fallback-to-board redirect is handled by the effect above; render
    // nothing for the frame before the URL updates.
    if (!showLensTab || !lensConnection) {
      return null;
    }
    return (
      <div className="relative flex-1 flex flex-col min-h-0">
        {/* Shared Row 2 (#2302) — the SAME wrapping structure as the board's
            toolbar below, so switching Board↔Lens does not shift the tabs and
            the row never scrolls sideways. */}
        <nav aria-label="Board toolbar" className="min-h-10 shrink-0 bg-surface border-b border-line flex flex-wrap items-center gap-x-2 px-3">
          <div data-testid="board-toolbar" className="flex flex-wrap items-center gap-x-2 gap-y-1 flex-1 min-w-0 max-sm:contents">
            <ViewTabStrip view={view}>
              <ViewToggle view={view} onChange={setView} showLens={showLensTab} deemphasizeBoard={deemphasizeBoardTab} />
            </ViewTabStrip>
            <div className="flex-1 max-sm:hidden" />
            {/* Inside its own Lens boundary: before the toolbar was split out of
                LensView, all lens chrome sat inside the boundary below. Without
                this, a throw from LensToolbar escapes the Lens section and takes
                down the whole board page instead of just the lens pane. */}
            <div className="contents max-sm:block max-sm:order-3 max-sm:w-full">
              <SectionErrorBoundary section="Lens">
                <LensToolbar
                  connection={lensConnection}
                  cardLayout={cardLayout}
                  onToggleLayout={() => setCardLayout(cardLayout === "compact" ? "expanded" : "compact")}
                  showFilters={lensShowFilters}
                  onToggleFilters={() => setLensShowFilters((v) => !v)}
                  laneCount={lensLaneCount}
                />
              </SectionErrorBoundary>
            </div>
          </div>
        </nav>
        {cardActionNotice}
        <SectionErrorBoundary section="Lens">
          <LensView
            boardId={board.id}
            connection={lensConnection}
            cardLayout={cardLayout}
            showFilters={lensShowFilters}
            onHideFilters={() => { setLensShowFilters(false); focusFiltersTrigger(); }}
            onLaneCountChange={setLensLaneCount}
          />
        </SectionErrorBoundary>
      </div>
    );
  }

  if (view === "summary") {
    return (
      <div className="relative flex-1 flex flex-col min-h-0">
        <nav aria-label="Board toolbar" className="min-h-10 shrink-0 bg-surface border-b border-line flex flex-wrap items-center gap-x-2 px-3">
          <ViewTabStrip view={view}>
            <ViewToggle view={view} onChange={setView} showLens={showLensTab} deemphasizeBoard={deemphasizeBoardTab} />
          </ViewTabStrip>
        </nav>
        {cardActionNotice}
        <SectionErrorBoundary section="Summary">
          <SummaryView boardId={board.id} columns={board.columns.map((c) => c.name)} />
        </SectionErrorBoundary>
      </div>
    );
  }

  if (view === "history") {
    return (
      <div className="relative flex-1 flex flex-col min-h-0">
        <nav aria-label="Board toolbar" className="min-h-10 shrink-0 bg-surface border-b border-line flex flex-wrap items-center gap-x-2 px-3">
          <ViewTabStrip view={view}>
            <ViewToggle view={view} onChange={setView} showLens={showLensTab} deemphasizeBoard={deemphasizeBoardTab} />
          </ViewTabStrip>
        </nav>
        {cardActionNotice}
        <SectionErrorBoundary section="Movement history">
          <MovementHistoryView board={board} currentUser={currentUser} />
        </SectionErrorBoundary>
      </div>
    );
  }

  if (view === "analytics") {
    return (
      <div className="relative flex-1 flex flex-col min-h-0">
        <nav aria-label="Board toolbar" className="min-h-10 shrink-0 bg-surface border-b border-line flex flex-wrap items-center gap-x-2 px-3">
          <ViewTabStrip view={view}>
            <ViewToggle view={view} onChange={setView} showLens={showLensTab} deemphasizeBoard={deemphasizeBoardTab} />
          </ViewTabStrip>
        </nav>
        {cardActionNotice}
        <SectionErrorBoundary section="Analytics">
          <AnalyticsView
            boardId={board.id}
            currentUserRole={board.current_user_role}
            onOpenCard={(cardId) => {
              const card = board.cards.find((c) => c.id === cardId);
              if (card) { clearSelection(); setSelectedCard(card); }
            }}
            swimlanes={board.swimlanes}
            labels={board.labels}
            columns={board.columns}
            customFields={board.custom_field_definitions}
            boardName={board.name}
            // The server 400s on an admin-only grouping field for a non-admin, so offer
            // exactly the fields the lane filter offers (same helper, same rule).
            // The lane filter's built-ins (#2336) are text, never a grouping field.
            swimlaneFields={laneFields.flatMap((f) => (typeof f.id === "number" && (f.field_type === "dropdown" || f.field_type === "checkbox") ? [{ id: f.id, name: f.name }] : []))}
            onGoToBoard={() => setView("board")}
          />
        </SectionErrorBoundary>
        {selectedCard && (
          <CardDetail
            // Remount on card change (#449). CardDetail seeds localCard and its
            // collapsible-section state from useState(card) initializers. Its only
            // prop-sync is a version-keyed effect for the Move popover and the
            // card's location (#1773), so without a key, opening a different card from
            // a relation row would render the previous card's title, weight and
            // relations while the new card's data loads.
            key={selectedCard.id}
            card={liveSelectedCard ?? selectedCard}
            board={board}
            onClose={() => setSelectedCard(null)}
            onDeleted={(id) => { onCardDeleted(id); setSelectedCard(null); }}
            onUpdated={onCardUpdated}
            onArchived={(id) => { onCardArchived(id); setSelectedCard(null); showArchiveToast(); }}
            // Forward every argument: the fifth, gatesPassed, is the chosen sub-column stop (#1102).
            onMoveCard={async (...args) => onMoveCard(...args)}
            onForceMoveCard={(...args) => forceMoveCardTo(...args)}
            movesPaused={movesPaused}
            // Phone only (#2359): the peek sheet's reorder, in the detail panel a tap opens (#2358).
            cellOrder={isPhone ? cellOrderOf(board.cards, liveSelectedCard ?? selectedCard, filteredCardIds, board.columns.find((c) => c.id === (liveSelectedCard ?? selectedCard)?.column)) : undefined}
            userDateFormat={userDateFormat}
            userTimeFormat={userTimeFormat}
            userTimezone={userTimezone}
            currentUser={currentUser}
            closeEditorOnEnter={closeEditorOnEnter}
            refreshSignal={cardDetailRefreshTick}
            childrenRefreshSignal={childrenRefreshTick}
            blockFormRequest={blockFormRequest}
            tabRequest={tabRequest}
            backToParentId={childrenNav?.cardId === selectedCard.id ? childrenNav.fromParent : null}
            focusChildId={childrenNav?.cardId === selectedCard.id ? childrenNav.focusChild : null}
          />
        )}
      </div>
    );
  }

  // Primary click on the Collapse split button performs the dominant action —
  // if anything is expanded, collapse all; otherwise, expand all. Preserves
  // the 1.0 single-button behavior so muscle memory is not disturbed.
  // Rendered in the card-layout tooltip and in the overflow-menu label so the
  // chord display stays consistent with the rest of the shortcut tooltips.

  const onHideAllSwimlanes = () => {
    if (focusedSwimlaneId !== null) exitFocus();
    collapseAllSwimlanes(board.swimlanes.map((s) => s.id));
  };
  const onHideAllColumns = () => {
    if (focusedSwimlaneId !== null) exitFocus();
    collapseAllColumns(board.columns.map((c) => c.id));
  };
  const onShowAllSwimlanes = () => expandAllSwimlanes();
  const onShowAllColumns = () => expandAllColumns();
  const allLanesCollapsed = board.swimlanes.length > 0 && collapsedSwimlaneIds.size >= board.swimlanes.length;

  return (
    <RollupLoadingContext.Provider value={rollupLoadingIds}>
      {/* Primary toolbar row (#2269): tabs on the left; Filter, View, Activity,
          the overflow menu and the connection status on the right. Nothing
          folds by viewport: the row wraps instead, so no control is ever
          hidden and the page never scrolls sideways. Connection status is the
          last item and stays pinned to the trailing edge (on phones it is
          drawn only when not healthy, see below). */}
      {/* Phone (#2348): one 44px row, the tabs scrolling inside their own box with Filter, Activity and More after them, so the chrome is header + tab strip (about 92px) and the strip sits at the same y as the other views' (#2349). */}
      <nav aria-label="Board toolbar" className="min-h-10 shrink-0 bg-surface border-b border-line flex flex-wrap items-center gap-x-2 px-3 max-sm:flex-nowrap max-sm:gap-x-1">
        <div data-testid="board-toolbar" className="flex flex-wrap items-center gap-x-2 gap-y-1 flex-1 min-w-0 max-sm:contents">
          <ViewTabStrip view={view}>
            <ViewToggle view={view} onChange={setView} showLens={showLensTab} deemphasizeBoard={deemphasizeBoardTab} />
          </ViewTabStrip>
          <div className="flex-1 max-sm:hidden" />
          <div className="flex items-center gap-2 flex-wrap max-sm:order-2 max-sm:flex-nowrap max-sm:gap-1 max-sm:shrink-0">
            <FilterPanel
              board={board}
              filters={effectiveFilters}
              onChange={(next) => { setActiveFilterId(null); setFilters(next); }}
              activeCount={activeCount}
              icon={FilterIcon}
              savedFilters={savedFilters}
              savedFiltersLoading={savedFiltersLoading}
              activeFilterId={activeFilterId}
              onLoadSaved={(sf) => { setFilters(hydrateFilter(sf)); setActiveFilterId(sf.id); }}
              filterBarShown={showFilters}
              onToggleFilterBar={() => setShowFilters((v) => !v)}
              onOpenLaneFilters={openLaneFilters}
              onSaveFilter={(name) => saveFilter(name, effectiveFilters)}
              userDateFormat={userDateFormat}
              onOpenViewOptions={isPhone ? openViewFromFilter : undefined}
            />
            <span ref={presetPickerRef} className="contents">
              <BoardViewMenu
                icon={ViewMenuIcon}
                phoneHandoff={isPhone ? { openRequest: viewOpenRequest, anchorRef: filterTriggerRef } : undefined}
                presetPicker={
                  <SingleSelectDropdown<BoardPresetId>
                    label="Preset"
                    ariaLabel={activePreset ? "Preset" : undefined}
                    ariaLabelDetail={presetModified ? "modified" : undefined}
                    optionRole="menuitemradio"
                    triggerPrefix={PresetIcon}
                    portalMenu
                    className="w-full"
                    labelClassName="truncate min-w-0"
                    triggerTitle={activePreset?.name}
                    escapePriority={26}
                    options={presetOptions}
                    selected={activePreset?.id ?? null}
                    onChange={handlePresetChange}
                    triggerSuffix={
                      presetModified ? (
                        <span data-testid="preset-modified-tag" className="shrink-0 border border-dashed border-line-strong rounded px-1 text-fg-secondary">
                          Modified
                        </span>
                      ) : undefined
                    }
                    menuHeader={
                      presetModified && activePreset ? (
                        <>
                          <span className="block font-medium text-fg-secondary">Modified from “{activePreset.name}”</span>
                          {boardPreset.differences.map((d) => (
                            <span key={d.element} className="block">{formatPresetDifference(d)}</span>
                          ))}
                        </>
                      ) : undefined
                    }
                    menuActions={presetMenuActions}
                  />
                }
                density={effectiveCardDensity}
                onDensityChange={setCardDensityOverride}
                cardLayout={cardLayout}
                onCardLayoutChange={setCardLayout}
                overlayPicker={
                  <SingleSelectDropdown
                    label="Overlay"
                    triggerPrefix={OverlayIcon}
                    portalMenu
                    className="w-full"
                    escapePriority={26}
                    unselectedLabel="None"
                    ariaLabel="Overlay"
                    options={gridOverlayOptions}
                    selected={gridOverlayId === NONE_OVERLAY_ID ? null : gridOverlayId}
                    onChange={handleGridOverlayChange}
                  />
                }
                allSwimlanesCollapsed={allLanesCollapsed}
                allSwimlanesExpanded={allSwimlanesExpanded}
                allColumnsCollapsed={board.columns.length > 0 && collapsedColumnIds.size >= board.columns.length}
                allColumnsExpanded={allColumnsExpanded}
                laneCount={board.swimlanes.length}
                columnCount={board.columns.length}
                onCollapseSwimlanes={onHideAllSwimlanes}
                onExpandSwimlanes={onShowAllSwimlanes}
                onCollapseColumns={onHideAllColumns}
                onExpandColumns={onShowAllColumns}
                showArchived={showArchived}
                onToggleArchived={() => setShowArchived((v) => !v)}
                showSubColumns={showSubColumns}
                onShowSubColumnsChange={board.columns.some((element) => isGatedStage(element)) ? setShowSubColumns : undefined}
                cardFieldNames={board.custom_field_definitions.filter((d) => d.show_on_card).map((d) => d.name)}
                onChangeCardFields={isAdmin ? openCardFields : undefined}
              />
            </span>
            <Tooltip content={`${drawerOpen ? "Close activity drawer" : "Open activity drawer"} (${formatShortcut({ mod: true, key: "\\" })})`}>
              <button type="button"
                ref={activityButtonRef}
                onClick={() => setDrawerOpen((v) => !v)}
                aria-pressed={drawerOpen}
                aria-label={drawerOpen ? "Close activity drawer" : "Open activity drawer"}
                className={`inline-flex items-center justify-center gap-1.5 h-9 px-3 max-sm:h-11 max-sm:min-w-11 max-sm:px-0 text-sm rounded border transition shrink-0 focus:outline-none focus:ring-2 focus:ring-primary-emphasis ${
                  drawerOpen ? "text-info-on-tint bg-info/10 border-info/40" : "text-fg border-line-strong hover:bg-surface-hover"
                }`}
              >
                {ActivityDrawerIcon}
                {/* Icon-only on phones (#2333); the text stays in the DOM as the accessible name. */}
                <span className="max-sm:sr-only">Activity</span>
              </button>
            </Tooltip>
            {canExport && (
              <Tooltip content={`Export board ${formatShortcut({ mod: true, shift: true, key: "E" })}`}>
                <button type="button"
                  onClick={() => setShowExport(true)}
                  aria-keyshortcuts={formatAriaKeyshortcuts({ mod: true, shift: true, key: "E" })}
                  className="inline-flex items-center justify-center gap-1.5 h-9 px-3 max-sm:h-11 max-sm:min-w-11 max-sm:px-0 text-sm rounded border transition shrink-0 text-fg border-line-strong hover:bg-surface-hover focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
                >
                  {ExportIcon}
                  {/* Icon-only on phones, like Activity; the text stays in the DOM as the accessible name (WCAG 2.5.3). */}
                  <span className="max-sm:sr-only">Export</span>
                </button>
              </Tooltip>
            )}
            {isAdmin && (
              <Tooltip content={`Board settings ${formatShortcut({ mod: true, key: "," })}`}>
                <button type="button"
                  onClick={() => setShowSettings(true)}
                  aria-keyshortcuts={formatAriaKeyshortcuts({ mod: true, key: "," })}
                  className="inline-flex items-center justify-center gap-1.5 h-9 px-3 max-sm:h-11 max-sm:min-w-11 max-sm:px-0 text-sm rounded border transition shrink-0 text-fg border-line-strong hover:bg-surface-hover focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
                >
                  {SettingsIcon}
                  <span className="max-sm:sr-only">Settings</span>
                </button>
              </Tooltip>
            )}
            <OverflowMenu
              items={overflowItems}
              showDot={!overflowSeen}
              onDismissDot={markOverflowSeen}
              externalOpen={overflowOpen}
              onExternalOpenChange={setOverflowOpen}
            />
          </div>
        </div>
        <div className="flex items-center shrink-0 ml-auto max-sm:order-3 max-sm:ml-0">
          <ConnectionStatus
            hideWhenHealthyOnPhone
            status={socketStatus}
            lastEventAt={socketLastEventAt}
            reconnectAttempt={socketReconnectAttempt}
            reconnectingLabel="Offline"
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
            <div data-filter-row className="px-3 pt-1.5 bg-surface border-t border-line shrink-0">
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
          {/* Phone (#2333): every control in the bar is a 44px target; the text inputs are lifted but a checkbox or radio is not (its row is the target); the facet menus are CheckboxDropdown and carry their own rules (#2350); the Lanes popover is not portaled, so its checkbox label row carries its own max-sm:min-h-11. */}
          <div role="search" data-filter-row aria-label="Board filters" className="px-3 py-1.5 bg-surface border-b border-line shrink-0 flex items-center gap-2 flex-wrap max-sm:[&_button]:min-h-11 max-sm:[&_input:not([type=checkbox]):not([type=radio])]:min-h-11">
            <SavedFiltersDropdown
              boardId={board.id}
              filters={effectiveFilters}
              savedFilters={savedFilters}
              loading={savedFiltersLoading}
              onLoad={(sf) => {
                setFilters(hydrateFilter(sf));
                setActiveFilterId(sf.id);
              }}
              onSave={(name) => saveFilter(name, effectiveFilters)}
              onDelete={removeFilter}
              firstElementRef={(el) => { filterBarFirstRef.current = el; }}
              externalTriggerRef={(el) => { (savedFiltersDropdownTriggerRef as React.MutableRefObject<HTMLButtonElement | null>).current = el; }}
            />
            <FilterBar
              board={board}
              filters={effectiveFilters}
              onChange={(next) => {
                // Any manual edit means the active preset no longer matches live state.
                setActiveFilterId(null);
                setFilters(next);
              }}
              searchRef={searchRef}
              isSearching={isSearching}
              currentUser={currentUser}
              hiddenCount={hiddenCount}
              hiddenLaneCount={hiddenLaneTotal}
              cardFilterActive={filteredCardIds !== null}
              ignoredLaneRuleCount={ignoredLaneRuleCount}
              lanesTriggerRef={lanesTriggerRef}
              scope={scope}
              onScopeChange={setScope}
              userDateFormat={userDateFormat}
            />
            <HideFilterBarButton onHide={() => { setShowFilters(false); focusFiltersTrigger(); }} />
          </div>
        </>
      )}
      {/* Always-mounted live region (text swapped inside) so the notice is announced reliably;
          margins live on the inner div so the empty wrapper takes no layout space. */}
      <div role="status" aria-live="polite" aria-atomic="true">
        {searchTruncation && (
          <div className="mx-4 mt-2 px-4 py-2 bg-surface border border-line rounded-lg text-fg-tertiary text-sm">
            Showing the first {searchTruncation.shown.toLocaleString()} of {searchTruncation.total.toLocaleString()} matches; the rest are hidden. Narrow your search to see them.
          </div>
        )}
        {laneNotice && <span className="sr-only">{laneNotice}</span>}
      </div>
      {/* #2205 — a lane that stopped matching the lane filters (useLaneFilterNotice).
          The text is announced through the live region above; this row is the visible copy. */}
      {laneNotice && (
        <div className="flex items-center gap-2 px-3 py-1 text-xs text-fg-secondary bg-surface border-b border-line shrink-0">
          <span aria-hidden="true" className="min-w-0">{laneNotice}</span>
          <button type="button" onClick={openLaneFilters} className="text-fg-secondary hover:text-fg hover:bg-surface-hover px-2 py-0.5 min-h-6 max-sm:min-h-11 max-sm:px-3 rounded text-xs shrink-0 focus:outline-none focus:ring-2 focus:ring-primary-emphasis">
            Edit lane filters
          </button>
          <button type="button" aria-label="Dismiss notice" onClick={dismissLaneNotice} className="w-6 h-6 max-sm:w-11 max-sm:h-11 rounded hover:bg-surface-hover text-fg-tertiary hover:text-fg flex items-center justify-center shrink-0 focus:outline-none focus:ring-2 focus:ring-primary-emphasis">
            <span aria-hidden="true">×</span>
          </button>
        </div>
      )}
      {/* #2205 — every lane filtered out; takes precedence over the card empty state. */}
      {allLanesFilteredOut && (
        <div role="status" className="mx-4 mt-2 px-4 py-2 bg-surface border border-line rounded-lg text-fg-tertiary text-sm flex items-center gap-3">
          No lanes match your lane filters.
          <button
            type="button"
            onClick={() => {
              // Clears the rules; "Hide lanes with no matching cards" is a setting and stays (#2214).
              const next = { ...effectiveFilters, laneFilter: withLaneItems(effectiveFilters.laneFilter, []) };
              if (!next.laneFilter) delete next.laneFilter;
              setActiveFilterId(null);
              setFilters(next);
            }}
            className="text-fg-secondary hover:text-fg hover:bg-surface-hover px-2 py-1 max-sm:min-h-11 max-sm:px-3 rounded text-xs shrink-0 focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
          >
            Clear lane filters
          </button>
        </div>
      )}
      {(socketStatus === "reconnecting" || socketStatus === "failed") && <BoardOfflineBanner failed={socketStatus === "failed"} />}
      {!canEdit && !blockedByMaintenance && <ViewOnlyNotice />}
      {cardActionNotice}

      {/* Collapsed swimlanes strip — shows count and "Expand all swimlanes" button */}
      {view === "board" && visibleCollapsedLaneCount > 0 && (
        <div className="bg-primary/15 border-b border-primary-emphasis/40 px-4 py-1.5 flex items-center gap-3 text-sm text-info-on-tint shrink-0">
          <svg className="w-3.5 h-3.5 text-info-on-tint shrink-0" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
            <line x1="2" y1="5" x2="14" y2="5" />
            <line x1="2" y1="11" x2="14" y2="11" />
            <polyline points="10,2 13,5 10,8" />
          </svg>
          <span>
            <span className="font-medium text-info-on-tint">{visibleCollapsedLaneCount}</span>
            {" "}
            {visibleCollapsedLaneCount === 1 ? "swimlane" : "swimlanes"} collapsed
          </span>
          <div className="flex-1" />
          <button
            onClick={() => { announceBulk(laneStateMessage(false, board.swimlanes.length)); expandAllSwimlanes(); }}
            className="text-fg-secondary hover:text-fg hover:bg-surface-hover px-2 py-1 max-sm:min-h-11 max-sm:px-3 rounded text-xs shrink-0 focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
          >
            Expand all swimlanes
          </button>
        </div>
      )}

      {/* Focus mode banner — sits outside the scroll container so it does not scroll away */}
      {focusedSwimlaneId !== null && (
        <div className="bg-primary/15 border-b border-primary-emphasis/40 px-4 py-2 flex items-center gap-3 text-sm text-info-on-tint transition-opacity duration-150">
          <svg className="w-3.5 h-3.5 text-info-on-tint shrink-0" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
            <circle cx="8" cy="8" r="3" />
            <line x1="8" y1="1" x2="8" y2="4" />
            <line x1="8" y1="12" x2="8" y2="15" />
            <line x1="1" y1="8" x2="4" y2="8" />
            <line x1="12" y1="8" x2="15" y2="8" />
          </svg>
          <span className="text-info-on-tint">Focused on:</span>
          <span className="font-medium text-info-on-tint truncate max-w-[24rem]">{focusedSwimlane?.name}</span>
          {/* Persistent live region (only its text is conditional) so the cue is announced when rules change. */}
          <span role="status" className="text-xs text-fg-tertiary shrink-0 whitespace-nowrap">
            {focusedLaneFailsRules && (
              <>
                <span aria-hidden="true">·</span> doesn't match lane filters
              </>
            )}
          </span>
          <div className="flex-1" />
          <button onClick={exitFocus} className="text-fg-secondary hover:text-fg hover:bg-surface-hover px-2 py-1 max-sm:min-h-11 max-sm:px-3 rounded text-xs shrink-0 focus:outline-none focus:ring-2 focus:ring-primary-emphasis">
            Exit focus
          </button>
        </div>
      )}

      <div role="status" aria-live="polite" aria-atomic="true" className="sr-only">{dndAnnouncement}</div>
      <div role="status" aria-live="polite" aria-atomic="true" className="sr-only">{overlayAnnouncement}</div>

      {board.columns.length > 0 && (
        <ShowChips
          active={showChip}
          counts={showChipCountsValue}
          onChange={setShowChip}
          columnCount={board.columns.length}
          laneCount={board.swimlanes.length}
          cardCount={showChipCountsValue.all}
          allLanesCollapsed={allLanesCollapsed}
          onToggleLanes={allLanesCollapsed ? onShowAllSwimlanes : onHideAllSwimlanes}
          phone={isPhone}
        />
      )}

      <SectionErrorBoundary section="Board grid">
      <DndContext sensors={selectedCard || peekCardId !== null || isPhone || movesPaused ? noSensors : sensors} onDragStart={handleDragStart} onDragOver={handleDragOver} onDragEnd={handleDragEnd} collisionDetection={collisionDetection}>
        {/* flex-row wrapper lets the activity drawer sit alongside the scroll container */}
        <div className="relative flex flex-row flex-1 min-h-0 overflow-hidden">
        {/*
          Single scroll container — header and body share the same horizontal
          scroll so fixed-width columns always line up.
        */}
        {/* `relative` wrapper around the scroll container ONLY (#1147) — it is what
            the floating overlay legend anchors to. Anchoring to the flex-row above
            would put the legend on top of the activity drawer, and anchoring inside
            the scroller would make it scroll away from the grid it explains. Net
            geometry is unchanged: `flex-1` moves out here, the scroller keeps its own
            inside the new column. */}
        <div className="relative flex-1 min-w-0 flex flex-col min-h-0">
        {/* data-board-scroll: the card detail sheet measures cards inside it (#1914).
            Focusable from script only (tabIndex -1): focus returns here when the
            sheet closes and its card is no longer on the board. */}
        <div ref={setScrollEl} data-board-scroll role="region" aria-label="Board" tabIndex={-1} onPointerDownCapture={markBoardTreePointerEvent} className="board-scroll flex-1 overflow-auto bg-sunken focus:outline-none">
          {/*
            Grid wrapper (#2300) — gives the sticky header row and every lane the
            same width: the scroll box's width, or the grid's minimum when that is
            wider (then the grid scrolls sideways inside this box, never the page).
            Every row below uses the same `gridTemplate`, so tracks line up.
          */}
          {isPhone && emptyBoardPanel}
          {isPhone && noMatchPanel}
          {isPhone && board.columns.length > 0 ? (
            <PhoneBoard
              columns={board.columns.filter((c) => !hiddenColumnIds.has(c.id))}
              swimlanes={board.swimlanes.filter((s) => !renderHiddenSwimlaneIds.has(s.id))}
              cards={board.cards}
              boardId={board.id}
              canEdit={canEdit}
              filteredCardIds={filteredCardIds}
              collapsedSwimlaneIds={collapsedSwimlaneIds}
              showSubColumns={showSubColumns}
              onToggleSwimlane={toggleCollapsedSwimlane}
              selectedCardIds={selectedCardIds}
              highlightedCardId={highlightedCardId}
              currentCardId={selectedCard?.id ?? peekCardId}
              onToggleCardSelection={toggleCardSelection}
              onOpenCardMenu={selectedCard || peekCardId !== null ? undefined : openCardMenu}
              contextTargetCardId={cardMenu && cardMenu.cardIds.length === 1 && !selectedCardIds.has(cardMenu.originId) ? cardMenu.originId : null}
              onCardClick={handleCardClick}
              onCardUpdated={onCardUpdated}
              density={effectiveCardDensity}
              userTimezone={userTimezone}
              currentUserId={currentUser?.id}
              userDateFormat={userDateFormat}
              staleness_threshold_days={board.staleness_threshold_days ?? 14}
              stale_warning_pct={board.stale_warning_pct ?? 50}
              customFieldDefinitions={board.custom_field_definitions}
              isAdmin={isAdmin}
              allColumns={board.columns}
              onEditFieldOrder={canEditSwimlaneFieldOrder(isAdmin, board.swimlane_custom_field_definitions.length) ? openSwimlaneFieldOrder : undefined}
              onManageSwimlaneFields={isAdmin ? openSwimlaneFieldOrder : undefined}
              boardColors={boardColors}
              limitFlags={board}
              members={board.members}
              swimlaneFieldDefinitions={board.swimlane_custom_field_definitions}
              laneDetailsCap={board.lane_details_cap}
              intakeColumnId={intakeColumnId}
              onCardAdded={onCardAdded}
              onColumnUpdated={handleColumnUpdated}
              onRequestDeleteColumn={(col) => setConfirmDeleteColumn(col)}
              onSwimlaneUpdated={handleLocalSwimlaneUpdated}
              onSwimlaneDeleted={onSwimlaneDeleted}
              onAddColumn={() => { setInsertPosition(null); setShowAddColumn(true); }}
              onAddSwimlane={() => { setInsertSwimlanePosition(null); setShowAddSwimlane(true); }}
              focusedSwimlaneId={focusedSwimlaneId}
              onFocusLane={enterFocus}
              onExitFocus={exitFocus}
              addRequest={phoneAddRequest}
              onAddRequestHandled={clearPhoneAddRequest}
              allSwimlanes={board.swimlanes}
              // The drag handlers' reorder paths: same endpoints, optimistic update and rollback.
              onColumnsReordered={(ids) => { void onColumnsReordered(ids); }}
              onSwimlanesReordered={(ids) => { void onSwimlanesReordered(ids); }}
              hardWipEnforced={board.enforce_wip_hard}
              healthAutoEnabled={board.health_auto_enabled}
              showWipAtLimit={board.show_wip_at_limit}
              rollupField={resolveRollupField(board.swimlane_rollup_field, board.custom_field_definitions)}
              hideRowChipFieldNames={board.show_row_chip_field_names === false}
            />
          ) : (
          <div style={{ minWidth: gridMinWidth }} data-testid="board-grid" data-track-floors={gridTrackFloors}>
          {/* Header row — sticky to the top of the scroll container */}
          <div className="grid sticky top-0 z-20 border-b border-line bg-sunken py-1" style={{ gridTemplateColumns: gridTemplate }} data-testid="board-header-row">
            {/* Far-left separator: click inserts column at pos 0 (nothing to its left resizes) */}
            <ColumnSeparator
              isAdmin={isAdmin}
              onOpenAdd={() => { setInsertPosition(0); setShowAddColumn(true); }}
              sepIndex={0}
              hoveredSepIndex={hoveredSepIndex}
              onSepHoverChange={setHoveredSepIndex}
            />

            <SortableContext items={board.columns.map((c) => `col:${c.id}`)} strategy={horizontalListSortingStrategy}>
              {board.columns.map((col, idx) => (
                <React.Fragment key={col.id}>
                  <ColumnHeader
                    showSubColumns={showSubColumns}
                    column={col}
                    cards={board.cards.filter((c) => c.column === col.id)}
                    boardId={board.id}
                    boardColors={boardColors}
                    isIntakeColumn={col.id === intakeColumnId}
                    swimlanes={board.swimlanes}
                    customFieldDefinitions={board.custom_field_definitions}
                    isAdmin={isAdmin}
                    onColumnUpdated={handleColumnUpdated}
                    onRequestDelete={(col) => setConfirmDeleteColumn(col)}
                    collapsed={collapsedColumnIds.has(col.id)}
                    hidden={hiddenColumnIds.has(col.id)}
                    abbreviation={columnAbbreviations.get(col.id)}
                    onToggleCollapse={() => toggleCollapsedColumn(col.id)}
                    hardWipEnforced={board.enforce_wip_hard}
                    showWipAtLimit={board.show_wip_at_limit}
                    // No lane at all (every lane hidden or filtered out) means nothing could hear the
                    // request, so the control is withheld rather than left dead. Collapsed lanes still
                    // count: picking one expands it first (#2317).
                    addCardLanes={addCardLanes}
                    onAddCard={canEdit && col.allow_card_creation && addCardLanes.length > 0
                      ? (swimlaneId) => requestAddCard(col.id, swimlaneId ?? addCardLanes[0].id)
                      : undefined}
                  />
                  <ColumnSeparator
                    isAdmin={isAdmin}
                    onOpenAdd={() => { setInsertPosition(idx + 1); setShowAddColumn(true); }}
                    // A hidden or collapsed 40px stub has no width to drag.
                    currentWidth={isNarrowColumn(col.id) ? undefined : colWidths.get(col.id)}
                    setWidth={isNarrowColumn(col.id) ? undefined : (w) => setColumnWidth(col.id, w)}
                    sepIndex={idx + 1}
                    hoveredSepIndex={hoveredSepIndex}
                    onSepHoverChange={setHoveredSepIndex}
                  />
                </React.Fragment>
              ))}
            </SortableContext>

            {activeColumn && altHeldDuringColumnDrag && <ColumnTrashZone />}
          </div>

          {/* #2324 — the empty board's panel sits below the column headers, above the lanes. */}
          {emptyBoardPanel}

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
                const visible = board.swimlanes.filter((s) => !renderHiddenSwimlaneIds.has(s.id));
                return visible.map((swimlane, idx) => (
                  <React.Fragment key={swimlane.id}>
                    <RowSeparator
                      isAdmin={isAdmin}
                      onInsert={() => { setInsertSwimlanePosition(idx); setShowAddSwimlane(true); }}
                      currentHeight={idx > 0 ? (viewPrefs.swimlaneHeights[visible[idx - 1].id] ?? undefined) : undefined}
                      setHeight={idx > 0 ? (h) => setSwimlaneHeight(visible[idx - 1].id, h) : undefined}
                      gridTemplate={gridTemplate}
                      columnCount={board.columns.length}
                      hoveredSepIndex={hoveredSepIndex}
                    />
                    <SwimlaneRow
                      healthAutoEnabled={board.health_auto_enabled}
                      swimlane={swimlane}
                      gridTemplate={gridTemplate}
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
                      noMatch={noCardMatch}
                      selectedCardIds={selectedCardIds}
                      highlightedCardId={highlightedCardId}
                      currentCardId={selectedCard?.id ?? peekCardId}
                      onToggleCardSelection={toggleCardSelection}
                      // No context menu while the card sheet is open (#2059): the
                      // menu would take focus out of the aria-modal sheet, the same
                      // reason the selection checkbox is withheld (#1914). ⌘K acts
                      // on the open card instead.
                      onOpenCardMenu={selectedCard || peekCardId !== null ? undefined : openCardMenu}
                      contextTargetCardId={cardMenu && cardMenu.cardIds.length === 1 && !selectedCardIds.has(cardMenu.originId) ? cardMenu.originId : null}
                      showSubColumns={showSubColumns}
                      onCardClick={handleCardClick}
                      onCardAdded={onCardAdded}
                      onSwimlaneUpdated={handleLocalSwimlaneUpdated}
                      onSwimlaneDeleted={onSwimlaneDeleted}
                      collapsed={collapsedSwimlaneIds.has(swimlane.id)}
                      onToggleCollapse={() => toggleCollapsedSwimlane(swimlane.id)}
                      onFocus={enterFocus}
                      onExitFocus={exitFocus}
                      isFocused={focusedSwimlaneId === swimlane.id}
                      density={effectiveCardDensity}
                      userTimezone={userTimezone} currentUserId={currentUser?.id}
                      userDateFormat={userDateFormat}
                      compact={cardLayout === "compact"}
                      staleness_threshold_days={board.staleness_threshold_days ?? 14}
                      stale_warning_pct={board.stale_warning_pct ?? 50}
                      customFieldDefinitions={board.custom_field_definitions}
                      swimlaneFieldDefinitions={board.swimlane_custom_field_definitions}
              laneDetailsCap={board.lane_details_cap}
                      hideRowChipFieldNames={board.show_row_chip_field_names === false}
                      onEditFieldOrder={canEditSwimlaneFieldOrder(isAdmin, board.swimlane_custom_field_definitions.length) ? openSwimlaneFieldOrder : undefined}
                      onManageSwimlaneFields={isAdmin ? openSwimlaneFieldOrder : undefined}
                      onCardUpdated={onCardUpdated}
                      overlayCells={gridOverlayState?.cells}
                      overlayLabel={gridOverlayState?.label}
                      limitFlags={board}
                      members={board.members}
                      boardColors={boardColors}
                      showWipAtLimit={board.show_wip_at_limit}
                      rollupField={resolveRollupField(board.swimlane_rollup_field, board.custom_field_definitions)}
                      getDropVerdict={getDropVerdict}
                      getEntryCriteria={getEntryCriteria}
                    />
                  </React.Fragment>
                ));
              })()}
              {/* Bottom separator — resizes the last swimlane */}
              {(() => {
                const visible = board.swimlanes.filter((s) => !renderHiddenSwimlaneIds.has(s.id));
                const last = visible[visible.length - 1];
                return (
                  <RowSeparator
                    isAdmin={isAdmin}
                    onInsert={() => { setInsertSwimlanePosition(null); setShowAddSwimlane(true); }}
                    currentHeight={last ? (viewPrefs.swimlaneHeights[last.id] ?? undefined) : undefined}
                    setHeight={last ? (h) => setSwimlaneHeight(last.id, h) : undefined}
                    gridTemplate={gridTemplate}
                    columnCount={board.columns.length}
                    hoveredSepIndex={hoveredSepIndex}
                  />
                );
              })()}
            </SortableContext>
          )}
          {/* #2324 — below the lanes, each shrunk to its band. */}
          {noMatchPanel}

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
          </div>
          )}{/* end grid wrapper */}
        </div>{/* end board-scroll */}
        {gridOverlayState && (
          <GridOverlayLegend
            state={gridOverlayState}
            isDragging={activeCard !== null || activeColumn !== null || activeSwimlane !== null}
            isLargeViewport={isLargeViewport}
          />
        )}
        {/* #1146 — bottom-centered in the same anchor as the legend, above it
            (z-50 vs z-30), so it never covers the activity drawer. */}
        </div>{/* end legend anchor */}

        {drawerOpen && (
          <BoardActivityDrawer
            feed={activityFeed}
            onClose={() => setDrawerOpen(false)}
            onOpenHistory={() => setSearchParams({ view: "history" }, { replace: true })}
            tab={drawerView ?? "recent"}
            onTabChange={setDrawerView}
            archivedContent={
              <ArchivedCardsPanel
                board={board}
                onClose={() => setDrawerView(null)}
                onUnarchived={(card) => { onCardUnarchived(card); }}
                currentUser={currentUser}
                subscribeCardEvents={subscribeCardEvents}
              />
            }
          />
        )}
        </div>{/* end flex-row wrapper */}

        <DragOverlay>
          {activeCard && <CardItem card={activeCard} overlay canEdit={canEdit} density={effectiveCardDensity} userTimezone={userTimezone} currentUserId={currentUser?.id} userDateFormat={userDateFormat} compact={cardLayout === "compact"} staleness_threshold_days={board.staleness_threshold_days ?? 14} stale_warning_pct={board.stale_warning_pct ?? 50} inDoneColumn={board.columns.find((c) => c.id === activeCard.column)?.is_done ?? false} customFieldDefinitions={board.custom_field_definitions} />}
          {activeColumn && (
            // No width of its own: DragOverlay sizes its wrapper from the dragged header
            // cell's rect, and a saved width is a track weight, not px (#2300).
            <div className="w-full px-3 py-3 border border-info bg-surface rounded shadow-xl opacity-90 overflow-hidden" data-testid="column-drag-overlay">
              <div className="flex items-center gap-2 min-w-0">
                <span className="color-dot w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: activeColumn.color }} />
                <span className="font-semibold text-fg-secondary text-sm truncate" title={activeColumn.name}>{activeColumn.name}</span>
              </div>
              {/* Discoverability hint for the ⌥-gated trash zone (#965). The hint
                  flips colour when Alt is held so the user knows the gesture is
                  armed. Reorder is the default; deletion is a deliberate opt-in. */}
              {altHeldDuringColumnDrag ? (
                <div className="text-xs text-danger mt-1.5" aria-live="polite">Drop on trash to delete</div>
              ) : (
                <div className="text-xs text-fg-muted mt-1.5">Hold ⌥ to delete</div>
              )}
            </div>
          )}
          {activeSwimlane && (
            <div className="px-3 py-3 border border-info bg-surface rounded shadow-xl opacity-90 flex items-center gap-2 w-64">
              <span className="w-3 h-3 rounded-[3px] shrink-0" style={{ backgroundColor: activeSwimlane.color }} />
              <span className="font-semibold text-fg text-sm truncate">{activeSwimlane.name}</span>
            </div>
          )}
        </DragOverlay>
      </DndContext>
      </SectionErrorBoundary>

      {cardMenu && (() => {
        const menuCards = cardMenu.cardIds.map((id) => board.cards.find((c) => c.id === id)).filter((c): c is Card => !!c);
        if (menuCards.length === 0) return null;
        return (
          <CardContextMenu
            anchor={cardMenu.anchor}
            label={menuCards.length === 1 ? `Card actions: ${menuCards[0].title}` : `Actions for ${menuCards.length} cards`}
            header={menuCards.length > 1 ? `${menuCards.length} cards` : undefined}
            entries={cardActionEntries(menuCards, cardActionContext)}
            columns={board.columns}
            members={board.members}
            reorder={menuCards.length === 1 ? [
              ...reorderChoices(cellOrderOf(board.cards, menuCards[0], filteredCardIds, board.columns.find((c) => c.id === menuCards[0].column))),
              ...subColumnChoices(subColumnNeighbors(menuCards[0], board.columns)),
            ] : []}
            onAction={(action, value) => {
              const ids = menuCards.map((c) => c.id);
              closeCardMenu("action");
              if (action === "move" && (value === "earlier" || value === "later")) {
                reorderCardInCell(menuCards[0], value);
                return;
              }
              if (action === "move" && (value === "sub-previous" || value === "sub-next")) {
                stepCardSubColumn(menuCards[0], value);
                return;
              }
              void runCardAction(ids, action, value);
            }}
            onClose={closeCardMenu}
          />
        );
      })()}

      {deleteTargetIds && (() => {
        const delCards = deleteTargetIds.map((id) => board.cards.find((c) => c.id === id)).filter((c): c is Card => !!c);
        return (
          <CardDeleteConfirm
            boardId={board.id}
            cards={delCards}
            canModifyAll={isAdmin || isBoardModerator}
            currentUserId={currentUser?.id ?? null}
            actionContext={cardActionContext}
            onDeleted={(ids) => {
              ids.forEach((id) => onCardDeleted(id));
              const sel = cardActionStateRef.current.selectedCardIds;
              if (ids.length === deleteTargetIds.length && deleteTargetIds.every((id) => sel.has(id)) && sel.size === ids.length) clearSelection();
            }}
            onClose={(failure, canceled) => {
              const firstId = deleteTargetIds[0];
              setDeleteTargetIds(null);
              const sel = cardActionStateRef.current.selectedCardIds;
              const wholeSelection = delCards.length === sel.size && delCards.every((c) => sel.has(c.id));
              if (failure) reportCardAction(failure, "failed", wholeSelection);
              else if (!canceled && delCards.length > 0) reportCardAction(successMessage("delete", delCards), "shown");
              setTimeout(() => focusCardOrBoard(firstId), 0);
            }}
          />
        );
      })()}
      {/* The shared toast region renders here: the next DOM sibling after the
          grid and before BulkActionToolbar, so one Tab from the focused card
          reaches the first toast action (frontend/CLAUDE.md § Toasts). */}
      <ToastRegionSlot />

      {selectedCardIds.size > 0 && canEdit && (
        <BulkActionToolbar
          board={board}
          selectedCardIds={selectedCardIds}
          onCardsUpdated={(cards) => cards.forEach((c) => onCardUpdated(c))}
          onCardsDeleted={(ids) => ids.forEach((id) => { onCardDeleted(id); })}
          onCardsArchived={(ids) => { ids.forEach((id) => { onCardArchived(id); }); if (ids.length > 0) showArchiveToast(); }}
          onClearSelection={clearSelection}
          currentUser={currentUser}
          cardActionCtx={cardActionContext}
          message={bulkMessage}
          onMessageChange={setBulkMessage}
        />
      )}

      {peekCard && !selectedCard && (
        <SectionErrorBoundary section="Card peek">
          <CardPeekSheet
            key={peekCard.id}
            card={peekCard}
            board={board}
            canEdit={canEdit}
            onClose={() => setPeekCardId(null)}
            onOpenCard={(card) => { setPeekCardId(null); setSelectedCard(card); }}
            onMoveCard={async (...args) => onMoveCard(...args)}
            onForceMoveCard={(...args) => forceMoveCardTo(...args)}
            movesPaused={movesPaused}
            // Phone only (#2277): reorder within the cell, which on the grid is a drag.
            // Over the cards the filter shows, as PhoneBoard does.
            cellOrder={isPhone ? cellOrderOf(board.cards, peekCard, filteredCardIds, board.columns.find((c) => c.id === peekCard.column)) : undefined}
            userDateFormat={userDateFormat}
            userTimezone={userTimezone}
          />
        </SectionErrorBoundary>
      )}

      {selectedCard && (
        <SectionErrorBoundary section="Card detail">
          <CardDetail
            // Remount on card change (#449). CardDetail seeds localCard and its
            // collapsible-section state from useState(card) initializers. Its only
            // prop-sync is a version-keyed effect for the Move popover and the
            // card's location (#1773), so without a key, opening a different card from
            // a relation row would render the previous card's title, weight and
            // relations while the new card's data loads.
            key={selectedCard.id}
            card={liveSelectedCard ?? selectedCard}
            board={board}
            onClose={() => setSelectedCard(null)}
            onDeleted={(id) => { onCardDeleted(id); setSelectedCard(null); }}
            onUpdated={onCardUpdated}
            onArchived={(id) => { onCardArchived(id); setSelectedCard(null); showArchiveToast(); }}
            // Forward every argument: the fifth, gatesPassed, is the chosen sub-column stop (#1102).
            onMoveCard={async (...args) => onMoveCard(...args)}
            onForceMoveCard={(...args) => forceMoveCardTo(...args)}
            movesPaused={movesPaused}
            // Phone only (#2359): the peek sheet's reorder, in the detail panel a tap opens (#2358).
            cellOrder={isPhone ? cellOrderOf(board.cards, liveSelectedCard ?? selectedCard, filteredCardIds, board.columns.find((c) => c.id === (liveSelectedCard ?? selectedCard)?.column)) : undefined}
            userDateFormat={userDateFormat}
            userTimeFormat={userTimeFormat}
            userTimezone={userTimezone}
            currentUser={currentUser}
            closeEditorOnEnter={closeEditorOnEnter}
            refreshSignal={cardDetailRefreshTick}
            childrenRefreshSignal={childrenRefreshTick}
            blockFormRequest={blockFormRequest}
            tabRequest={tabRequest}
            backToParentId={childrenNav?.cardId === selectedCard.id ? childrenNav.fromParent : null}
            focusChildId={childrenNav?.cardId === selectedCard.id ? childrenNav.focusChild : null}
          />
        </SectionErrorBoundary>
      )}

      {isAdmin && showAddColumn && (
        <AddColumnModal
          boardId={board.id}
          boardColors={boardColors}
          willBecomeIntake={wouldBecomeIntakeColumn(board.columns, insertPosition)}
          replacesIntake={intakeColumnId !== null}
          onAdded={handleColumnAdded}
          onClose={() => { setShowAddColumn(false); setInsertPosition(null); }}
        />
      )}

      {isAdmin && showAddSwimlane && (
        <AddSwimlaneModal
          boardId={board.id}
          boardColors={boardColors}
          onAdded={(swimlane) => { handleSwimlaneAdded(swimlane); setShowAddSwimlane(false); setInsertSwimlanePosition(null); }}
          onClose={() => { setShowAddSwimlane(false); setInsertSwimlanePosition(null); }}
        />
      )}

      {showSettings && (
        <BoardSettingsModal
          board={board}
          isAdmin={isAdmin}
          onClose={closeSettings}
          initialTab={settingsInitialTab}
          focusFirstStoppedWebhook={webhookDeepLink}
          webhookChange={webhookChange}
          webhookReconnectSignal={socketReconnectSeq}
          webhookSocketStatus={socketStatus}
          currentUserHasPassword={currentUser?.has_usable_password !== false}
          viewPrefs={viewPrefs}
          onToggleHiddenColumn={toggleHiddenColumn}
          onToggleHiddenSwimlane={toggleHiddenSwimlane}
          onBoardDeleted={onBoardDeleted}
          onBoardDeleting={() => { selfDeletingRef.current = true; }}
          onBoardDeleteFailed={() => { selfDeletingRef.current = false; }}
          currentUserId={currentUser?.id ?? null}
          onDeleteForbidden={silentReload}
          onUpdateBoardSettings={onUpdateBoardSettings}
          onShowChildCards={() => { closeSettings(); setFilters({ ...effectiveFiltersRef.current, parentFilter: "any" }); }}
          onMergeBoardFields={mergeBoardState}
          cardDensityOverride={cardDensityOverride}
          onSetCardDensityOverride={setCardDensityOverride}
          densityPresetSource={boardPreset.densitySource}
          effectiveCardDensity={effectiveCardDensity}
          gitLensEnabled={gitLensEnabled}
          lensConnection={lensConnection}
          onManageLens={() => { closeSettings(); setShowLensModal(true); }}
          onFieldsUpdated={onCustomFieldDefinitionsApplied}
          onSwimlaneFieldsUpdated={onSwimlaneFieldDefinitionsApplied}
          onUpdateSwimlane={onSwimlaneUpdated}
          demoMode={demoMode}
          currentUserIsSiteAdmin={currentUser?.is_site_admin === true}
          inviteReloadSignal={inviteReloadSignal}
          onMembersAdded={reloadForMemberFlag}
          // #1935: share-link state (never the token) back into board state.
          onShareChanged={mergeBoardState}
          shareLinkIssuedAt={shareLinkIssuedAt}
          onColumnUpdated={handleColumnUpdated}
        />
      )}

      {showLensModal && isAdmin && gitLensEnabled && (
        <LensConnectionModal
          boardId={board.id}
          connection={lensConnection}
          onSaved={(conn) => { setLensConnection(conn); setShowLensModal(false); }}
          onRemoved={() => {
            setLensConnection(null);
            setShowLensModal(false);
            // No explicit view fallback needed: clearing the connection flips
            // showLensTab false, and the effect above redirects lens → board.
            // (This modal only mounts in the board-view render path anyway.)
          }}
          onClose={() => setShowLensModal(false)}
        />
      )}

      {showShortcuts && (
        <KeyboardShortcutsOverlay
          onClose={() => setShowShortcuts(false)}
          onRestartTour={currentUser ? async () => {
            await replayTour();
            setShowShortcuts(false);
          } : undefined}
          showLens={showLensTab}
        />
      )}

      {/* CommandPalette is owned by GlobalCommandPalette at the BoardPage /
          shell level. BoardView consumes its events via the window listener
          registered above (visiban:open-card / filter-my-cards / show-history /
          open-settings / open-shortcuts). See #869. */}

      {showExport && (
        <BoardExportModal
          boardId={board.id}
          onClose={() => setShowExport(false)}
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

      {pendingPolicyMove && (() => {
        const { cardId, columnId, swimlaneId, position } = pendingPolicyMove;
        const card = board.cards.find((c) => c.id === cardId);
        const target = board.columns.find((c) => c.id === columnId);
        const source = card ? board.columns.find((c) => c.id === card.column) : undefined;
        // The card or a column went away over the socket: the effect above
        // cancels the held move on this same commit.
        if (!card || !target || !source) return null;
        return (
          <PolicyConfirmModal
            // The criteria text is in the key: an admin editing the policy
            // over the socket while this is open remounts it with every box
            // unchecked, so a new criterion can never be skipped.
            key={`${cardId}:${columnId}:${entryCriteriaFor(card, target).join("\u0001")}`}
            cardTitle={card.title}
            targetColumnName={target.name}
            sourceColumnName={source.name}
            criteria={entryCriteriaFor(card, target)}
            onConfirm={() => {
              setPendingPolicyMove(null);
              commitCardMove(card, columnId, swimlaneId, position, pendingPolicyMove.gatesPassed);
              focusCardSoon(cardId);
            }}
            onCancel={() => {
              setPendingPolicyMove(null);
              setDndAnnouncement(`Move canceled, card '${card.title}' stays in column '${source.name}'`);
              focusCardSoon(cardId);
            }}
          />
        );
      })()}

      {confirmDeleteColumn && (() => {
        const cardCount = board.cards.filter((c) => c.column === confirmDeleteColumn.id).length;
        // Name-typed confirmation is required when the column has cards (#965).
        // Empty columns keep the simple Cancel/Delete flow because there's nothing
        // destructive to mistype against. Pattern mirrors the board-deletion
        // danger-zone in BoardSettingsModal.
        const requireType = cardCount > 0;
        const canConfirm = !requireType || deleteColumnInput === confirmDeleteColumn.name;
        const closeDialog = () => {
          setConfirmDeleteColumn(null);
          setDeleteColumnInput("");
        };
        return (
          <ModalWrapper
            open
            onClose={closeDialog}
            title="Delete column?"
            maxWidth="max-w-sm"
            // #2204 class: the column header (the opener) unmounts with the column, so focus goes
            // to the stable board scroll region (tabIndex -1) instead of <body>.
            restoreFocusTo={() => scrollEl}
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
              If the column contains any archived cards, they will also be permanently deleted.
            </p>
            <p className="text-fg-muted text-sm mb-5">This cannot be undone.</p>
            {requireType && (
              <div className="mb-5">
                <label htmlFor="delete-column-confirm-input" className="block text-xs text-fg-muted mb-1">
                  Type <span className="text-fg-secondary font-mono">{confirmDeleteColumn.name}</span> to confirm deletion.
                </label>
                <input
                  id="delete-column-confirm-input"
                  type="text"
                  autoFocus
                  value={deleteColumnInput}
                  onChange={(e) => setDeleteColumnInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !isImeComposing(e) && canConfirm) {
                      e.preventDefault();
                      // onColumnDeleted (useBoard.removeColumn) does its own
                      // optimistic update + reload-on-failure and never rejects.
                      void onColumnDeleted(confirmDeleteColumn.id);
                      closeDialog();
                    }
                  }}
                  placeholder={confirmDeleteColumn.name}
                  className="w-full bg-surface border border-line rounded px-3 py-1.5 text-sm text-fg-secondary focus:outline-none focus:ring-2 focus:ring-danger-emphasis focus:border-transparent placeholder-fg-muted"
                />
              </div>
            )}
            <div className="flex items-center justify-end gap-3">
              <button
                onClick={closeDialog}
                className="text-fg-secondary hover:text-fg hover:bg-surface-hover px-3 py-1.5 text-sm rounded transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
              >
                Cancel
              </button>
              <button
                onClick={() => {
                  // onColumnDeleted (useBoard.removeColumn) does its own
                  // optimistic update + reload-on-failure and never rejects.
                  void onColumnDeleted(confirmDeleteColumn.id);
                  closeDialog();
                }}
                disabled={!canConfirm}
                className="bg-danger-bg hover:bg-danger-bg-hover text-on-danger px-3 py-1.5 text-sm rounded font-medium focus:outline-none focus:ring-2 focus:ring-danger-emphasis disabled:opacity-40 disabled:cursor-not-allowed"
              >
                Delete
              </button>
            </div>
          </ModalWrapper>
        );
      })()}
    </RollupLoadingContext.Provider>
  );
}
