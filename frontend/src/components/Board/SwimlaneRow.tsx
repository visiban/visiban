import { useState, useRef } from "react";
import SeparatorPlus from "./SeparatorPlus";
import { useInlineEditEscape } from "../../hooks/useInlineEditEscape";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { Card, CardDensity, Column, CustomFieldDefinition, Swimlane, SwimlaneCustomFieldDefinition } from "../../types";
import { updateSwimlane } from "../../api/boards";
import BoardCell from "./BoardCell";
import type { CardMenuAnchor } from "../Card/CardContextMenu";
import EditSwimlaneModal from "./EditSwimlaneModal";
import CustomFieldValueDisplay from "../Card/CustomFieldValueDisplay";
import SwimlaneFieldsPopover from "./SwimlaneFieldsPopover";
import { cellKey } from "../../gridOverlays/types";
import type { GridOverlayCellState } from "../../gridOverlays/slot";
import { laneLimitState, laneUsage, swimlaneLimitModes, type LaneLimitReading, type LaneUsage, type LimitFlags, type TrippedLimit } from "../../utils/placementLimits";

/**
 * The row's limit state line (#1150), mirroring the column header's stat row
 * (#973): one line, worst offender first (Over WIP > Over weight > At >
 * Under). The text carries the state; the meter is decorative.
 */
