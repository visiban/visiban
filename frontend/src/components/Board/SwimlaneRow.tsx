import { useState, useRef, useEffect, useCallback, useId } from "react";
import SeparatorPlus from "./SeparatorPlus";
import type { BoardColor } from "../../utils/boardColors";
import { useInlineEditEscape } from "../../hooks/useInlineEditEscape";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { Card, CardDensity, Column, CustomFieldDefinition, Swimlane, SwimlaneCustomFieldDefinition } from "../../types";
import { patchSwimlane, updateSwimlane } from "../../api/boards";
import HealthStatusControl from "../Common/HealthStatusControl";
import type { HealthStatus } from "../../constants/healthStatus";
import { laneHealthFields } from "../../utils/healthStatus";
import BoardCell from "./BoardCell";
import type { CardMenuAnchor } from "../Card/CardContextMenu";
import EditSwimlaneModal from "./EditSwimlaneModal";
import CustomFieldValueDisplay from "../Card/CustomFieldValueDisplay";
import { STATUS_LABEL, STATUS_SQUARE_CLASS, cardBoardStatus, type CardBoardStatus } from "../../constants/laneStatus";
import { cellKey } from "../../gridOverlays/types";
import type { GridOverlayCellState } from "../../gridOverlays/slot";
import { laneLimitState, laneUsage, swimlaneLimitModes, type LaneLimitReading, type LaneUsage, type LimitFlags, type TrippedLimit } from "../../utils/placementLimits";
import { isImeComposing } from "../../utils/imeComposition";
import ActiveUnderline from "../Common/ActiveUnderline";

/**
 * The row's limit state line (#1150), mirroring the column header's stat row
 * (#973): one line, worst offender first (Over WIP > Over weight > At >
 * Under). The text carries the state; the meter is decorative.
 */
function SwimlaneLimitStat({ swimlane, usage, reading, hard, showAtLimit }: { swimlane: Swimlane; usage: LaneUsage; reading: LaneLimitReading; hard: boolean; showAtLimit: boolean }) {
  const wip = swimlane.wip_limit;
  const weight = swimlane.weight_limit;
  // "At limit" is the board's opt-in ambient indicator (Board.show_wip_at_limit),
  // (it applies to swimlane rows only; the column header ignores it); off, an at-limit row reads like an under-limit
  // one. The two over-limit states are violations and always show.
  const state = reading.state === "at" && !showAtLimit ? "under" : reading.state;
  // The line names the metric that decided the state (laneLimitState).
  const showWip = reading.metric === "wip";
  const value = showWip ? usage.count : usage.weight;
  const limit = (showWip ? wip : weight) ?? 0;
  const numbers = `${value}/${limit}`;
  const label = showWip ? "WIP" : "Weight";
  let text: React.ReactNode;
  let tone: string;
  let title: string;
  if (state === "overWip") {
    text = <><span aria-hidden="true">{hard ? "⛔ " : "⚠ "}</span>Over WIP · <span className="font-semibold">{numbers}</span></>;
    tone = "text-danger-on-tint font-semibold";
    title = hard ? "Over the swimlane's hard WIP limit — no override possible" : "Over the swimlane's WIP limit";
  } else if (state === "overWeight") {
    text = <>Over weight · <span className="font-semibold">{numbers}</span></>;
    // Fixed danger tokens for both over-limit states: § System signals
    // reserves "Lane over limit" as danger. The words, not the hue, tell
    // WIP from weight.
    tone = "text-danger-on-tint font-semibold";
    title = "Over the swimlane's weight limit";
  } else if (state === "at") {
    text = <>{label} {numbers} · at limit</>;
    tone = "text-fg-secondary";
    title = `Swimlane is at its ${label === "WIP" ? "WIP" : "weight"} limit (${numbers})`;
  } else {
    text = <>{label} {numbers}</>;
    tone = "text-fg-tertiary";
    title = `Swimlane ${label === "WIP" ? "WIP" : "weight"} limit: ${numbers} in the columns that count`;
  }
  return (
    // One line in the band's stats cluster (#2271); the words carry the state.
    <span className={`whitespace-nowrap text-sm ${tone}`} title={title} data-testid="swimlane-limit-stat">
      {text}
    </span>
  );
}

