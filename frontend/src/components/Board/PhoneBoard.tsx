import { LaneTierDetails } from "./LaneFieldGrid";
import { inProgressChip } from "../../utils/childrenMode";
import { useState, useId, useRef, useEffect, useLayoutEffect, useCallback } from "react";
import { cardSubColumnIndex, getTrackStates, stageSubColumns } from "../../utils/stages";
import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";
import type { Card, CardDensity, Column, CustomFieldDefinition, EffectiveBoardMember, Swimlane, SwimlaneCustomFieldDefinition } from "../../types";
import { createCard } from "../../api/cards";
import LaneTeamAssignee from "./LaneTeamAssignee";
import { laneCaption, laneDefaultAssignee } from "../../utils/swimlaneDefaultTeam";
import { limitBlockedMessage } from "./moveBlockedMessages";
import EditSwimlaneModal from "./EditSwimlaneModal";
import EditColumnModal from "./EditColumnModal";
import ActiveMark from "../Common/ActiveMark";
import type { BoardColor } from "../../utils/boardColors";
import type { LimitFlags } from "../../utils/placementLimits";
import { BAND_DEFAULT_COUNT, DEFAULT_LANE_DETAILS_CAP, laneBandLimit, laneTierFields, type LaneBandField } from "../../utils/laneBand";
import { laneRollup } from "../../utils/laneRollup";
import SwimlaneLimitStat from "./SwimlaneLimitStat";
import CustomFieldValueDisplay from "../Card/CustomFieldValueDisplay";
import CardItem from "../Card/CardItem";
import type { CardMenuAnchor } from "../Card/CardContextMenu";
import { columnTintStyle } from "../../utils/colorContrast";
import { STATUS_LABEL, cardBoardStatus } from "../../constants/laneStatus";
import ColumnPolicyPopover from "./ColumnPolicyPopover";
import { columnPolicy, policyCountSummary } from "../../utils/columnPolicy";
import HealthStatusControl from "../Common/HealthStatusControl";
import type { HealthStatus } from "../../constants/healthStatus";
import { laneHealthAuto, laneHealthFields } from "../../utils/healthStatus";
import { patchSwimlane } from "../../api/boards";
import { stepOrder } from "../../utils/phoneReorder";

interface Props {
  columns: Column[];
  swimlanes: Swimlane[];
  cards: Card[];
  boardId: number;
  canEdit: boolean;
  /** Cards that pass the filter and the Show chip; null means no filter. */
  filteredCardIds: Set<number> | null;
  collapsedSwimlaneIds: Set<number>;
  onToggleSwimlane: (swimlaneId: number) => void;
  selectedCardIds: Set<number>;
  highlightedCardId?: number | null;
  currentCardId?: number | null;
  onToggleCardSelection: (cardId: number) => void;
  onCardClick: (card: Card, opts?: { peek?: boolean }) => void;
  onOpenCardMenu?: (card: Card, anchor: CardMenuAnchor) => void;
  contextTargetCardId?: number | null;
  onCardUpdated?: (card: Card) => void;
  density?: CardDensity;
  userTimezone?: string;
  currentUserId?: number;
  userDateFormat?: string;
  staleness_threshold_days?: number;
  stale_warning_pct?: number;
  customFieldDefinitions?: CustomFieldDefinition[];
  /** Editing surfaces (#2277): the same gates and modals as the grid, so phones lose no controls. */
  isAdmin?: boolean;
  /** #2439 — `Board.lane_details_cap`, for `resolveLaneTiers` (a board with no tiers set grows it to fit, #2658). */
  laneDetailsCap?: number;
  allColumns?: Column[];
  /** Admin shortcut from the open field grid to Board settings -> Swimlane fields, as on the grid band. */
  onEditFieldOrder?: () => void;
  /** "Manage swimlane fields" in the tiered details footer (#2439): admin-only, no field-count gate. */
  onManageSwimlaneFields?: () => void;
  boardColors?: BoardColor[];
  limitFlags?: LimitFlags;
  /** Board members, for Edit swimlane's Default team (#2211). */
  members?: EffectiveBoardMember[];
  swimlaneFieldDefinitions?: SwimlaneCustomFieldDefinition[];
  intakeColumnId?: number | null;
  onCardAdded?: (card: Card) => void;
  onColumnUpdated?: (column: Column) => void;
  onRequestDeleteColumn?: (column: Column) => void;
  onSwimlaneUpdated?: (swimlane: Swimlane) => void;
  onSwimlaneDeleted?: (swimlaneId: number) => void;
  onAddColumn?: () => void;
  onAddSwimlane?: () => void;
  focusedSwimlaneId?: number | null;
  onFocusLane?: (swimlaneId: number) => void;
  onExitFocus?: () => void;
  /**
   * The Children lane action (#2370 way in 1, item 12), on a board where cards can have children: always shown on
   * touch, for everyone; opens Children mode at the lane. `counts` holds the server's in-progress counts, absent until they land.
   */
  childrenAction?: { counts: Map<number, number>; onOpen: (swimlaneId: number) => void };
  /** Asks the board to open the add-card input for a cell (header "+", empty-board button). */
  addRequest?: { columnId: number; swimlaneId: number; nonce: number } | null;
  /** Called once `addRequest` is acted on, so the board can clear it and a remount does not replay it. */
  onAddRequestHandled?: () => void;
  /** Hidden swimlanes included, for Move earlier / Move later on a lane (#2277). */
  allSwimlanes?: Swimlane[];
  /** The drag handlers' reorder paths (useBoard.reorderColumns / reorderSwimlanes), admins only. */
  onColumnsReordered?: (orderedIds: number[]) => void;
  onSwimlanesReordered?: (orderedIds: number[]) => void;
  /** board.enforce_wip_hard: the over-limit line carries the hard-limit glyph, as the grid header does. */
  hardWipEnforced?: boolean;
  /** board.health_auto_enabled (#2245): a computed lane health shows as a pill too. */
  healthAutoEnabled?: boolean;
  /** board.show_wip_at_limit (#973): the lane limit line's "at limit" state, as on the grid band (#2329). */
  showWipAtLimit?: boolean;
  /** The board's swimlane rollup field (#2275, `resolveRollupField`); null: no rollup on the band. */
  rollupField?: CustomFieldDefinition | null;
  /** board.show_row_chip_field_names is off (#1418): lane fields show values without names. */
  hideRowChipFieldNames?: boolean;
  /** View menu "Show sub-columns" (#2531): off renders a split stage as one list with no switcher, as the grid does. */
  showSubColumns?: boolean;
}

