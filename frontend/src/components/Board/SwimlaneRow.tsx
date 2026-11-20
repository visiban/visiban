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
import { laneHealthAuto, laneHealthFields } from "../../utils/healthStatus";
import BoardCell from "./BoardCell";
import type { CardMenuAnchor } from "../Card/CardContextMenu";
import OverflowMenu from "../Layout/OverflowMenu";
import EditSwimlaneModal from "./EditSwimlaneModal";
import CustomFieldValueDisplay from "../Card/CustomFieldValueDisplay";
import { STATUS_LABEL, STATUS_SQUARE_CLASS, cardBoardStatus, type CardBoardStatus } from "../../constants/laneStatus";
import { cellKey } from "../../gridOverlays/types";
import type { GridOverlayCellState } from "../../gridOverlays/slot";
import type { LimitFlags, TrippedLimit } from "../../utils/placementLimits";
import { isImeComposing } from "../../utils/imeComposition";
import { laneRollup } from "../../utils/laneRollup";
import { splitCellBySubColumn, stageSubColumns } from "../../utils/stages";
import { INLINE_FIELD_COUNT, laneBandFields, laneBandLimit, laneGridFields, type LaneBandField } from "../../utils/laneBand";
import LaneFieldGrid from "./LaneFieldGrid";
import SwimlaneLimitStat from "./SwimlaneLimitStat";
import ActiveUnderline from "../Common/ActiveUnderline";
import { BAND_MAX_WIDTH, boardGridTemplate, clampColumnWidth, measureTrackLeftOf, resizedColumnWidth, startInsertGesture } from "./boardGrid";

interface Props {
  swimlane: Swimlane;
  /** #2245: the board's auto health is on, so the lane shows its computed status. */
  healthAutoEnabled?: boolean;
  columns: Column[];
  cards: Card[];
  boardId: number;
  isAdmin: boolean;
  canEdit: boolean;
  closeEditorOnEnter: boolean;
  collapsedColumnIds: Set<number>;
  hiddenColumnIds?: Set<number>;
  filteredCardIds: Set<number> | null;
  /**
   * #2324 — filters or a Show chip match no card on the board: the lane shrinks
   * to its band, reading "No matching cards", with no cells or resize handle.
   */
  noMatch?: boolean;
  selectedCardIds: Set<number>;
  highlightedCardId?: number | null;
  /** The card open in the card detail sheet, if any (#1914). */
  currentCardId?: number | null;
  onToggleCardSelection: (cardId: number) => void;
  /** Card context menu (#2059), passed through to each BoardCell. */
  onOpenCardMenu?: (card: Card, anchor: CardMenuAnchor) => void;
  contextTargetCardId?: number | null;
  /** View menu "Show sub-columns" (#2278), passed to every cell. */
  showSubColumns?: boolean;
  onCardClick: (card: Card, opts?: { peek?: boolean }) => void;
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
  /** The board's shared `grid-template-columns` (#2300, `boardGrid.ts`). Omitted
   *  (tests, isolated renders): built from `columns` with every track a normal column. */
  gridTemplate?: string;
  /** Saved per-column widths (px, `viewPrefs.columnWidths`); the lane separators' drag starts from these. */
  colWidths?: Map<number, number>;
  /** Resize a column from a lane separator drag. Omitted: lane separators only insert. */
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
   * a per-viewer preference. The field grid always lists names.
   */
  hideRowChipFieldNames?: boolean;
  /** Admin-only shortcut from the open field grid to Board settings -> Swimlane
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
  /**
   * The board's swimlane rollup field (#2275, `resolveRollupField`): the card
   * number field the band sums over the lane's open cards. Null or omitted:
   * no rollup in the band.
   */
  rollupField?: CustomFieldDefinition | null;
}

const NO_FLAGS: LimitFlags = { enforce_wip_limits: false, enforce_wip_hard: false, enforce_weight_limits: false };

/**
 * A lane shows its health pill when it has an effective status, or, on an
 * auto-health board (#2245), once it has been computed (an empty lane reads
 * "No open cards" rather than vanishing). Otherwise an admin gets the icon.
 */
function lanePillVisible(lane: Swimlane, autoEnabled: boolean): boolean {
  if (laneHealthFields(lane).effective_health_status !== null) return true;
  return autoEnabled && !!lane.health_computed_at;
}