interface Props {
  swimlane: Swimlane;
  columns: Column[];
  cards: Card[];
  boardId: number;
  isAdmin: boolean;
  canEdit: boolean;
  closeEditorOnEnter: boolean;
  collapsedColumnIds: Set<number>;
  hiddenColumnIds?: Set<number>;
  filteredCardIds: Set<number> | null;
  selectedCardIds: Set<number>;
  highlightedCardId?: number | null;
  /** The card open in the card detail sheet, if any (#1914). */
  currentCardId?: number | null;
  onToggleCardSelection: (cardId: number) => void;
  /** Card context menu (#2059), passed through to each BoardCell. */
  onOpenCardMenu?: (card: Card, anchor: CardMenuAnchor) => void;
  contextTargetCardId?: number | null;
  onCardClick: (card: Card) => void;
  onCardAdded: (card: Card) => void;
  onSwimlaneUpdated: (swimlane: Swimlane) => void;
  onSwimlaneDeleted: (swimlaneId: number) => void;
  /** Controlled collapsed state — driven by useViewPrefs.collapsedSwimlaneIds. */
  collapsed: boolean;
  onToggleCollapse: () => void;
  onFocus: (id: number) => void;
  /** Called when the user exits focus mode via the crosshair toggle. */
  onExitFocus: () => void;
  /** True when this swimlane is currently the active focus target. */
  isFocused: boolean;
  onHoverEnter?: () => void;
  onHoverLeave?: () => void;
  colWidths?: Map<number, number>;
  setColumnWidth?: (colId: number, width: number) => void;
  onInsertColumn?: (colId: number) => void;
  /** Which column separator index (0-based from left) is currently hovered — for full-height highlight. */
  hoveredSepIndex?: number | null;
  onSepHoverChange?: (idx: number | null) => void;
  minHeight?: number;
  setSwimlaneHeight?: (h: number) => void;
  density?: CardDensity;
  userTimezone?: string;
  /** #445: the viewer, for the checklist mine suffix on the card face. */
  currentUserId?: number;
  userDateFormat?: string;
  compact?: boolean;
  staleness_threshold_days?: number;
  stale_warning_pct?: number;
  /**
   * Card-level definitions (#371) — passed straight through to
   * BoardCell/CardItem. NOT the row's own fields; see
   * `swimlaneFieldDefinitions` below.
   */
  customFieldDefinitions?: CustomFieldDefinition[];
  /**
   * Row-level definitions (#1140) — consumed here, never forwarded to
   * BoardCell. Kept distinct from `customFieldDefinitions` above because the
   * two are independent schemas with independent id spaces, and conflating
   * them would render card fields on a row or vice versa.
   */
  swimlaneFieldDefinitions?: SwimlaneCustomFieldDefinition[];
  /**
   * #1418 — the board's `show_row_chip_field_names` is off: pinned row chips
   * show values without their `{name}:` label. Board-level admin setting, not
   * a per-viewer preference. The `+N` popover always lists names.
   */
  hideRowChipFieldNames?: boolean;
  /** Admin-only shortcut from the expanded `+N` fields to Board settings -> Swimlane
   *  fields (#1458). BoardView omits it when there is no order to edit. */
  onEditFieldOrder?: () => void;
  onCardUpdated?: (card: Card) => void;
  /**
   * Grid-overlay shading for this row's cells (#1147), keyed by
   * `cellKey(columnId, swimlaneId)`. Undefined when no overlay is active. The map is
   * built once per board render, so the per-cell objects handed to `BoardCell` keep a
   * stable identity for as long as the map does.
   */
  overlayCells?: Map<string, GridOverlayCellState>;
  /** The active overlay's label, for cell screen-reader text. */
  overlayLabel?: string;
  /**
   * The board's enforce_* flags (#1150): what a row with
   * `limit_enforcement: null` inherits, for its header glyph and the Edit
   * Swimlane modal's enforcement choice. Omitted, the row reads as unenforced.
   */
  limitFlags?: LimitFlags;
  /** Colors in use on the board, for the edit modal's custom color popover (#2098). */
  boardColors?: BoardColor[];
  /** The board's `show_wip_at_limit` (#973): whether the "at limit" state shows. */
  showWipAtLimit?: boolean;
  /**
   * The limits a drop of card `cardId` into a cell would trip, strictest
   * first (#1150), for the drop ring. Forwarded to every cell; BoardCell calls
   * it only for the cell under an active card drag.
   */
  getDropVerdict?: (cardId: number, column: Column, swimlane: Swimlane) => TrippedLimit[];
  /** Entry criteria a dragged card would meet in *column* (#1101); empty for none. */
  getEntryCriteria?: (cardId: number, column: Column) => string[];
}

/** Lane fields shown inline in the band before `+N` (#2271). */
const INLINE_FIELD_COUNT = 2;

const NO_FLAGS: LimitFlags = { enforce_wip_limits: false, enforce_wip_hard: false, enforce_weight_limits: false };