const NO_FLAGS: LimitFlags = { enforce_wip_limits: false, enforce_wip_hard: false, enforce_weight_limits: false };

/** Same rule as the grid band (SwimlaneRow): a set or, on an auto board, computed status shows a pill. */
function lanePillVisible(lane: Swimlane, autoEnabled: boolean): boolean {
  if (laneHealthFields(lane).effective_health_status !== null) return true;
  return autoEnabled && !!lane.health_computed_at;
}

/**
 * Lane health status on the phone band (#2277, #2243): the grid band's control,
 * outside the collapse button, at 44px. Admins set it; everyone else sees a set
 * status read-only, and an unset lane shows nothing to them (as in the grid).
 */
function PhoneLaneHealth({ lane, boardId, isAdmin, autoEnabled, onSwimlaneUpdated }: {
  lane: Swimlane; boardId: number; isAdmin: boolean; autoEnabled: boolean; onSwimlaneUpdated?: (s: Swimlane) => void;
}) {
  const [announcement, setAnnouncement] = useState("");
  const [focus, setFocus] = useState(false);
  // The open trigger stays mounted until it closes, even if a save swaps pill and icon.
  const [openAs, setOpenAs] = useState<"pill" | "icon" | null>(null);
  const pillVisible = lanePillVisible(lane, autoEnabled);
  const trigger = openAs ?? (pillVisible ? "pill" : "icon");
  const triggerRef = useRef(trigger);
  triggerRef.current = trigger;
  const onOpenChange = useCallback((o: boolean) => setOpenAs(o ? triggerRef.current : null), []);
  const clearFocus = useCallback(() => setFocus(false), []);
  const save = useCallback(async (next: HealthStatus | null) => {
    const updated = await patchSwimlane(boardId, lane.id, { health_status: next });
    onSwimlaneUpdated?.(updated);
    // The new trigger (pill or icon) takes focus when the save swaps them.
    if (lanePillVisible(updated, autoEnabled) !== lanePillVisible(lane, autoEnabled)) setFocus(true);
    return { effective_health_status: laneHealthFields(updated).effective_health_status };
  }, [boardId, lane, onSwimlaneUpdated, autoEnabled]);
  if (!pillVisible && !isAdmin && openAs === null) return null;
  return (
    <span className="inline-flex items-center" data-testid="phone-lane-health">
      <HealthStatusControl
        entityKind="swimlane"
        mode="basic"
        entityName={lane.name}
        parentName={null}
        canEdit={isAdmin}
        scope="lane"
        trigger={trigger}
        onSave={save}
        onAnnounce={setAnnouncement}
        autoFocus={focus}
        onAutoFocused={clearFocus}
        onOpenChange={onOpenChange}
        auto={laneHealthAuto(lane, autoEnabled)}
        className="!min-h-11 !min-w-11 !opacity-100"
        {...laneHealthFields(lane)}
      />
      <span role="status" aria-live="polite" className="sr-only">{announcement}</span>
    </span>
  );
}

const ACTION_BTN = "inline-flex items-center justify-center min-h-11 px-3 text-sm rounded border border-line-strong text-fg hover:bg-surface-hover focus:outline-none focus:ring-2 focus:ring-primary-emphasis";

/**
 * Phone layout of the board (#2277, board-redesign.md § Phone width): one column
 * at a time, lanes stacked. There is no drag here: moving a card uses the card's
 * "More actions" menu (Move to column), the same path as the keyboard, and
 * reordering uses Move earlier / Move later (columns and lanes here, cards in
 * the peek sheet), which call the same reorder and move paths as a drop.
 *
 * Why a separate component rather than a CSS-only squeeze of the grid: the grid
 * is a shared track template for the header row, every lane and every strip, and
 * a one-column view needs none of it.
 */