function SwimlaneLimitStat({ swimlane, usage, reading, hard, showAtLimit }: { swimlane: Swimlane; usage: LaneUsage; reading: LaneLimitReading; hard: boolean; showAtLimit: boolean }) {
  const wip = swimlane.wip_limit;
  const weight = swimlane.weight_limit;
  // "At limit" is the board's opt-in ambient indicator (Board.show_wip_at_limit),
  // as on the column header; off, an at-limit row reads like an under-limit
  // one. The two over-limit states are violations and always show.
  const state = reading.state === "at" && !showAtLimit ? "under" : reading.state;
  // The line names the metric that decided the state (laneLimitState).
  const showWip = reading.metric === "wip";
  const value = showWip ? usage.count : usage.weight;
  const limit = (showWip ? wip : weight) ?? 0;
  const numbers = `${value}/${limit}`;
  const label = showWip ? "WIP" : "Weight";
  const fill = limit > 0 ? Math.min(100, Math.round((value / limit) * 100)) : 100;
  let text: React.ReactNode;
  let tone: string;
  let meter: string;
  let title: string;
  if (state === "overWip") {
    text = <><span aria-hidden="true">{hard ? "⛔ " : "⚠ "}</span>Over WIP · <span className="font-semibold">{numbers}</span></>;
    tone = "text-danger font-medium";
    meter = "bg-danger-emphasis";
    title = hard ? "Over the swimlane's hard WIP limit — no override possible" : "Over the swimlane's WIP limit";
  } else if (state === "overWeight") {
    text = <>Over weight · <span className="font-semibold">{numbers}</span></>;
    // Fixed danger tokens for both over-limit states: § System signals
    // reserves "Lane over limit" as danger. The words, not the hue, tell
    // WIP from weight.
    tone = "text-danger font-medium";
    meter = "bg-danger-emphasis";
    title = "Over the swimlane's weight limit";
  } else if (state === "at") {
    text = <>{label} {numbers} · at limit</>;
    tone = "text-fg-secondary";
    meter = "bg-warning-emphasis";
    title = `Swimlane is at its ${label === "WIP" ? "WIP" : "weight"} limit (${numbers})`;
  } else {
    text = <>{label} {numbers}</>;
    tone = "text-fg-tertiary";
    meter = "bg-line-strong";
    title = `Swimlane ${label === "WIP" ? "WIP" : "weight"} limit: ${numbers} in the columns that count`;
  }
  return (
    // The numbers never truncate: the text keeps its width and the meter
    // shrinks (to nothing in a narrow panel) before it.
    <p className={`mt-1 flex items-center gap-2 min-w-0 text-xs ${tone}`} title={title} data-testid="swimlane-limit-stat">
      <span className="shrink-0 whitespace-nowrap">{text}</span>
      <span aria-hidden="true" className="flex-1 min-w-0 max-w-12 lg:max-w-16 h-1 rounded-full bg-surface-active overflow-hidden">
        <span className={`block h-full ${meter}`} style={{ width: `${fill}%` }} />
      </span>
    </p>
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
  sidebarWidth?: number;
  setSidebarWidth?: (w: number) => void;
  onResizeStart?: (e: React.MouseEvent) => void;
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
  /** Admin-only shortcut from the `+N` popover to Board settings → Swimlane
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

const NO_FLAGS: LimitFlags = { enforce_wip_limits: false, enforce_wip_hard: false, enforce_weight_limits: false };

export default function SwimlaneRow({ swimlane, columns, cards, boardId, isAdmin, canEdit, closeEditorOnEnter, collapsedColumnIds, hiddenColumnIds, filteredCardIds, selectedCardIds, highlightedCardId, currentCardId, onToggleCardSelection, onOpenCardMenu, contextTargetCardId, onCardClick, onCardAdded, onSwimlaneUpdated, onSwimlaneDeleted, collapsed, onToggleCollapse, onFocus, onExitFocus, isFocused, onHoverEnter, onHoverLeave, sidebarWidth, setSidebarWidth, colWidths, setColumnWidth, onInsertColumn, hoveredSepIndex, onSepHoverChange, minHeight, setSwimlaneHeight, density, userTimezone, userDateFormat, compact, staleness_threshold_days, stale_warning_pct, customFieldDefinitions, swimlaneFieldDefinitions, hideRowChipFieldNames, onEditFieldOrder, onCardUpdated, overlayCells, overlayLabel, limitFlags = NO_FLAGS, getDropVerdict, getEntryCriteria, showWipAtLimit = false }: Props) {
  const [editing, setEditing] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState("");
  const [renameError, setRenameError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const rowRef = useRef<HTMLDivElement>(null);
  const heightResizeState = useRef<{ startY: number; startHeight: number } | null>(null);
  const [fieldsPopoverRect, setFieldsPopoverRect] = useState<DOMRect | null>(null);
  const overflowRef = useRef<HTMLButtonElement>(null);

  // Row field values to render (#1140). Three guards, all deliberate:
  // an empty-string value renders nothing (never a dashed ghost chip — dashed
  // already means "unset" on the card face and must not gain a second
  // meaning); a value whose definition is missing is dropped silently (a WS
  // race between a definition delete and this render); and the pinned slice is
  // capped client-side so a server-side cap violation cannot blow out the row.
  const swimlaneFieldsById = new Map((swimlaneFieldDefinitions ?? []).map((d) => [d.id, d]));
  const rowFieldEntries = (swimlane.custom_field_values ?? [])
    .filter((v) => v.value !== "")
    .map((v) => ({ def: swimlaneFieldsById.get(v.field_definition), value: v.value }))
    .filter((x): x is { def: SwimlaneCustomFieldDefinition; value: string } => !!x.def)
    .sort((a, b) => a.def.position - b.def.position);
  const pinnedRowFields = rowFieldEntries.filter((x) => x.def.show_on_row).slice(0, 8);
  const unpinnedRowFields = rowFieldEntries.filter((x) => !x.def.show_on_row);
  const triggerLabel = unpinnedRowFields.length === 0
    ? 'All fields'
    : pinnedRowFields.length > 0 ? `+${unpinnedRowFields.length}` : `+${unpinnedRowFields.length} more`;

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

  const commitRename = async () => {
    const trimmed = draft.trim();
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
    setRenaming(false);
    setDraft("");
  };

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

  return (
    <>
      <div
        ref={(el) => { setNodeRef(el); (rowRef as React.MutableRefObject<HTMLDivElement | null>).current = el; }}
        style={{ transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.3 : 1, minHeight: collapsed ? undefined : (minHeight ?? undefined) }}
        className="relative flex border-b border-line bg-surface"
        onMouseEnter={onHoverEnter}
        onMouseLeave={onHoverLeave}
      >
        {/* Swimlane label — sticky to the left. The hover tint is a ::before overlay,
            not a hover:bg-* on the panel itself: a translucent hover background replaces
            the opaque bg-surface and lets cards scrolled underneath show through. */}
        <div
          className={`shrink-0 flex items-center gap-2 pl-1 pr-3 sticky left-0 z-10 bg-surface border-l-4 before:pointer-events-none before:absolute before:inset-0 before:-z-10 before:bg-surface-hover/30 before:opacity-0 hover:before:opacity-100 group relative ${collapsed ? "py-1" : "py-3 items-start"}`}
          style={{ width: sidebarWidth ?? 220, borderLeftColor: swimlane.color || "transparent" }}
          data-tour-step="swimlane"
          // The card detail sheet never covers the lane labels (#1914).
          data-lane-label
          data-no-pan
          onDoubleClick={isAdmin ? () => setEditing(true) : undefined}
        >
          {/* Over-WIP top accent (#1150), the row's version of the column
              header's strip: an inset line, so the panel does not grow. */}
          {limitState === "overWip" && (
            <span aria-hidden="true" className="pointer-events-none absolute inset-x-0 top-0 h-0.5 bg-danger-emphasis" />
          )}
          {/* Drag handle */}
          {isAdmin && (
            <span
              {...attributes}
              {...listeners}
              className={`text-fg-faint hover:text-fg-secondary cursor-grab active:cursor-grabbing text-sm select-none shrink-0 opacity-0 group-hover:opacity-100 focus:opacity-100 focus:outline-none focus:ring-2 focus:ring-primary-emphasis rounded transition-opacity ${collapsed ? "" : "mt-0.5"}`}
              title="Drag to reorder"
            >
              ⠿
            </span>
          )}

          <div className="flex-1 min-w-0">
            {renaming ? (
              <input
                ref={inputRef}
                autoFocus
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") { e.preventDefault(); void commitRename(); } // commitRename manages its own error state (renameError) and never rejects
                }}
                onBlur={commitRename}
                onClick={(e) => e.stopPropagation()}
                className="w-full text-sm bg-sunken text-fg border border-primary-emphasis rounded px-1 py-0 outline-none"
              />
            ) : (
              <p
                className={`text-sm text-fg-secondary truncate ${isAdmin ? "cursor-text hover:text-fg" : ""}`}
                title={isAdmin ? undefined : swimlane.name}
              >
                {isAdmin ? (
                  // A real button so keyboard users can reach inline rename with Tab + Enter/Space (#1376).
                  <button
                    type="button"
                    className="block max-w-full truncate text-left cursor-text rounded focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
                    title="Click to rename"
                    onClick={(e) => { e.stopPropagation(); startRenaming(); }}
                  >
                    {swimlane.name}
                  </button>
                ) : (
                  swimlane.name
                )}
              </p>
            )}
            {!collapsed && isAdmin && swimlane.contact_email && <p className="text-xs text-fg-tertiary truncate">{swimlane.contact_email}</p>}
            {showLimitStat && limitReading !== null && (
              <SwimlaneLimitStat swimlane={swimlane} usage={limitUsage} reading={limitReading} hard={hardWip} showAtLimit={showWipAtLimit} />
            )}
            {renameError && <p className="text-xs text-danger truncate" role="alert">{renameError}</p>}
            {/* Gated on !collapsed, matching contact_email above: a collapsed
                row is py-1 and exists to give vertical space back, so stacked
                chips would undo the gesture the user just made. The +N trigger
                disappears with them, so nothing is silently truncated. */}
            {!collapsed && rowFieldEntries.length > 0 && (
              <div className="flex flex-col items-start gap-1 mt-1 min-w-0">
                {pinnedRowFields.map(({ def, value }) => (
                  <CustomFieldValueDisplay
                    key={def.id}
                    definition={def}
                    value={value}
                    variant="row-chip"
                    adminOnly={def.is_admin_only}
                    hideName={hideRowChipFieldNames}
                    userDateFormat={userDateFormat}
                  />
                ))}
                {/* With names hidden, the popover is the only touch/keyboard path to a
                    value's field name, so an all-pinned row keeps a trigger too (#1509). */}
                {(unpinnedRowFields.length > 0 || (hideRowChipFieldNames && pinnedRowFields.length > 0)) && (
                  <button
                    ref={overflowRef}
                    onClick={(e) => {
                      // The label panel's parent has onDoubleClick -> edit for
                      // admins; without this the click bubbles into it.
                      e.stopPropagation();
                      setFieldsPopoverRect(e.currentTarget.getBoundingClientRect());
                    }}
                    aria-haspopup="dialog"
                    aria-expanded={fieldsPopoverRect !== null}
                    // Visible text leads the accessible name (WCAG 2.5.3 label-in-name).
                    aria-label={`${triggerLabel}: Show all ${rowFieldEntries.length} field values for ${swimlane.name}`}
                    className="inline-flex items-center min-h-6 text-xs px-1.5 py-0.5 rounded border border-line text-fg-tertiary hover:text-fg-secondary hover:bg-surface-hover shrink-0 focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
                  >
                    {triggerLabel}
                  </button>
                )}
              </div>
            )}
          </div>
          <div className="flex items-center gap-1 shrink-0">
            {!collapsed && isAdmin && (
              <button
                onClick={() => setEditing(true)}
                className="transition text-xs text-fg-tertiary hover:text-fg opacity-30 group-hover:opacity-100 focus:opacity-100 focus:outline-none focus:ring-2 focus:ring-primary-emphasis rounded"
                title="Edit swimlane"
                aria-label="Edit swimlane"
              >
                ✎
              </button>
            )}
            {/* Focus icon — toggles single-swimlane focus mode on/off */}
            <button
              onClick={() => isFocused ? onExitFocus() : onFocus(swimlane.id)}
              className={`opacity-0 group-hover:opacity-100 focus:opacity-100 transition focus:ring-2 focus:ring-primary-emphasis rounded shrink-0 focus:outline-none ${isFocused ? "!opacity-100 text-info" : "text-fg-tertiary hover:text-fg"}`}
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
            </button>
            <button
              data-tour-step="swimlane-collapse"
              onClick={onToggleCollapse}
              className="text-fg-tertiary hover:text-fg transition shrink-0 focus:outline-none focus:ring-2 focus:ring-primary-emphasis rounded"
              aria-pressed={collapsed}
              aria-label={collapsed ? `Expand ${swimlane.name}` : `Collapse ${swimlane.name}`}
              title={collapsed ? `Expand ${swimlane.name}` : `Collapse ${swimlane.name}`}
            >
              <svg
                className={`w-4 h-4 transition-transform ${collapsed ? "-rotate-90" : ""}`}
                viewBox="0 0 20 20"
                fill="currentColor"
              >
                <path fillRule="evenodd" d="M5.293 7.293a1 1 0 011.414 0L10 10.586l3.293-3.293a1 1 0 111.414 1.414l-4 4a1 1 0 01-1.414 0l-4-4a1 1 0 010-1.414z" clipRule="evenodd" />
              </svg>
            </button>
          </div>
        </div>

        {/* Cells — always iterate columns so collapsed-column stubs stay aligned */}
        {columns.map((col, colIdx) => {
          const cellCards = cards.filter((c) => c.column === col.id);
          const cellCount = cellCards.length;
          const cellWidth = colWidths?.get(col.id) ?? 220;
          const sepHighlighted = hoveredSepIndex === colIdx;

          // The sep sits to the LEFT of col[colIdx], so it resizes the column to its left:
          //   colIdx === 0  → resize the swimlane sidebar
          //   colIdx  >  0  → resize columns[colIdx - 1]
          // This mirrors the header where ColumnSeparator after col[i] resizes col[i].
          const prevCol = colIdx > 0 ? columns[colIdx - 1] : null;
          const sepStartWidth = prevCol
            ? (colWidths?.get(prevCol.id) ?? 220)
            : (sidebarWidth ?? 220);
          const canResizeSep = prevCol ? !!setColumnWidth : !!setSidebarWidth;

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
                    else if (!prevCol && setSidebarWidth) setSidebarWidth(startWidth + delta);
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
                    <span className="text-xs text-fg-faint font-medium">{cellCount}</span>
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
            // Swimlane collapsed — full-width cell showing card count as a pill badge
            const matchCount = filteredCardIds
              ? cellCards.filter((c) => filteredCardIds.has(c.id)).length
              : 0;
            const hasMatch = matchCount > 0;
            const displayCount = hasMatch ? matchCount : cellCount;
            return (
              <div key={col.id} className="contents">
                {sep}
                <div
                  className={`shrink-0 flex items-center justify-center bg-canvas${hasMatch ? " animate-pulse motion-reduce:animate-none" : ""}`}
                  style={{ width: cellWidth }}
                >
                  {displayCount > 0 ? (
                    <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${hasMatch ? "bg-primary-emphasis/20 text-info" : "bg-surface text-fg-tertiary"}`}>
                      {displayCount}
                    </span>
                  ) : null}
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

      {fieldsPopoverRect && (
        <SwimlaneFieldsPopover
          swimlaneName={swimlane.name}
          entries={rowFieldEntries}
          anchorRect={fieldsPopoverRect}
          userDateFormat={userDateFormat}
          onEdit={isAdmin ? () => setEditing(true) : undefined}
          onEditOrder={isAdmin ? onEditFieldOrder : undefined}
          onDismiss={() => setFieldsPopoverRect(null)}
          triggerRef={overflowRef}
        />
      )}

      {isAdmin && editing && (
        <EditSwimlaneModal
          boardId={boardId}
          swimlane={swimlane}
          cardCount={cards.length}
          columns={columns}
          laneCards={cards}
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