export default function SwimlaneRow({ swimlane, columns, cards, boardId, isAdmin, canEdit, closeEditorOnEnter, collapsedColumnIds, hiddenColumnIds, filteredCardIds, selectedCardIds, highlightedCardId, currentCardId, onToggleCardSelection, onOpenCardMenu, contextTargetCardId, onCardClick, onCardAdded, onSwimlaneUpdated, onSwimlaneDeleted, collapsed, onToggleCollapse, onFocus, onExitFocus, isFocused, onHoverEnter, onHoverLeave, colWidths, setColumnWidth, onInsertColumn, hoveredSepIndex, onSepHoverChange, minHeight, setSwimlaneHeight, density, userTimezone, currentUserId, userDateFormat, compact, staleness_threshold_days, stale_warning_pct, customFieldDefinitions, swimlaneFieldDefinitions, hideRowChipFieldNames, onEditFieldOrder, onCardUpdated, overlayCells, overlayLabel, limitFlags = NO_FLAGS, boardColors, getDropVerdict, getEntryCriteria, showWipAtLimit = false }: Props) {
  const [editing, setEditing] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState("");
  const [renameError, setRenameError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  // Focus returns to the opener on Escape/Enter (#2087); a blur-commit never steals focus back.
  const renameTriggerRef = useRef<HTMLButtonElement>(null);
  const focusTriggerRef = useRef(false);
  const rowRef = useRef<HTMLDivElement>(null);
  const heightResizeState = useRef<{ startY: number; startHeight: number } | null>(null);
  // `+N` reveals the remaining lane fields in place (#2271).
  const [fieldsOpen, setFieldsOpen] = useState(false);
  const extraFieldsId = useId();

  // Row field values to render (#1140). Three guards, all deliberate:
  // an empty-string value renders nothing (never a dashed ghost chip — dashed
  // already means "unset" on the card face and must not gain a second
  // meaning; #2193's card-face ghost does not apply here, since row chips are
  // read-only and Edit Swimlane lists every field, set or not, so an empty row
  // value is never stranded); a value whose definition is missing is dropped silently (a WS
  // race between a definition delete and this render); and the pinned slice is
  // capped client-side so a server-side cap violation cannot blow out the row.
  const swimlaneFieldsById = new Map((swimlaneFieldDefinitions ?? []).map((d) => [d.id, d]));
  const rowFieldEntries = (swimlane.custom_field_values ?? [])
    .filter((v) => v.value !== "")
    .map((v) => ({ def: swimlaneFieldsById.get(v.field_definition), value: v.value }))
    .filter((x): x is { def: SwimlaneCustomFieldDefinition; value: string } => !!x.def)
    .sort((a, b) => a.def.position - b.def.position);
  // The band shows the first two fields inline; the rest sit behind `+N` (#2271).
  // Pinning no longer decides what shows: the band has room, so position does.
  const inlineFields = rowFieldEntries.slice(0, INLINE_FIELD_COUNT);
  const extraFields = rowFieldEntries.slice(INLINE_FIELD_COUNT);

  // Status counts for the band's trailing stats and the collapsed strip's squares.
  const doneColumnIds = new Set(columns.filter((c) => c.is_done).map((c) => c.id));
  const statusOf = (card: Card): CardBoardStatus => cardBoardStatus(card, doneColumnIds.has(card.column));
  const overdueCount = cards.filter((c) => statusOf(c) === "overdue").length;
  const staleCount = cards.filter((c) => statusOf(c) === "stale").length;

  // Row limit state (#1150), from the row's active cards in its counted columns.
  const limitUsage = laneUsage(swimlane, columns, cards);
  const limitReading = laneLimitState(swimlane, limitUsage);
  const limitState = limitReading?.state ?? null;
  const hardWip = swimlaneLimitModes(limitFlags, swimlane).wip === "hard";
  // A collapsed row keeps only the over-limit states, so nothing over its
  // limit is hidden behind the chevron; the calm states fold away with it.
  const showLimitStat = limitState !== null && (!collapsed || limitState === "overWip" || limitState === "overWeight");

  const startRenaming = () => {
    setDraft(swimlane.name);
    setRenaming(true);
  };

  // Lane health status (#2243). The set pill (after the name) and the unset
  // icon (right-hand cluster) are different elements, so a save that swaps
  // them hands focus to the new one explicitly, and the announcement lives
  // here because the control that saved may unmount.
  const [healthFocus, setHealthFocus] = useState<"pill" | "icon" | null>(null);
  // Which trigger's popover is open: that trigger stays mounted until it
  // closes, even if a remote swimlane.updated flips the value meanwhile.
  const [healthOpen, setHealthOpen] = useState<"pill" | "icon" | null>(null);
  const onPillOpenChange = useCallback((o: boolean) => setHealthOpen(o ? "pill" : null), []);
  const onIconOpenChange = useCallback((o: boolean) => setHealthOpen(o ? "icon" : null), []);
  // A collapsed lane has no unset icon, so clearing it there hands focus to
  // the name (rename trigger) instead; a ref, read after the next render.
  const focusNameAfterHealthClear = useRef(false);
  useEffect(() => {
    if (!focusNameAfterHealthClear.current) return;
    focusNameAfterHealthClear.current = false;
    renameTriggerRef.current?.focus();
  });
  const [healthAnnouncement, setHealthAnnouncement] = useState("");
  const clearHealthFocus = useCallback(() => setHealthFocus(null), []);
  const saveHealth = useCallback(async (next: HealthStatus | null) => {
    const updated = await patchSwimlane(boardId, swimlane.id, { health_status: next });
    onSwimlaneUpdated(updated);
    if ((swimlane.health_status === null) !== (next === null)) {
      if (next !== null) setHealthFocus("pill");
      else if (collapsed) focusNameAfterHealthClear.current = true;
      else setHealthFocus("icon");
    }
    return { effective_health_status: updated.health_status };
  }, [boardId, swimlane.id, swimlane.health_status, onSwimlaneUpdated, collapsed]);
  const showHealthPill = !!swimlane.health_status || healthOpen === "pill";
  const showHealthIcon = !collapsed && isAdmin && (!swimlane.health_status || healthOpen === "icon");
  const healthFields = laneHealthFields(swimlane.health_status);

  const commitRename = async (restoreFocus = false) => {
    const trimmed = draft.trim();
    if (restoreFocus) focusTriggerRef.current = true;
    setRenaming(false);
    if (!trimmed || trimmed === swimlane.name) return;
    setRenameError(null);
    try {
      const updated = await updateSwimlane(boardId, swimlane.id, { name: trimmed, color: swimlane.color });
      onSwimlaneUpdated(updated);
    } catch {
      setRenameError("Failed to rename swimlane. Please try again.");
    }
  };

  const cancelRename = () => {
    focusTriggerRef.current = true;
    setRenaming(false);
    setDraft("");
  };

  useEffect(() => {
    if (!renaming && focusTriggerRef.current) {
      focusTriggerRef.current = false;
      renameTriggerRef.current?.focus();
    }
  }, [renaming]);

  // Escape cancels the rename through the stack so it does not also clear the selection (#1860).
  useInlineEditEscape(() => renaming, cancelRename);

  const handleHeightResizeStart = (e: React.MouseEvent) => {
    if (!setSwimlaneHeight) return;
    e.preventDefault();
    e.stopPropagation();
    const startHeight = rowRef.current ? rowRef.current.getBoundingClientRect().height : (minHeight ?? 80);
    heightResizeState.current = { startY: e.clientY, startHeight };
    const onMove = (ev: MouseEvent) => {
      if (!heightResizeState.current) return;
      setSwimlaneHeight(heightResizeState.current.startHeight + (ev.clientY - heightResizeState.current.startY));
    };
    const onUp = () => {
      heightResizeState.current = null;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  const {
    setNodeRef,
    attributes,
    listeners,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: `swim:${swimlane.id}`, disabled: !isAdmin });

  const color = swimlane.color || "";
  const countLabel = `${cards.length} ${cards.length === 1 ? "card" : "cards"}`;
  const fieldTriggerText = fieldsOpen ? "Less" : `+${extraFields.length}`;

  const renderField = ({ def, value }: { def: SwimlaneCustomFieldDefinition; value: string }) => (
    <CustomFieldValueDisplay
      key={def.id}
      definition={def}
      value={value}
      variant="band"
      adminOnly={def.is_admin_only}
      hideName={hideRowChipFieldNames}
      userDateFormat={userDateFormat}
    />
  );

  return (
    <>
      <div
        ref={setNodeRef}
        style={{ transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.3 : 1 }}
        className="relative py-1"
        // #2205 — lets the lane-filter notice know which lane holds keyboard focus.
        data-swimlane-id={swimlane.id}
        onMouseEnter={onHoverEnter}
        onMouseLeave={onHoverLeave}
      >
        {/* Swimlane band (#2271): a full-width header tinted with the lane color,
            aligned to the grid (the 16px margins are the first and last gutters).
            It wraps to a second line when it runs out of room. */}
        <div
          className={`group relative mx-4 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border px-3 py-2.5 ${color ? "" : "bg-surface border-line"}`}
          style={color ? { backgroundColor: `color-mix(in srgb, ${color} 12%, rgb(var(--surface)))`, borderColor: `color-mix(in srgb, ${color} 45%, rgb(var(--border)))` } : undefined}
          data-tour-step="swimlane"
          data-testid="swimlane-band"
          data-no-pan
          // A double-click on a control inside the band (rename input, chevron, +N, icons) is
          // that control's own gesture, never "open Edit Swimlane".
          onDoubleClick={isAdmin ? (e) => { if (!(e.target as HTMLElement).closest("button, input, a, [role=button]")) setEditing(true); } : undefined}
        >
          {/* Over-WIP top accent (#1150): an inset line, so the band does not grow. */}
          {limitState === "overWip" && (
            <span aria-hidden="true" className="pointer-events-none absolute inset-x-2 top-0 h-0.5 rounded-full bg-danger-emphasis" />
          )}
          {isAdmin && (
            <span
              {...attributes}
              {...listeners}
              className="text-fg-faint hover:text-fg-secondary cursor-grab active:cursor-grabbing text-sm select-none shrink-0 opacity-0 group-hover:opacity-100 focus:opacity-100 focus:outline-none focus:ring-2 focus:ring-primary-emphasis rounded transition-opacity"
              title="Drag to reorder"
            >
              ⠿
            </span>
          )}
          <button type="button"
            data-tour-step="swimlane-collapse"
            onClick={onToggleCollapse}
            className="relative text-fg-secondary hover:text-fg transition shrink-0 focus:outline-none focus:ring-2 focus:ring-primary-emphasis rounded"
            aria-expanded={!collapsed}
            aria-label={collapsed ? `Expand ${swimlane.name}` : `Collapse ${swimlane.name}`}
            title={collapsed ? `Expand ${swimlane.name}` : `Collapse ${swimlane.name}`}
          >
            {/* Points down when expanded; turns 90 degrees to point right when collapsed. */}
            <svg
              className={`w-4 h-4 transition-transform motion-reduce:transition-none ${collapsed ? "-rotate-90" : ""}`}
              viewBox="0 0 20 20"
              fill="currentColor"
              aria-hidden="true"
            >
              <path fillRule="evenodd" d="M5.293 7.293a1 1 0 011.414 0L10 10.586l3.293-3.293a1 1 0 111.414 1.414l-4 4a1 1 0 01-1.414 0l-4-4a1 1 0 010-1.414z" clipRule="evenodd" />
            </svg>
            <ActiveUnderline active={collapsed} placement="below" />
          </button>
          {color && <span aria-hidden="true" data-testid="swimlane-color-square" className="w-3 h-3 rounded-[3px] shrink-0" style={{ backgroundColor: color }} />}

          {renaming ? (
            <input
              ref={inputRef}
              autoFocus
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !isImeComposing(e)) { e.preventDefault(); void commitRename(true); } // commitRename manages its own error state (renameError) and never rejects
              }}
              onBlur={() => void commitRename()}
              onClick={(e) => e.stopPropagation()}
              className="min-w-0 w-48 text-[17px] font-semibold bg-sunken text-fg border border-primary-emphasis rounded px-1 py-0 outline-none"
            />
          ) : (
            <span
              className="min-w-0 max-w-full truncate text-[17px] font-semibold text-fg"
              title={isAdmin ? undefined : swimlane.name}
              data-testid="swimlane-name"
            >
              {isAdmin ? (
                // A real button so keyboard users can reach inline rename with Tab + Enter/Space (#1376).
                <button
                  type="button"
                  ref={renameTriggerRef}
                  className="block max-w-full truncate text-left font-semibold cursor-text rounded focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
                  title={`${swimlane.name} (click to rename)`}
                  onClick={(e) => { e.stopPropagation(); startRenaming(); }}
                >
                  {swimlane.name}
                </button>
              ) : (
                swimlane.name
              )}
            </span>
          )}
          {!collapsed && isAdmin && swimlane.contact_email && <span className="text-xs text-fg-secondary truncate min-w-0 max-w-48">{swimlane.contact_email}</span>}

          {/* Health status (#2243), after the name. Collapsed: shape only. The stop on
              double-click is required: the band's double-click opens the edit modal for
              admins, and the portaled popover's events bubble through React to it. */}
          {showHealthPill && (
            <span className="shrink-0 inline-flex" onDoubleClick={(e) => e.stopPropagation()}>
              <HealthStatusControl
                entityKind="swimlane"
                mode="basic"
                entityName={swimlane.name}
                parentName={null}
                canEdit={isAdmin}
                scope="lane"
                shapeOnly={collapsed}
                collapseLabel={!collapsed}
                onSave={saveHealth}
                onAnnounce={setHealthAnnouncement}
                autoFocus={healthFocus === "pill"}
                onAutoFocused={clearHealthFocus}
                onOpenChange={onPillOpenChange}
                {...healthFields}
              />
            </span>
          )}
          <span role="status" aria-live="polite" className="sr-only">{healthAnnouncement}</span>
          {renameError && <span className="text-xs text-danger-on-tint" role="alert">{renameError}</span>}

          {/* The first two lane fields as "Label value", then `+N`. They stay in the band
              when the lane is collapsed (the band is the collapsed lane's header). */}
          {inlineFields.map(renderField)}
          {extraFields.length > 0 && (
            <>
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); setFieldsOpen((o) => !o); }}
                aria-expanded={fieldsOpen}
                aria-controls={extraFieldsId}
                // Visible text leads the accessible name (WCAG 2.5.3 label-in-name).
                aria-label={`${fieldTriggerText}: ${fieldsOpen ? "Hide" : "Show"} ${extraFields.length} more field ${extraFields.length === 1 ? "value" : "values"} for ${swimlane.name}`}
                className="inline-flex items-center min-h-6 text-xs px-2 py-0.5 rounded-full border border-line-strong text-fg-secondary hover:text-fg hover:bg-surface-hover shrink-0 focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
              >
                {fieldTriggerText}
              </button>
              <div id={extraFieldsId} className="contents" data-testid="swimlane-extra-fields">
                {fieldsOpen && extraFields.map(renderField)}
                {fieldsOpen && isAdmin && onEditFieldOrder && (
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); onEditFieldOrder(); }}
                    className="text-xs text-info-on-tint underline rounded shrink-0 focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
                  >
                    Change field order
                  </button>
                )}
              </div>
            </>
          )}

          <div className="flex-1 min-w-0" />

          {/* Trailing stats: overdue and stale (omitted at zero), the limit line (#1150;
              a calm one folds away when collapsed, an over-limit one never does), then
              the card count. Text always carries the state; color only reinforces it. */}
          <div className="flex flex-wrap items-center justify-end gap-x-3 text-sm font-semibold" data-testid="swimlane-band-stats">
            {overdueCount > 0 && <span className="text-danger-on-tint whitespace-nowrap" data-testid="swimlane-overdue-count">{overdueCount} {STATUS_LABEL.overdue}</span>}
            {staleCount > 0 && <span className="text-warning-on-tint whitespace-nowrap" data-testid="swimlane-stale-count">{staleCount} {STATUS_LABEL.stale}</span>}
            {showLimitStat && limitReading !== null && (
              <SwimlaneLimitStat swimlane={swimlane} usage={limitUsage} reading={limitReading} hard={hardWip} showAtLimit={showWipAtLimit} />
            )}
            <span className="text-fg-secondary whitespace-nowrap" data-testid="swimlane-card-count">{countLabel}</span>
          </div>

          <div className="flex items-center gap-1 shrink-0">
            {/* Unset lane, admins only (#2243): a hover/focus-revealed icon,
                always in the DOM so Tab reaches it. Non-admins get nothing. */}
            {showHealthIcon && (
              <span className="inline-flex shrink-0" onDoubleClick={(e) => e.stopPropagation()}>
                <HealthStatusControl
                  entityKind="swimlane"
                  mode="basic"
                  entityName={swimlane.name}
                  parentName={null}
                  canEdit
                  trigger="icon"
                  onSave={saveHealth}
                  onAnnounce={setHealthAnnouncement}
                  autoFocus={healthFocus === "icon"}
                  onAutoFocused={clearHealthFocus}
                  onOpenChange={onIconOpenChange}
                  {...healthFields}
                />
              </span>
            )}
            {isAdmin && (
              <button type="button"
                onClick={() => setEditing(true)}
                className="transition text-xs text-fg-tertiary hover:text-fg opacity-30 group-hover:opacity-100 focus:opacity-100 focus:outline-none focus:ring-2 focus:ring-primary-emphasis rounded"
                title="Edit swimlane"
                aria-label="Edit swimlane"
              >
                ✎
              </button>
            )}
            {/* Focus icon — toggles single-swimlane focus mode on/off */}
            <button type="button"
              onClick={() => isFocused ? onExitFocus() : onFocus(swimlane.id)}
              className={`relative opacity-0 group-hover:opacity-100 focus:opacity-100 transition focus:ring-2 focus:ring-primary-emphasis rounded shrink-0 focus:outline-none ${isFocused ? "!opacity-100 text-info" : "text-fg-tertiary hover:text-fg"}`}
              title={isFocused ? "Exit focus" : `Focus on ${swimlane.name}`}
              aria-label={isFocused ? "Exit focus" : `Focus on ${swimlane.name}`}
              aria-pressed={isFocused}
            >
              <svg className="w-3.5 h-3.5" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
                <circle cx="8" cy="8" r="3" />
                <line x1="8" y1="1" x2="8" y2="4" />
                <line x1="8" y1="12" x2="8" y2="15" />
                <line x1="1" y1="8" x2="4" y2="8" />
                <line x1="12" y1="8" x2="15" y2="8" />
              </svg>
              <ActiveUnderline active={isFocused} placement="below" />
            </button>
          </div>
        </div>

        {/* Grid row. Expanded: one cell per column. Collapsed: a strip of count + status
            squares per column, aligned to the same grid. */}
        <div
          ref={rowRef}
          className="relative flex"
          style={{ minHeight: collapsed ? undefined : (minHeight ?? undefined) }}
          data-testid={collapsed ? "swimlane-collapsed-strip" : undefined}
        >
        {/* Cells — always iterate columns so collapsed-column stubs stay aligned */}
        {columns.map((col, colIdx) => {
          const cellCards = cards.filter((c) => c.column === col.id);
          const cellCount = cellCards.length;
          const cellWidth = colWidths?.get(col.id) ?? 220;
          const sepHighlighted = hoveredSepIndex === colIdx;

          // The sep sits to the LEFT of col[colIdx], so it resizes the column to its left:
          //   colIdx === 0  → insert only (no label panel to resize)
          //   colIdx  >  0  → resize columns[colIdx - 1]
          // This mirrors the header where ColumnSeparator after col[i] resizes col[i].
          const prevCol = colIdx > 0 ? columns[colIdx - 1] : null;
          const sepStartWidth = prevCol ? (colWidths?.get(prevCol.id) ?? 220) : 0;
          // The first separator has nothing to its left to resize since the label panel
          // went away (#2271): it only inserts a column.
          const canResizeSep = prevCol ? !!setColumnWidth : false;

          const handleSepMouseDown = (canResizeSep || onInsertColumn)
            ? (e: React.MouseEvent) => {
                e.preventDefault();
                const startX = e.clientX;
                const startWidth = sepStartWidth;
                let didDrag = false;
                const onMove = (ev: MouseEvent) => {
                  const delta = ev.clientX - startX;
                  if (!didDrag && Math.abs(delta) > 4) didDrag = true;
                  if (didDrag) {
                    if (prevCol && setColumnWidth) setColumnWidth(prevCol.id, startWidth + delta);
                  }
                };
                const onUp = () => {
                  if (!didDrag && isAdmin && onInsertColumn) onInsertColumn(col.id);
                  window.removeEventListener("mousemove", onMove);
                  window.removeEventListener("mouseup", onUp);
                };
                window.addEventListener("mousemove", onMove);
                window.addEventListener("mouseup", onUp);
              }
            : undefined;

          const sep = (
            <div
              key={`sep-${col.id}`}
              className={`relative shrink-0 flex items-stretch select-none ${canResizeSep || onInsertColumn ? "cursor-col-resize" : ""}`}
              style={{ width: 16 }}
              onMouseEnter={() => onSepHoverChange?.(colIdx)}
              onMouseLeave={() => onSepHoverChange?.(null)}
              onMouseDown={handleSepMouseDown}
            >
              <div className={`w-px self-stretch transition-colors ${sepHighlighted ? "bg-info/50" : "bg-surface-active/70"}`} />
              <div className={`flex-1 transition-colors ${sepHighlighted ? "bg-info/5" : "bg-sunken/70"}`} />
              <div className={`w-px self-stretch transition-colors ${sepHighlighted ? "bg-info/50" : "bg-surface-active/70"}`} />
              {isAdmin && onInsertColumn && sepHighlighted && (
                <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                  <SeparatorPlus className="text-xs" />
                </div>
              )}
            </div>
          );

          // Hidden by view prefs — show a narrow placeholder to preserve grid alignment
          if (hiddenColumnIds?.has(col.id)) {
            return (
              <div key={col.id} className="contents">
                {sep}
                <div className="w-10 shrink-0 flex items-center justify-center py-1">
                  {cellCount > 0 && (
                    <span className="text-xs text-fg-muted font-medium">{cellCount}</span>
                  )}
                </div>
              </div>
            );
          }

          if (collapsedColumnIds.has(col.id)) {
            // Collapsed column: show per-swimlane card count; pulse if filter matches are hidden here
            const matchCount = filteredCardIds
              ? cellCards.filter((c) => filteredCardIds.has(c.id)).length
              : 0;
            const hasMatch = matchCount > 0;
            return (
              <div key={col.id} className="contents">
                {sep}
                <div className={`w-10 shrink-0 flex items-center justify-center py-1${hasMatch ? " animate-pulse motion-reduce:animate-none bg-info/15" : ""}`}>
                  {(hasMatch ? matchCount : cellCount) > 0 && (
                    <span className={`text-xs font-medium ${hasMatch ? "text-info" : "text-fg-tertiary"}`}>
                      {hasMatch ? matchCount : cellCount}
                    </span>
                  )}
                </div>
              </div>
            );
          }

          if (collapsed) {
            // Collapsed lane (#2271): a strip cell per column. The card count is always
            // text (an en dash for none); one 10px square per card follows, colored by
            // status. A filter shows only the matching cards, and a match pulses.
            const shown = filteredCardIds ? cellCards.filter((c) => filteredCardIds.has(c.id)) : cellCards;
            const hasMatch = !!filteredCardIds && shown.length > 0;
            const tally = (st: CardBoardStatus) => shown.filter((c) => statusOf(c) === st).length;
            const summary = shown.length === 0
              ? `${col.name}: no cards`
              : `${col.name}: ${shown.length} ${shown.length === 1 ? "card" : "cards"}, ${tally("overdue")} overdue, ${tally("stale")} stale`;
            return (
              <div key={col.id} className="contents">
                {sep}
                <div
                  className={`shrink-0 flex flex-wrap content-center items-center gap-x-2 gap-y-1 rounded-lg bg-canvas px-3 py-2.5 min-h-10${hasMatch ? " animate-pulse motion-reduce:animate-none ring-1 ring-inset ring-info/50" : ""}`}
                  style={{ width: cellWidth }}
                  data-testid={`swimlane-strip-cell-${col.id}`}
                >
                  <span className="sr-only">{summary}</span>
                  <span aria-hidden="true" className="text-sm font-semibold text-fg">{shown.length > 0 ? shown.length : "–"}</span>
                  {shown.length > 0 && (
                    <span aria-hidden="true" className="flex flex-wrap items-center gap-1">
                      {shown.map((c) => (
                        <span key={c.id} data-status={statusOf(c)} className={`w-2.5 h-2.5 rounded-[2px] ${STATUS_SQUARE_CLASS[statusOf(c)]}`} />
                      ))}
                    </span>
                  )}
                </div>
              </div>
            );
          }

          return (
            <div key={col.id} className="contents">
              {sep}
              <BoardCell
                column={col}
                swimlane={swimlane}
                cards={cellCards.sort((a, b) => a.position - b.position)}
                boardId={boardId}
                canEdit={canEdit}
                closeEditorOnEnter={closeEditorOnEnter}
                filteredCardIds={filteredCardIds}
                selectedCardIds={selectedCardIds}
                highlightedCardId={highlightedCardId}
                currentCardId={currentCardId}
                onToggleCardSelection={onToggleCardSelection}
                onOpenCardMenu={onOpenCardMenu}
                contextTargetCardId={contextTargetCardId}
                onCardClick={onCardClick}
                onCardAdded={onCardAdded}
                density={density}
                userTimezone={userTimezone}
                currentUserId={currentUserId}
                userDateFormat={userDateFormat}
                compact={compact}
                staleness_threshold_days={staleness_threshold_days}
                stale_warning_pct={stale_warning_pct}
                customFieldDefinitions={customFieldDefinitions}
                onCardUpdated={onCardUpdated}
                width={cellWidth}
                overlayCell={overlayCells?.get(cellKey(col.id, swimlane.id))}
                overlayLabel={overlayLabel}
                getDropVerdict={getDropVerdict}
                getEntryCriteria={getEntryCriteria}
              />
            </div>
          );
        })}
        {/* Trailing separator to match header's trailing ColumnSeparator */}
        <div className="shrink-0 flex items-stretch" style={{ width: 16 }}>
          <div className="w-px self-stretch bg-surface-active/70" />
          <div className="flex-1 bg-sunken/70" />
          <div className="w-px self-stretch bg-surface-active/70" />
        </div>
        </div>
        {/* Bottom resize handle — drag to set row min-height */}
        {setSwimlaneHeight && (
          <div
            className="absolute bottom-0 left-0 right-0 h-1.5 cursor-row-resize hover:bg-info/20 transition-colors group/resize"
            onMouseDown={handleHeightResizeStart}
          >
            <div className="absolute bottom-0 left-0 right-0 h-px bg-info/0 group-hover/resize:bg-info/40 transition-colors" />
          </div>
        )}
      </div>

      {isAdmin && editing && (
        <EditSwimlaneModal
          boardId={boardId}
          swimlane={swimlane}
          cardCount={cards.length}
          columns={columns}
          laneCards={cards}
          boardColors={boardColors}
          limitFlags={limitFlags}
          onUpdated={(s) => { onSwimlaneUpdated(s); setEditing(false); }}
          onDeleted={(id) => { onSwimlaneDeleted(id); setEditing(false); }}
          onClose={() => setEditing(false)}
          swimlaneFieldDefinitions={swimlaneFieldDefinitions}
          userDateFormat={userDateFormat}
        />
      )}
    </>
  );
}