export default function PhoneBoard({
  columns, swimlanes, cards, boardId, canEdit, filteredCardIds, collapsedSwimlaneIds, onToggleSwimlane,
  selectedCardIds, highlightedCardId, currentCardId, onToggleCardSelection, onCardClick, onOpenCardMenu,
  contextTargetCardId, onCardUpdated, density, userTimezone, currentUserId, userDateFormat,
  staleness_threshold_days, stale_warning_pct, customFieldDefinitions,
  isAdmin = false, laneDetailsCap = DEFAULT_LANE_DETAILS_CAP, allColumns, onEditFieldOrder, onManageSwimlaneFields, boardColors, limitFlags, members, swimlaneFieldDefinitions, intakeColumnId = null,
  onCardAdded, onColumnUpdated, onRequestDeleteColumn, onSwimlaneUpdated, onSwimlaneDeleted,
  onAddColumn, onAddSwimlane, focusedSwimlaneId = null, onFocusLane, onExitFocus, childrenAction, addRequest = null,
  onAddRequestHandled, allSwimlanes, onColumnsReordered, onSwimlanesReordered, hardWipEnforced = false,
  healthAutoEnabled = false, showWipAtLimit = false, rollupField = null, hideRowChipFieldNames = false,
  showSubColumns = true,
}: Props) {
  const ordered = [...columns].sort((a, b) => a.position - b.position);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const uid = useId();
  // Arrow/Home/End on a column tab focus the newly selected tab in a layout effect (focus rule 3, #2608, #2632).
  const [focusTabId, setFocusTabId] = useState<{ id: number } | null>(null);
  useLayoutEffect(() => {
    if (focusTabId) document.getElementById(`${uid}-tab-${focusTabId.id}`)?.focus();
  }, [focusTabId, uid]);
  const [addingLane, setAddingLane] = useState<number | null>(null);
  const [draft, setDraft] = useState("");
  const [addError, setAddError] = useState<string | null>(null);
  // #2211: the lane whose composer had its pre-assigned team member removed (Unassign).
  const [unassignedLane, setUnassignedLane] = useState<number | null>(null);
  const [editingLane, setEditingLane] = useState<number | null>(null);
  // Which tab EditColumnModal opens on, or null when closed; "policy" comes from the policy popover's Edit.
  const [editTab, setEditTab] = useState<"settings" | "policy" | "stage" | null>(null);
  const [policyRect, setPolicyRect] = useState<DOMRect | null>(null);
  const policyTriggerRef = useRef<HTMLButtonElement>(null);
  const closePolicy = useCallback(() => setPolicyRect(null), []);
  const lastRequest = useRef<number | null>(null);
  // Lanes whose field grid is open (#2329), per lane as on the grid band.
  const [openFieldLanes, setOpenFieldLanes] = useState<Set<number>>(() => new Set());
  // Phone sub-column switcher (#2278): which sub-column of a split stage is shown.
  const [subIndex, setSubIndex] = useState(0);
  // #2384: admin controls rest behind one "Column actions" / "Lane actions" disclosure so a 390px
  // board shows cards, not rows of buttons. Lanes track their own open state.
  const [columnActionsOpen, setColumnActionsOpen] = useState(false);
  const [openLaneActions, setOpenLaneActions] = useState<Set<number>>(() => new Set());
  const toggleLaneActions = (laneId: number) => setOpenLaneActions((prev) => {
    const next = new Set(prev);
    if (!next.delete(laneId)) next.add(laneId);
    return next;
  });
  // Each column starts on its first sub-column; the index is not carried across columns.
  useEffect(() => { setSubIndex(0); }, [selectedId]);
  const toggleLaneFields = (laneId: number) => setOpenFieldLanes((prev) => {
    const next = new Set(prev);
    if (!next.delete(laneId)) next.add(laneId);
    return next;
  });

  // A request from outside (the empty-board button) selects the column, expands the lane
  // and opens the input; the nonce makes a repeated request for the same cell fire again.
  useEffect(() => {
    if (!addRequest || lastRequest.current === addRequest.nonce) return;
    lastRequest.current = addRequest.nonce;
    setSelectedId(addRequest.columnId);
    if (collapsedSwimlaneIds.has(addRequest.swimlaneId)) onToggleSwimlane(addRequest.swimlaneId);
    setAddingLane(addRequest.swimlaneId);
    setDraft("");
    setAddError(null);
    // Cleared upstream (as the grid clears pendingAddCard): a remount, e.g. rotating
    // to landscape and back, must not reopen the input in the old column.
    onAddRequestHandled?.();
  }, [addRequest, collapsedSwimlaneIds, onToggleSwimlane, onAddRequestHandled]);
  // A column deleted or hidden while selected falls back to the first one.
  const column = ordered.find((c) => c.id === selectedId) ?? ordered[0];
  // The Column actions menu belongs to one column. Keyed on the resolved column, not selectedId: moving the
  // first column pins selectedId to it without changing the column, and the menu must stay open then.
  const columnId = column?.id;
  useEffect(() => { setColumnActionsOpen(false); }, [columnId]);
  if (!column) return <p data-testid="phone-board-empty" className="px-3 py-4 text-sm text-fg-secondary">No visible columns</p>;

  const columnCards = cards.filter((c) => c.column === column.id);
  const count = columnCards.length;
  // Show sub-columns off (#2531): no switcher and no sub-column filter, so every card in the stage shows,
  // as the grid's single unsplit cell does. The cards keep their sub-column; only the view changes.
  const subs = showSubColumns ? stageSubColumns(column) : [];
  // Off, a split stage's cards show the grid's segmented gate progress bar instead (#2535, #1102).
  const gateNames = !showSubColumns ? stageSubColumns(column).map((s) => s.name) : null;
  const activeSub = subs.length > 0 ? Math.min(subIndex, subs.length - 1) : -1;
  const subCounts = subs.map((sub, i) => ({ sub, n: columnCards.filter((c) => cardSubColumnIndex(c, column) === i).length }));
  const limit = column.wip_limit !== null && column.wip_limit > 0 ? column.wip_limit : null;
  const over = limit !== null && count > limit;
  const totalWeight = columnCards.reduce((sum, c) => sum + c.weight, 0);
  const overWeight = column.weight_limit !== null && totalWeight > column.weight_limit;
  const policy = columnPolicy(column);
  // A policy removed over the socket closes the popover (as in ColumnHeader).
  if (!policy && policyRect !== null) setPolicyRect(null);
  const visibleColumnIds = ordered.map((c) => c.id);
  const allColumnIds = [...(allColumns ?? columns)].sort((a, b) => a.position - b.position).map((c) => c.id);
  const columnIdx = visibleColumnIds.indexOf(column.id);
  const canReorderColumns = isAdmin && onColumnsReordered !== undefined && ordered.length > 1;
  const moveColumn = (dir: -1 | 1) => {
    const next = stepOrder(allColumnIds, visibleColumnIds, column.id, dir);
    if (!next) return;
    // Pin the selection: with none made yet the first column shows, and the moved one may stop being first.
    setSelectedId(column.id);
    onColumnsReordered?.(next);
  };
  const visibleLaneIds = swimlanes.map((l) => l.id);
  const allLaneIds = (allSwimlanes ?? swimlanes).map((l) => l.id);
  const canReorderLanes = isAdmin && onSwimlanesReordered !== undefined && swimlanes.length > 1;
  const moveLane = (laneId: number, dir: -1 | 1) => {
    const next = stepOrder(allLaneIds, visibleLaneIds, laneId, dir);
    if (next) onSwimlanesReordered?.(next);
  };
  const selectColumn = (id: number, focus = false) => {
    // An open input (and its error) belongs to the column it was opened in.
    if (id !== column.id) { setAddingLane(null); setDraft(""); setAddError(null); setPolicyRect(null); }
    setSelectedId(id);
    if (focus) setFocusTabId({ id });
  };
  // Roving tabindex: arrows, Home and End move between tabs, so one Tab stop covers the row.
  const onTabKey = (e: React.KeyboardEvent, idx: number) => {
    const next = e.key === "ArrowRight" ? idx + 1 : e.key === "ArrowLeft" ? idx - 1 : e.key === "Home" ? 0 : e.key === "End" ? ordered.length - 1 : null;
    if (next === null) return;
    e.preventDefault();
    selectColumn(ordered[(next + ordered.length) % ordered.length].id, true);
  };
  const doneIds = new Set(columns.filter((c) => c.is_done).map((c) => c.id));

  const canAdd = canEdit && column.allow_card_creation;
  // #2211: the composer starts with the lane team's member; Unassign drops it for this card.
  const preAssigneeFor = (lane: Swimlane) => {
    const d = laneDefaultAssignee(lane, members);
    return { laneDefault: d, assignee: unassignedLane === lane.id ? null : d?.assignee ?? null };
  };
  const submitCard = async (laneId: number) => {
    const title = draft.trim();
    if (!title) return;
    setAddError(null);
    const lane = swimlanes.find((l) => l.id === laneId);
    const assignee = lane ? preAssigneeFor(lane).assignee : null;
    try {
      const created = await createCard(boardId, {
        column: column.id, swimlane: laneId, title, ...(assignee && { assignee_id: assignee.id, notify_assignee: true }),
      });
      setUnassignedLane(null);
      onCardAdded?.(created);
      setDraft("");
      setAddingLane(null);
    } catch (err) {
      // Same wording as the grid cell: a WIP or weight 409 names the column and the numbers.
      setAddError(limitBlockedMessage(err, customFieldDefinitions) ?? "Failed to add card.");
    }
  };
  const editLane = swimlanes.find((l) => l.id === editingLane) ?? null;

  return (
    <div data-testid="phone-board" className="flex flex-col gap-2 px-3 pb-4 min-w-0">
      <div
        role="tablist"
        aria-label="Columns"
        data-testid="phone-column-switcher"
        className="flex gap-2 overflow-x-auto py-2 -mx-3 px-3 sticky top-0 z-20 bg-sunken border-b border-line"
      >
        {ordered.map((col, idx) => {
          const on = col.id === column.id;
          const n = cards.filter((c) => c.column === col.id).length;
          const colOver = col.wip_limit !== null && col.wip_limit > 0 && n > col.wip_limit;
          return (
            <button
              key={col.id}
              type="button"
              role="tab"
              id={`${uid}-tab-${col.id}`}
              aria-controls={`${uid}-panel`}
              aria-selected={on}
              tabIndex={on ? 0 : -1}
              onKeyDown={(e) => onTabKey(e, idx)}
              aria-label={`${col.name}, ${n} ${n === 1 ? "card" : "cards"}${colOver ? ", over limit" : ""}`}
              data-phone-column={col.id}
              onClick={() => selectColumn(col.id)}
              className={`shrink-0 inline-flex items-center gap-2 min-h-11 px-3 rounded border text-sm focus:outline-none focus:ring-2 focus:ring-primary-emphasis ${
                on ? "border-info bg-primary/20 text-fg font-semibold" : "border-line bg-surface text-fg-secondary hover:border-line-strong"
              }`}
            >
              <span aria-hidden="true" className="w-2.5 h-2.5 rounded-full color-dot" style={{ backgroundColor: col.color }} />
              <span className="whitespace-nowrap">{col.name}</span>
              <span className={colOver ? "text-warning-on-tint font-semibold" : ""}>{n}</span>
            </button>
          );
        })}
      </div>

      {(limit !== null || overWeight) && (
        <div data-testid="phone-column-limit" className="flex flex-col gap-1">
          <span className="text-xs tabular-nums">
            {limit !== null && (
              <span
                className={over ? "text-warning-on-tint font-semibold" : "text-fg-secondary"}
                title={over && hardWipEnforced ? "WIP hard limit — no override possible" : undefined}
              >
                {over && hardWipEnforced && <span aria-hidden="true" data-testid="phone-hard-limit">⛔ </span>}
                {count} of {limit} limit{over ? " (over)" : ""}
                {over && hardWipEnforced && <span className="sr-only">, hard limit</span>}
              </span>
            )}
            {overWeight && (
              <span className={`${limit !== null ? "ml-2 " : ""}font-semibold text-warning-on-tint`} title="Over weight budget">
                Weight {totalWeight}/{column.weight_limit}
              </span>
            )}
          </span>
          {limit !== null && (
            <div
              role="meter"
              aria-label={`${column.name} WIP`}
              aria-valuemin={0}
              aria-valuemax={limit}
              aria-valuenow={Math.min(count, limit)}
              className="h-[3px] rounded-full bg-surface-hover"
            >
              <div className={`h-full rounded-full ${over ? "bg-warning" : "bg-primary"}`} style={{ width: `${Math.min(100, (count / limit) * 100)}%` }} />
            </div>
          )}
        </div>
      )}

      {subs.length > 0 && (
        // Segmented control (spec § Phone width): one 44px segment per sub-column, with its count.
        // aria-pressed buttons in a group, as BoardViewMenu's segments: Tab reaches each one, so no
        // roving radio keys are needed (frontend/CLAUDE.md § Gated stages and tracks).
        <>
          <div role="group" aria-label={`${column.name} sub-columns`} data-testid="phone-sub-column-switcher" className="flex rounded border border-line-boundary overflow-hidden">
            {subCounts.map(({ sub, n }, i) => {
              const on = i === activeSub;
              return (
                <button
                  key={sub.id}
                  type="button"
                  aria-pressed={on}
                  aria-label={`${sub.name}, ${n} ${n === 1 ? "card" : "cards"}`}
                  onClick={() => setSubIndex(i)}
                  className={`flex-1 min-w-0 min-h-11 px-2 inline-flex items-center justify-center gap-1 text-sm focus:outline-none focus:ring-2 focus:ring-inset focus:ring-primary-emphasis ${i > 0 ? "border-l border-line-boundary" : ""} ${
                    on ? "bg-primary-emphasis/20 text-info font-semibold" : "text-fg-secondary hover:bg-surface-hover"
                  }`}
                >
                  <ActiveMark active={on} />
                  <span className="min-w-0 truncate">{sub.name}</span> <span className="shrink-0 tabular-nums">{n}</span>
                </button>
              );
            })}
          </div>
          <p className="sr-only" role="status" aria-live="polite" aria-atomic="true" data-testid="phone-sub-column-status">
            {activeSub >= 0 && subCounts[activeSub] ? `Showing ${subCounts[activeSub].sub.name}, ${subCounts[activeSub].n} ${subCounts[activeSub].n === 1 ? "card" : "cards"}` : ""}
          </p>
        </>
      )}

      {(policy || isAdmin) && (
        <div className="flex flex-wrap gap-2" data-testid="phone-column-actions-row">
          {/* The policy is information for every reader (ColumnHeader, #1101), so it is never admin-gated. */}
          {policy && (
            <button
              ref={policyTriggerRef}
              type="button"
              data-testid="phone-column-policy"
              aria-label={`Column policy for ${column.name}: ${policyCountSummary(policy)}`}
              aria-haspopup="dialog"
              aria-expanded={policyRect !== null}
              onClick={(e) => { const rect = e.currentTarget.getBoundingClientRect(); setPolicyRect((prev) => (prev ? null : rect)); }}
              className={ACTION_BTN}
            >
              Policy
            </button>
          )}
          {isAdmin && (
            <button
              type="button"
              data-testid="phone-column-actions-toggle"
              aria-label={`Column actions for ${column.name}`}
              aria-expanded={columnActionsOpen}
              aria-controls={columnActionsOpen ? `${uid}-column-actions` : undefined}
              onClick={() => setColumnActionsOpen((o) => !o)}
              className={ACTION_BTN}
            >
              Column actions
            </button>
          )}
        </div>
      )}
      {isAdmin && columnActionsOpen && (
        // Column actions: Edit column, and a direct way to Stage settings (#2368), the Edit column modal's Stage tab.
        <div id={`${uid}-column-actions`} className="flex flex-wrap gap-2" data-testid="phone-column-actions-menu">
          <button
            type="button"
            data-testid="phone-column-actions"
            aria-label={`Edit column ${column.name}`}
            onClick={() => setEditTab("settings")}
            className={ACTION_BTN}
          >
            Edit column
          </button>
          <button
            type="button"
            data-testid="phone-column-stage-settings"
            aria-label={`Stage settings for ${column.name}`}
            onClick={() => setEditTab("stage")}
            className={ACTION_BTN}
          >
            Stage settings
          </button>
          {canReorderColumns && (
            <>
              <button type="button" className={`${ACTION_BTN} disabled:opacity-40 disabled:cursor-not-allowed`} data-testid="phone-column-earlier" aria-label={`Move column ${column.name} earlier`} disabled={columnIdx <= 0} onClick={() => moveColumn(-1)}>Move earlier</button>
              <button type="button" className={`${ACTION_BTN} disabled:opacity-40 disabled:cursor-not-allowed`} data-testid="phone-column-later" aria-label={`Move column ${column.name} later`} disabled={columnIdx >= ordered.length - 1} onClick={() => moveColumn(1)}>Move later</button>
            </>
          )}
        </div>
      )}

      <div role="tabpanel" id={`${uid}-panel`} aria-labelledby={`${uid}-tab-${column.id}`} className="flex flex-col gap-4">
        {swimlanes.length === 0 && <p className="text-sm text-fg-secondary">No swimlanes</p>}
        {swimlanes.map((lane, laneIdx) => {
          const laneCards = columnCards
            .filter((c) => c.swimlane === lane.id && (activeSub < 0 || cardSubColumnIndex(c, column) === activeSub))
            .sort((a, b) => a.position - b.position);
          const shown = filteredCardIds ? laneCards.filter((c) => filteredCardIds.has(c.id)) : laneCards;
          const collapsed = collapsedSwimlaneIds.has(lane.id);
          const allLane = cards.filter((c) => c.swimlane === lane.id);
          const statusOf = (c: Card) => cardBoardStatus(c, doneIds.has(c.column));
          const overdue = allLane.filter((c) => statusOf(c) === "overdue").length;
          const stale = allLane.filter((c) => statusOf(c) === "stale").length;
          // Second line (#2329): the grid band's fields, limit line and rollup, from the
          // same helpers, so a lane reads the same at every width.
          // #2439 / #2658: every board shows its Band fields, and "Show N more" opens Details plus
          // Hidden on band; a board with no tiers set resolves them by position. A missing role is
          // a non-admin (`!!isAdmin`), so admin-only fields stay out of every count.
          const tiers = laneTierFields(lane, swimlaneFieldDefinitions, !!isAdmin, laneDetailsCap, BAND_DEFAULT_COUNT); // a phone always shows two (#2663)
          const moreCount = tiers.details.length + tiers.hidden.length;
          const showFieldToggle = moreCount > 0; // per board, so every lane shows the toggle or none does
          const bandFields = tiers.band;
          const fieldsOpen = showFieldToggle && openFieldLanes.has(lane.id);
          const laneLimit = laneBandLimit(lane, allColumns ?? columns, allLane, limitFlags ?? NO_FLAGS, collapsed);
          const rollup = laneRollup(lane.id, rollupField, allColumns ?? columns, allLane);
          const hasSecondLine = bandFields.length > 0 || showFieldToggle || overdue > 0 || stale > 0 || laneLimit !== null || rollup !== null;
          const extraId = `${uid}-lane-${lane.id}-fields`;
          // #2384: Edit, Field order, Focus and the lane reorder pair live behind "Lane actions"; Add card
          // and health stay at rest. That is the implementer's call, not the owner's: #2384 lists per-lane Add card among
          // the controls that push cards down, but Add card is an editor action and the reference shows no per-lane
          // controls. Revisit if the owner wants them behind Lane actions. A reader with nothing to manage and no Focus gets no toggle.
          const showFocus = !!onFocusLane && swimlanes.length > 1;
          const hasLaneMenu = isAdmin || showFocus;
          const laneActionsOpen = openLaneActions.has(lane.id);
          const hasActions = canAdd || hasLaneMenu || !!childrenAction || lanePillVisible(lane, healthAutoEnabled);
          const renderField = ({ def, value }: LaneBandField) => (
            <CustomFieldValueDisplay key={def.id} definition={def} value={value} variant="band" adminOnly={def.is_admin_only} hideName={hideRowChipFieldNames} userDateFormat={userDateFormat} />
          );
          return (
            <section key={lane.id} aria-label={lane.name} data-testid="phone-lane" className="flex flex-col gap-2">
              {/* The band: tinted, one collapse target (the first line, 44px), then a second
                  line of fields and stats. The second line sits outside the button because a
                  URL field is a link and the "Show N more" toggle is a button, and neither may nest in a button. */}
              <div
                data-testid="phone-lane-band"
                style={columnTintStyle(lane.color)}
                className="flex flex-col rounded border border-line bg-surface"
              >
                <button
                  type="button"
                  aria-expanded={!collapsed}
                  aria-label={`${collapsed ? "Expand" : "Collapse"} lane ${lane.name}, ${laneCards.length} here`}
                  onClick={() => onToggleSwimlane(lane.id)}
                  className={`flex items-center gap-2 min-h-11 w-full text-left rounded px-3 ${hasSecondLine ? "pt-2.5 pb-1" : "py-2.5"} focus:outline-none focus:ring-2 focus:ring-primary-emphasis`}
                >
                  <svg aria-hidden="true" className={`w-4 h-4 shrink-0 text-fg-secondary transition-transform ${collapsed ? "-rotate-90" : ""}`} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M4 6l4 4 4-4" /></svg>
                  <span aria-hidden="true" className="w-2.5 h-2.5 rounded-sm color-dot" style={{ backgroundColor: lane.color }} />
                  <span className="text-[17px] font-semibold text-fg min-w-0 break-words">{lane.name}</span>{" "}
                  {/* The space above keeps "Backlog" and "3 here" separate words for the name check (#2467). */}
                  <span className="ml-auto text-xs font-semibold text-fg whitespace-nowrap">{laneCards.length} here</span>
                </button>
                {hasSecondLine && (
                  // Order and tiers as the grid band (frontend/CLAUDE.md § Swimlane bands): the
                  // "Show N more", the Band fields, then overdue, stale, the limit line and the rollup.
                  // A link in a URL field is lifted to 44px, as every phone target is.
                  <div data-testid="phone-lane-band-details" className="flex flex-wrap items-center gap-x-3 gap-y-1 pl-9 pr-3 pb-2.5 text-sm [&_a]:inline-flex [&_a]:items-center [&_a]:min-h-11">
                    {showFieldToggle && (
                      <button
                        type="button"
                        onClick={() => toggleLaneFields(lane.id)}
                        aria-expanded={fieldsOpen}
                        aria-controls={fieldsOpen ? extraId : undefined}
                        aria-label={fieldsOpen ? `Hide details for ${lane.name}` : `Show ${moreCount} more fields for ${lane.name}`}
                        data-testid="phone-lane-fields-toggle"
                        className={`inline-flex items-center gap-1 min-h-11 text-xs px-2 py-0.5 rounded-full border shrink-0 focus:outline-none focus:ring-2 focus:ring-primary-emphasis ${fieldsOpen ? "bg-info/10 text-info-on-tint border-info/40" : "border-line-strong text-fg-secondary hover:text-fg"}`}
                      >
                        {fieldsOpen ? "Hide details" : `Show ${moreCount} more`}
                        <svg aria-hidden="true" className={`w-3 h-3 transition-transform motion-reduce:transition-none ${fieldsOpen ? "rotate-180" : ""}`} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M4 6l4 4 4-4" /></svg>
                      </button>
                    )}
                    {/* Band fields stay while the details are open. */}
                    {bandFields.map((bandField) => renderField(bandField))}
                    {overdue > 0 && <span className="font-semibold text-danger-on-tint whitespace-nowrap">{overdue} {STATUS_LABEL.overdue}</span>}
                    {stale > 0 && <span className="font-semibold text-warning-on-tint whitespace-nowrap">{stale} {STATUS_LABEL.stale}</span>}
                    {laneLimit !== null && (
                      <span className="font-semibold">
                        <SwimlaneLimitStat swimlane={lane} usage={laneLimit.usage} reading={laneLimit.reading} hard={laneLimit.hard} showAtLimit={showWipAtLimit} />
                      </span>
                    )}
                    {rollup !== null && (
                      <span className="font-semibold text-fg whitespace-nowrap" data-testid="phone-lane-rollup" title={`${rollup.fieldName}: total of the cards not in a done column`}>
                        <span className="sr-only">{rollup.fieldName}: </span>{rollup.text} open
                      </span>
                    )}
                    {fieldsOpen && (
                      <LaneTierDetails id={extraId} laneColor={lane.color} tiers={tiers} userDateFormat={userDateFormat} onManage={isAdmin ? onManageSwimlaneFields : undefined} touch />
                    )}
                  </div>
                )}
                {hasActions && (
                  // #2498: the actions are the band's last line, inside the tinted box behind a divider, so a lane's
                  // health, Add card and Lane actions read as that lane's. Not in the collapse button (line one is the only target).
                  <div data-testid="phone-lane-footer" className="flex flex-col gap-2 border-t border-line-subtle px-3 pb-2.5 pt-2">
                  <div className="flex flex-wrap gap-2" data-testid="phone-lane-actions">
                    <PhoneLaneHealth lane={lane} boardId={boardId} isAdmin={isAdmin} autoEnabled={healthAutoEnabled} onSwimlaneUpdated={onSwimlaneUpdated} />
                    {canAdd && (
                      <button type="button" className={ACTION_BTN} onClick={() => { setAddingLane(lane.id); setDraft(""); setAddError(null); if (collapsed) onToggleSwimlane(lane.id); }}>
                        <span aria-hidden="true" className="mr-1">+</span>Add card<span className="sr-only"> to {column.name} in {lane.name}</span>
                      </button>
                    )}
                    {childrenAction && (() => {
                      const n = childrenAction.counts.get(lane.id);
                      return (
                        <button type="button" className={ACTION_BTN} data-testid="phone-lane-children-action" onClick={() => childrenAction.onOpen(lane.id)}
                          aria-label={`Children${n != null ? ` ${inProgressChip(n)}` : ""}, ${lane.name}`}>
                          Children
                          {n != null && <span className="ml-1.5 rounded-full bg-surface-active px-1.5 text-xs text-fg">{inProgressChip(n)}</span>}
                        </button>
                      );
                    })()}
                    {hasLaneMenu && (
                      <button
                        type="button"
                        data-testid="phone-lane-actions-toggle"
                        className={ACTION_BTN}
                        aria-label={`Lane actions for ${lane.name}`}
                        aria-expanded={laneActionsOpen}
                        aria-controls={laneActionsOpen ? `${uid}-lane-actions-${lane.id}` : undefined}
                        onClick={() => toggleLaneActions(lane.id)}
                      >
                        Lane actions
                      </button>
                    )}
                  </div>
                  {hasLaneMenu && laneActionsOpen && (
                    <div id={`${uid}-lane-actions-${lane.id}`} className="flex flex-wrap gap-2" data-testid="phone-lane-actions-menu">
                      {isAdmin && (
                        <button type="button" className={ACTION_BTN} aria-label={`Edit swimlane ${lane.name}`} onClick={() => setEditingLane(lane.id)}>Edit</button>
                      )}
                      {isAdmin && onEditFieldOrder && (
                        <button type="button" className={ACTION_BTN} aria-label={`Field order for ${lane.name}`} data-testid="phone-lane-field-order" onClick={onEditFieldOrder}>Field order</button>
                      )}
                      {showFocus && (
                        <button
                          type="button"
                          className={ACTION_BTN}
                          aria-pressed={focusedSwimlaneId === lane.id}
                          aria-label={focusedSwimlaneId === lane.id ? "Exit focus" : `Focus on ${lane.name}`}
                          onClick={() => (focusedSwimlaneId === lane.id ? onExitFocus?.() : onFocusLane?.(lane.id))}
                        >
                          {focusedSwimlaneId === lane.id ? "Exit focus" : "Focus"}
                        </button>
                      )}
                      {canReorderLanes && (
                        <>
                          <button type="button" className={`${ACTION_BTN} disabled:opacity-40 disabled:cursor-not-allowed`} data-testid="phone-lane-earlier" aria-label={`Move swimlane ${lane.name} earlier`} disabled={laneIdx === 0} onClick={() => moveLane(lane.id, -1)}>Move earlier</button>
                          <button type="button" className={`${ACTION_BTN} disabled:opacity-40 disabled:cursor-not-allowed`} data-testid="phone-lane-later" aria-label={`Move swimlane ${lane.name} later`} disabled={laneIdx === swimlanes.length - 1} onClick={() => moveLane(lane.id, 1)}>Move later</button>
                        </>
                      )}
                    </div>
                  )}
                  </div>
                )}
              </div>
              {canAdd && addingLane === lane.id && !collapsed && (
                <div className="flex flex-col gap-2" data-testid="phone-add-card">
                  <p className="text-sm font-medium text-fg" data-testid="phone-add-card-heading">New card in {lane.name} · {column.name}</p>
                  <input
                    autoFocus
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.nativeEvent.isComposing) { e.preventDefault(); void submitCard(lane.id); }
                      if (e.key === "Escape") { e.stopPropagation(); setAddingLane(null); setAddError(null); setUnassignedLane(null); }
                    }}
                    aria-label={`New card title in ${column.name}, ${lane.name}`}
                    placeholder="Card title"
                    className="w-full min-h-11 text-sm border border-primary-emphasis rounded px-3 outline-none bg-surface text-fg placeholder-fg-muted"
                  />
                  {(() => {
                    const { laneDefault, assignee } = preAssigneeFor(lane);
                    return laneDefault?.assignee ? (
                      <LaneTeamAssignee
                        size="md"
                        assignee={laneDefault.assignee}
                        assigned={assignee != null}
                        others={laneDefault.others}
                        caption={laneCaption(lane.name)}
                        sourceLabel="Pre-assigned from lane team"
                        onUnassign={() => setUnassignedLane(lane.id)}
                        onReassign={() => setUnassignedLane(null)}
                      />
                    ) : null;
                  })()}
                  <div className="flex gap-2">
                    <button type="button" className="inline-flex items-center justify-center min-h-11 px-4 text-sm rounded font-medium bg-button-primary text-on-primary hover:bg-button-primary-hover focus:outline-none focus:ring-2 focus:ring-primary-emphasis" onClick={() => void submitCard(lane.id)}>Add card</button>
                    <button type="button" className="inline-flex items-center justify-center min-h-11 px-3 text-sm rounded text-fg-secondary hover:text-fg hover:bg-surface-hover focus:outline-none focus:ring-2 focus:ring-primary-emphasis" onClick={() => { setAddingLane(null); setAddError(null); setUnassignedLane(null); }}>Cancel</button>
                  </div>
                  <p className="text-xs min-h-4" role="status" aria-live="polite" aria-atomic="true"><span className="text-danger">{addError}</span></p>
                </div>
              )}
              {!collapsed && (
                <SortableContext items={shown.map((c) => c.id)} strategy={verticalListSortingStrategy}>
                  {/* 44px card face at phone width (#2277): the face is the tap target that opens the detail panel. */}
                  <div className="flex flex-col gap-1.5 [&_[data-card-id]]:min-h-[46px]">
                    {/* #2345: while a filter or chip is active an empty lane reads as the artboard's "No matching cards in <column>."; unfiltered it is simply empty (#2278: or empty in the active sub-column). */}
                    {shown.length === 0 && <p className="text-xs text-fg-tertiary px-1 min-w-0 break-words" data-testid="phone-lane-empty">{filteredCardIds ? `No matching cards in ${activeSub >= 0 ? subs[activeSub].name : column.name}.` : activeSub >= 0 ? `Empty in ${subs[activeSub].name}` : "No cards here"}</p>}
                    {shown.map((card) => (
                      <CardItem
                        key={card.id}
                        card={card}
                        onClick={(opts) => onCardClick(card, opts)}
                        selected={selectedCardIds.has(card.id)}
                        highlighted={highlightedCardId === card.id}
                        current={currentCardId === card.id}
                        peekSuppressed
                        onSelect={canEdit && currentCardId == null ? () => onToggleCardSelection(card.id) : undefined}
                        density={density}
                        userTimezone={userTimezone}
                        currentUserId={currentUserId}
                        userDateFormat={userDateFormat}
                        staleness_threshold_days={staleness_threshold_days}
                        stale_warning_pct={stale_warning_pct}
                        inDoneColumn={column.is_done}
                        customFieldDefinitions={customFieldDefinitions}
                        boardId={boardId}
                        onCardUpdated={canEdit ? onCardUpdated : undefined}
                        onOpenMenu={onOpenCardMenu}
                        contextTarget={contextTargetCardId === card.id}
                        trackStates={getTrackStates(card, column, lane, customFieldDefinitions)}
                        trackStatesSpelledOut
                        gateProgress={gateNames && gateNames.length >= 2 ? { index: cardSubColumnIndex(card, column), names: gateNames } : null}
                      />
                    ))}
                  </div>
                </SortableContext>
              )}
            </section>
          );
        })}
      </div>

      {isAdmin && (onAddColumn || onAddSwimlane) && (
        <div className="flex flex-wrap gap-2" data-testid="phone-add-structure">
          {onAddSwimlane && <button type="button" className={ACTION_BTN} onClick={onAddSwimlane}>+ Add swimlane</button>}
          {onAddColumn && <button type="button" className={ACTION_BTN} onClick={onAddColumn}>+ Add column</button>}
        </div>
      )}

      {isAdmin && editLane && onSwimlaneUpdated && onSwimlaneDeleted && (
        <EditSwimlaneModal
          boardId={boardId}
          swimlane={editLane}
          cardCount={cards.filter((c) => c.swimlane === editLane.id).length}
          columns={allColumns ?? columns}
          laneCards={cards.filter((c) => c.swimlane === editLane.id)}
          boardColors={boardColors}
          limitFlags={limitFlags}
          members={members}
          onUpdated={(updated) => { onSwimlaneUpdated(updated); setEditingLane(null); }}
          onDeleted={(id) => { onSwimlaneDeleted(id); setEditingLane(null); }}
          onClose={() => setEditingLane(null)}
          swimlaneFieldDefinitions={swimlaneFieldDefinitions}
          userDateFormat={userDateFormat}
        />
      )}
      {policy && policyRect && (
        <ColumnPolicyPopover
          columnName={column.name}
          policy={policy}
          anchorRect={policyRect}
          triggerRef={policyTriggerRef}
          onDismiss={closePolicy}
          // Focus moves to the Policy button first so the modal's focus trap restores to it (ColumnHeader).
          onEdit={isAdmin ? () => { policyTriggerRef.current?.focus(); setPolicyRect(null); setEditTab("policy"); } : undefined}
        />
      )}
      {isAdmin && editTab && onColumnUpdated && onRequestDeleteColumn && (
        <EditColumnModal
          boardId={boardId}
          column={column}
          cardCount={count}
          boardColors={boardColors}
          isIntakeColumn={column.id === intakeColumnId}
          // Hidden lanes included: Save stage replaces every lane exception it sends (#2278).
          swimlanes={allSwimlanes}
          customFieldDefinitions={customFieldDefinitions}
          cards={columnCards}
          initialTab={editTab === "settings" ? undefined : editTab}
          onUpdated={(updated) => { onColumnUpdated(updated); setEditTab(null); }}
          onRequestDelete={onRequestDeleteColumn}
          onClose={() => setEditTab(null)}
        />
      )}
    </div>
  );
}