export default function SwimlaneRow({ swimlane, healthAutoEnabled = false, columns, cards, boardId, isAdmin, canEdit, closeEditorOnEnter, collapsedColumnIds, hiddenColumnIds, filteredCardIds, noMatch = false, selectedCardIds, highlightedCardId, currentCardId, onToggleCardSelection, onOpenCardMenu, contextTargetCardId, showSubColumns = true, onCardClick, onCardAdded, onSwimlaneUpdated, onSwimlaneDeleted, collapsed, onToggleCollapse, onFocus, onExitFocus, isFocused, onHoverEnter, onHoverLeave, gridTemplate, colWidths, setColumnWidth, onInsertColumn, hoveredSepIndex, onSepHoverChange, minHeight, setSwimlaneHeight, density, userTimezone, currentUserId, userDateFormat, compact, staleness_threshold_days, stale_warning_pct, customFieldDefinitions, swimlaneFieldDefinitions, hideRowChipFieldNames, onEditFieldOrder, onCardUpdated, overlayCells, overlayLabel, limitFlags = NO_FLAGS, boardColors, getDropVerdict, getEntryCriteria, showWipAtLimit = false, rollupField = null }: Props) {
  const [editing, setEditing] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState("");
  const [renameError, setRenameError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  // Focus returns to the opener on Escape/Enter (#2087); a blur-commit never steals focus back.
  const renameTriggerRef = useRef<HTMLButtonElement>(null);
  const focusTriggerRef = useRef(false);
  const rowRef = useRef<HTMLDivElement>(null);
  const heightResizeState = useRef<{ startY: number; startHeight: number } | null>(null);
  // The "N fields" toggle opens the aligned field grid (#2354).
  const [fieldsOpen, setFieldsOpen] = useState(false);
  const extraFieldsId = useId();

  // The band shows the first two fields inline; the full grid sits behind "N fields" (#2271, #2354,
  // on-demand tier #2335). Pinning no longer decides what shows: position does.
  // Guards and order: `laneBandFields`, shared with the phone band (#2329).
  const { inline: inlineFields } = laneBandFields(swimlane, swimlaneFieldDefinitions);
  const gridFields = laneGridFields(swimlane, swimlaneFieldDefinitions, isAdmin);
  // Until the band slots (#2356) land, K is the inline fields shown today.
  const showFieldToggle = gridFields.length > INLINE_FIELD_COUNT; // constant, so every lane shows the toggle or none does

  // Status counts for the band's trailing stats and the collapsed strip's squares.
  const doneColumnIds = new Set(columns.filter((c) => c.is_done).map((c) => c.id));
  const statusOf = (card: Card): CardBoardStatus => cardBoardStatus(card, doneColumnIds.has(card.column));
  const overdueCount = cards.filter((c) => statusOf(c) === "overdue").length;
  const staleCount = cards.filter((c) => statusOf(c) === "stale").length;

  // Row limit state (#1150), from the row's active cards in its counted columns.
  // Null when unset, or calm on a collapsed row (tertiary tier, #2335).
  const limit = laneBandLimit(swimlane, columns, cards, limitFlags, collapsed);
  // Number rollup (#2275); null when the board chose no number field.
  const rollup = laneRollup(swimlane.id, rollupField, columns, cards);

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
    // The pill and the icon swap only when the pill's visibility changes; on
    // an auto board (#2245) clearing a pin keeps the computed pill.
    const before = lanePillVisible(swimlane, healthAutoEnabled);
    const after = lanePillVisible(updated, healthAutoEnabled);
    if (before !== after) {
      if (after) setHealthFocus("pill");
      else if (collapsed) focusNameAfterHealthClear.current = true;
      else setHealthFocus("icon");
    }
    return { effective_health_status: laneHealthFields(updated).effective_health_status };
  }, [boardId, swimlane, onSwimlaneUpdated, collapsed, healthAutoEnabled]);
  const pillVisible = lanePillVisible(swimlane, healthAutoEnabled);
  const showHealthPill = pillVisible || healthOpen === "pill";
  const showHealthIcon = !collapsed && isAdmin && (!pillVisible || healthOpen === "icon");
  const healthFields = laneHealthFields(swimlane);
  const healthAuto = laneHealthAuto(swimlane, healthAutoEnabled);

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

  const renderField = ({ def, value }: LaneBandField) => (
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
            It wraps to a second line when it runs out of room.
            Pinned while the grid scrolls sideways (#2305): `sticky left-4` holds it at
            the left gutter and BAND_MAX_WIDTH caps it to the visible width, so the
            name, fields and the stats at its right stay on screen. When the grid fits
            the window the cap equals the band's own width and nothing moves. The
            cells below are not part of the band, so column alignment is untouched. */}
        <div
          className={`group sticky left-4 mx-4 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border px-3 py-2.5 ${color ? "" : "bg-surface border-line"}`}
          style={{
            maxWidth: BAND_MAX_WIDTH,
            ...(color ? { backgroundColor: `color-mix(in srgb, ${color} 12%, rgb(var(--surface)))`, borderColor: `color-mix(in srgb, ${color} 45%, rgb(var(--border)))` } : {}),
          }}
          data-tour-step="swimlane"
          data-testid="swimlane-band"
          data-no-pan
          // A double-click on a control inside the band (rename input, chevron, N fields, icons) is
          // that control's own gesture, never "open Edit Swimlane".
          onDoubleClick={isAdmin ? (e) => { if (!(e.target as HTMLElement).closest("button, input, a, [role=button]")) setEditing(true); } : undefined}
        >
          {isAdmin && (
            <span
              {...attributes}
              {...listeners}
              className="text-fg-faint hover:text-fg-secondary cursor-grab active:cursor-grabbing text-sm select-none shrink-0 opacity-0 group-hover:opacity-100 focus:opacity-100 [@media(hover:none)]:opacity-100 focus:outline-none focus:ring-2 focus:ring-primary-emphasis rounded transition-opacity"
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
                auto={healthAuto}
                {...healthFields}
              />
            </span>
          )}
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
                auto={healthAuto}
                {...healthFields}
              />
            </span>
          )}
          {/* Lane actions beside the name (#2353): Focus (everyone) and the admin menu. Hidden
              controls keep their space (opacity, never display:none) so nothing shifts on hover. */}
          <button type="button"
            onClick={() => isFocused ? onExitFocus() : onFocus(swimlane.id)}
            className={`relative inline-flex items-center justify-center min-w-6 min-h-6 rounded shrink-0 hover:bg-surface-hover opacity-0 group-hover:opacity-100 focus:opacity-100 [@media(hover:none)]:opacity-100 transition-opacity motion-reduce:transition-none focus:outline-none focus:ring-2 focus:ring-primary-emphasis ${isFocused ? "!opacity-100 text-info" : "text-fg-tertiary hover:text-fg"}`}
            title={isFocused ? "Exit focus" : `Focus on ${swimlane.name}`}
            // Stable label: aria-pressed carries the state, so a swapped name would announce it twice.
            aria-label={`Focus on ${swimlane.name}`}
            aria-pressed={isFocused}
          >
            <svg className="w-4 h-4" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
              <circle cx="8" cy="8" r="3" />
              <line x1="8" y1="1" x2="8" y2="4" />
              <line x1="8" y1="12" x2="8" y2="15" />
              <line x1="1" y1="8" x2="4" y2="8" />
              <line x1="12" y1="8" x2="15" y2="8" />
            </svg>
            <ActiveUnderline active={isFocused} placement="below" />
          </button>
          {isAdmin && (
            // A portaled menu breaks focus-within, so the open state is held here to keep the trigger visible.
            <span
              className={`shrink-0 inline-flex opacity-0 group-hover:opacity-100 focus-within:opacity-100 [@media(hover:none)]:opacity-100 transition-opacity motion-reduce:transition-none ${menuOpen ? "!opacity-100" : ""}`}
              onDoubleClick={(e) => e.stopPropagation()}
            >
              <OverflowMenu
                ariaLabel={`Actions for swimlane "${swimlane.name}"`}
                triggerClassName={`inline-flex items-center justify-center min-w-6 min-h-6 rounded shrink-0 text-fg-tertiary hover:text-fg hover:bg-surface-hover focus:outline-none focus:ring-2 focus:ring-primary-emphasis ${menuOpen ? "text-info-on-tint bg-info/10" : ""}`}
                externalOpen={menuOpen}
                onExternalOpenChange={setMenuOpen}
                items={[
                  { id: "edit", label: "Edit swimlane…", onSelect: () => setEditing(true) },
                  ...(onEditFieldOrder ? [{ id: "field-order", label: "Change field order…", onSelect: onEditFieldOrder }] : []),
                ]}
              />
            </span>
          )}
          <span role="status" aria-live="polite" className="sr-only">{healthAnnouncement}</span>
          {renameError && <span className="text-xs text-danger-on-tint" role="alert">{renameError}</span>}

          {/* The "N fields" toggle sits before the two inline fields, so opening and closing
              never moves it; open, the inline fields hide because the grid shows everything. */}
          {showFieldToggle && (
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); setFieldsOpen((o) => !o); }}
              aria-expanded={fieldsOpen}
              aria-controls={fieldsOpen ? extraFieldsId : undefined}
              // Visible text leads the accessible name (WCAG 2.5.3 label-in-name).
              aria-label={`${gridFields.length} fields: show all field values for ${swimlane.name}`}
              data-testid="swimlane-fields-toggle"
              className={`inline-flex items-center gap-1 min-h-6 text-xs px-2 py-0.5 rounded-full border shrink-0 focus:outline-none focus:ring-2 focus:ring-primary-emphasis ${fieldsOpen ? "bg-info/10 text-info-on-tint border-info/40" : "border-line-strong text-fg-secondary hover:text-fg hover:bg-surface-hover"}`}
            >
              {gridFields.length} fields
              <svg aria-hidden="true" className={`w-3 h-3 transition-transform motion-reduce:transition-none ${fieldsOpen ? "" : "-rotate-90"}`} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M4 6l4 4 4-4" /></svg>
            </button>
          )}
          {/* The first two lane fields as "Label value". They stay in the band when the lane
              is collapsed (the band is the collapsed lane's header). */}
          {!(showFieldToggle && fieldsOpen) && inlineFields.map(renderField)}

          <div className="flex-1 min-w-0" />

          {/* Trailing stats (tiers: frontend/CLAUDE.md § Swimlane bands, #2335): overdue and
              stale (secondary, omitted at zero), the limit line (#1150; tertiary: a calm one
              folds away when collapsed, an over-limit one never does), then the number rollup
              (#2275). The band ends at the rollup, as in board-dark.png: no card count (#2328).
              Text always carries the state; color only reinforces it. */}
          {noMatch && <span className="text-sm text-fg-tertiary whitespace-nowrap" data-testid="swimlane-no-match">No matching cards</span>}
          {/* board-states.png: the no-match band is the name and "No matching cards" only, so the stats go. */}
          {!noMatch && (
          <div className="flex flex-wrap items-center justify-end gap-x-3 text-sm font-semibold" data-testid="swimlane-band-stats">
            {overdueCount > 0 && <span className="text-danger-on-tint whitespace-nowrap" data-testid="swimlane-overdue-count">{overdueCount} {STATUS_LABEL.overdue}</span>}
            {staleCount > 0 && <span className="text-warning-on-tint whitespace-nowrap" data-testid="swimlane-stale-count">{staleCount} {STATUS_LABEL.stale}</span>}
            {limit !== null && (
              <SwimlaneLimitStat swimlane={swimlane} usage={limit.usage} reading={limit.reading} hard={limit.hard} showAtLimit={showWipAtLimit} />
            )}
            {/* Number rollup (#2275): the board's chosen number field summed over the
                lane's cards not in a done column. Hidden with no (number) field chosen. */}
            {rollup !== null && (
              <span className="text-fg whitespace-nowrap" data-testid="swimlane-rollup" title={`${rollup.fieldName}: total of the cards not in a done column`}>
                {/* The field name for screen readers: a span's aria-label is not announced
                    (generic role), and the visible "$413k open" does not say what it sums. */}
                <span className="sr-only">{rollup.fieldName}: </span>{rollup.text} open
              </span>
            )}
          </div>
          )}

          {/* The aligned field grid: last in the band, on its own line (#2354). */}
          {showFieldToggle && fieldsOpen && (
            <>
              <LaneFieldGrid id={extraFieldsId} laneName={swimlane.name} laneColor={color} fields={gridFields} userDateFormat={userDateFormat} />
              {isAdmin && onEditFieldOrder && (
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); onEditFieldOrder(); }}
                  className="inline-flex items-center min-h-6 text-xs text-info-on-tint underline rounded shrink-0 focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
                >
                  Change field order
                </button>
              )}
            </>
          )}
        </div>

        {/* Grid row. Expanded: one cell per column. Collapsed: a strip of count + status
            squares per column, aligned to the same grid. None when nothing matches (#2324). */}
        {!noMatch && (
        <div
          ref={rowRef}
          className="relative grid"
          style={{ gridTemplateColumns: gridTemplate ?? boardGridTemplate(columns.map(() => "column")), minHeight: collapsed ? undefined : (minHeight ?? undefined) }}
          data-testid={collapsed ? "swimlane-collapsed-strip" : undefined}
        >
        {/* Cells — always iterate columns so collapsed-column stubs stay aligned */}
        {columns.map((col, colIdx) => {
          const cellCards = cards.filter((c) => c.column === col.id);
          const cellCount = cellCards.length;
          const sepHighlighted = hoveredSepIndex === colIdx;

          // The sep sits to the LEFT of col[colIdx], so a drag resizes the column to its left:
          //   colIdx === 0  → insert only (nothing to its left since #2271)
          //   colIdx  >  0  → resize columns[colIdx - 1], unless that is a hidden or
          //                   collapsed 40px stub (no width to drag)
          // This mirrors the header, where the ColumnSeparator after col[i] resizes col[i].
          // A drag changes the column's weight in the shared grid template (#2300).
          const prevCol = colIdx > 0 ? columns[colIdx - 1] : null;
          const canResizeSep = !!prevCol && !!setColumnWidth && !hiddenColumnIds?.has(prevCol.id) && !collapsedColumnIds.has(prevCol.id);
          const canInsert = isAdmin && !!onInsertColumn;
          const handleSepMouseDown = (canResizeSep || canInsert)
            ? (e: React.MouseEvent<HTMLDivElement>) => {
                const startWidth = prevCol ? clampColumnWidth(colWidths?.get(prevCol.id)) : 0;
                const measure = canResizeSep ? measureTrackLeftOf(e.currentTarget, colIdx) : null;
                startInsertGesture(
                  e,
                  () => { if (canInsert) onInsertColumn!(col.id); },
                  canResizeSep ? (delta) => setColumnWidth!(prevCol!.id, resizedColumnWidth(startWidth, measure, delta)) : undefined,
                );
              }
            : undefined;

          const sep = (
            <div
              key={`sep-${col.id}`}
              className={`relative flex items-stretch select-none ${canResizeSep ? "cursor-col-resize" : canInsert ? "cursor-pointer" : ""}`}
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
            // A split stage shows one count and square row per sub-column, with
            // the dashed divider between them (spec § Lanes, Collapsed).
            const subs = showSubColumns ? stageSubColumns(col) : [];
            const groups = subs.length > 0 ? splitCellBySubColumn(shown, col) : [shown];
            const cardsWord = (n: number) => `${n} ${n === 1 ? "card" : "cards"}`;
            const summary = shown.length === 0
              ? `${col.name}: no cards`
              : subs.length > 0
                ? `${col.name}: ${groups.map((g, i) => `${subs[i].name} ${cardsWord(g.length)}`).join(", ")}, ${tally("overdue")} overdue, ${tally("stale")} stale`
                : `${col.name}: ${cardsWord(shown.length)}, ${tally("overdue")} overdue, ${tally("stale")} stale`;
            return (
              <div key={col.id} className="contents">
                {sep}
                <div
                  className={`min-w-0 flex flex-wrap content-center items-center gap-x-2 gap-y-1 rounded-lg bg-canvas px-3 py-2.5 min-h-10${hasMatch ? " animate-pulse motion-reduce:animate-none ring-1 ring-inset ring-info/50" : ""}`}
                  data-testid={`swimlane-strip-cell-${col.id}`}
                >
                  <span className="sr-only">{summary}</span>
                  {groups.map((g, i) => (
                    <span key={i} className="contents" data-testid={subs.length > 0 ? `swimlane-strip-sub-${col.id}-${i}` : undefined}>
                      {i > 0 && <span aria-hidden="true" data-testid="swimlane-strip-sub-divider" className="self-stretch border-l border-dashed border-line-boundary" />}
                      <span aria-hidden="true" className="text-sm font-semibold text-fg">{g.length > 0 ? g.length : "–"}</span>
                      {g.length > 0 && (
                        <span aria-hidden="true" className="flex flex-wrap items-center gap-1">
                          {g.map((c) => (
                            <span key={c.id} data-status={statusOf(c)} className={`w-2.5 h-2.5 rounded-[2px] ${STATUS_SQUARE_CLASS[statusOf(c)]}`} />
                          ))}
                        </span>
                      )}
                    </span>
                  ))}
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
                showSubColumns={showSubColumns}
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
                overlayCell={overlayCells?.get(cellKey(col.id, swimlane.id))}
                overlayLabel={overlayLabel}
                getDropVerdict={getDropVerdict}
                getEntryCriteria={getEntryCriteria}
              />
            </div>
          );
        })}
        {/* Trailing separator to match header's trailing ColumnSeparator */}
        <div className="flex items-stretch">
          <div className="w-px self-stretch bg-surface-active/70" />
          <div className="flex-1 bg-sunken/70" />
          <div className="w-px self-stretch bg-surface-active/70" />
        </div>
        </div>
        )}
        {/* Bottom resize handle — drag to set row min-height */}
        {setSwimlaneHeight && !noMatch && (
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
