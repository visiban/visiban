import { useState, useId, useRef, useEffect } from "react";
import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";
import type { Card, CardDensity, Column, CustomFieldDefinition, Swimlane, SwimlaneCustomFieldDefinition } from "../../types";
import { createCard } from "../../api/cards";
import { limitBlockedMessage } from "./moveBlockedMessages";
import EditSwimlaneModal from "./EditSwimlaneModal";
import EditColumnModal from "./EditColumnModal";
import type { BoardColor } from "../../utils/boardColors";
import type { LimitFlags } from "../../utils/placementLimits";
import CardItem from "../Card/CardItem";
import type { CardMenuAnchor } from "../Card/CardContextMenu";
import { columnTintStyle } from "../../utils/colorContrast";
import { STATUS_LABEL, cardBoardStatus } from "../../constants/laneStatus";

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
  onCardClick: (card: Card) => void;
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
  allColumns?: Column[];
  boardColors?: BoardColor[];
  limitFlags?: LimitFlags;
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
  /** Asks the board to open the add-card input for a cell (header "+", empty-board button). */
  addRequest?: { columnId: number; swimlaneId: number; nonce: number } | null;
}

const ACTION_BTN = "inline-flex items-center justify-center min-h-11 px-3 text-sm rounded border border-line-strong text-fg hover:bg-surface-hover focus:outline-none focus:ring-2 focus:ring-primary-emphasis";

/**
 * Phone layout of the board (#2277, board-redesign.md § Phone width): one column
 * at a time, lanes stacked. There is no drag here; moving a card uses the card's
 * "More actions" menu (Move to column), the same path as the keyboard.
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
  isAdmin = false, allColumns, boardColors, limitFlags, swimlaneFieldDefinitions, intakeColumnId = null,
  onCardAdded, onColumnUpdated, onRequestDeleteColumn, onSwimlaneUpdated, onSwimlaneDeleted,
  onAddColumn, onAddSwimlane, focusedSwimlaneId = null, onFocusLane, onExitFocus, addRequest = null,
}: Props) {
  const ordered = [...columns].sort((a, b) => a.position - b.position);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const uid = useId();
  const [addingLane, setAddingLane] = useState<number | null>(null);
  const [draft, setDraft] = useState("");
  const [addError, setAddError] = useState<string | null>(null);
  const [editingLane, setEditingLane] = useState<number | null>(null);
  const [editingColumn, setEditingColumn] = useState(false);
  const lastRequest = useRef<number | null>(null);

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
  }, [addRequest, collapsedSwimlaneIds, onToggleSwimlane]);
  // A column deleted or hidden while selected falls back to the first one.
  const column = ordered.find((c) => c.id === selectedId) ?? ordered[0];
  if (!column) return <p data-testid="phone-board-empty" className="px-3 py-4 text-sm text-fg-secondary">No visible columns</p>;

  const columnCards = cards.filter((c) => c.column === column.id);
  const count = columnCards.length;
  const limit = column.wip_limit !== null && column.wip_limit > 0 ? column.wip_limit : null;
  const over = limit !== null && count > limit;
  const selectColumn = (id: number, focus = false) => {
    setSelectedId(id);
    if (focus) requestAnimationFrame(() => document.getElementById(`${uid}-tab-${id}`)?.focus());
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
  const submitCard = async (laneId: number) => {
    const title = draft.trim();
    if (!title) return;
    setAddError(null);
    try {
      const created = await createCard(boardId, { column: column.id, swimlane: laneId, title });
      onCardAdded?.(created);
      setDraft("");
      setAddingLane(null);
    } catch (err) {
      // Same wording as the grid cell: a WIP or weight 409 names the column and the numbers.
      setAddError(limitBlockedMessage(err) ?? "Failed to add card.");
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

      <div className="flex items-start gap-2">
        <div className="flex-1 min-w-0">
          {limit !== null && (
            <div data-testid="phone-column-limit" className="flex flex-col gap-1">
              <span className={`text-xs ${over ? "text-warning-on-tint font-semibold" : "text-fg-secondary"}`}>
                {count} of {limit} limit{over ? " (over)" : ""}
              </span>
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
            </div>
          )}

        </div>
        {isAdmin && (
          <button
            type="button"
            data-testid="phone-column-actions"
            aria-label={`Edit column ${column.name}`}
            onClick={() => setEditingColumn(true)}
            className={`${ACTION_BTN} shrink-0`}
          >
            Edit column
          </button>
        )}
      </div>

      <div role="tabpanel" id={`${uid}-panel`} aria-labelledby={`${uid}-tab-${column.id}`} className="flex flex-col gap-2.5">
        {swimlanes.length === 0 && <p className="text-sm text-fg-secondary">No swimlanes</p>}
        {swimlanes.map((lane) => {
          const laneCards = columnCards.filter((c) => c.swimlane === lane.id).sort((a, b) => a.position - b.position);
          const shown = filteredCardIds ? laneCards.filter((c) => filteredCardIds.has(c.id)) : laneCards;
          const collapsed = collapsedSwimlaneIds.has(lane.id);
          const allLane = cards.filter((c) => c.swimlane === lane.id);
          const statusOf = (c: Card) => cardBoardStatus(c, doneIds.has(c.column));
          const overdue = allLane.filter((c) => statusOf(c) === "overdue").length;
          const stale = allLane.filter((c) => statusOf(c) === "stale").length;
          return (
            <section key={lane.id} aria-label={lane.name} data-testid="phone-lane" className="flex flex-col gap-2">
              <button
                type="button"
                aria-expanded={!collapsed}
                aria-label={`${collapsed ? "Expand" : "Collapse"} lane ${lane.name}, ${laneCards.length} here${overdue > 0 ? `, ${overdue} overdue` : ""}${stale > 0 ? `, ${stale} stale` : ""}`}
                onClick={() => onToggleSwimlane(lane.id)}
                style={columnTintStyle(lane.color)}
                className="flex flex-col gap-1 min-h-11 w-full text-left rounded border border-line bg-surface p-3 focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
              >
                <span className="flex items-center gap-2 w-full">
                  <svg aria-hidden="true" className={`w-4 h-4 shrink-0 text-fg-secondary transition-transform ${collapsed ? "-rotate-90" : ""}`} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M4 6l4 4 4-4" /></svg>
                  <span aria-hidden="true" className="w-2.5 h-2.5 rounded-sm color-dot" style={{ backgroundColor: lane.color }} />
                  <span className="text-[17px] font-semibold text-fg min-w-0 break-words">{lane.name}</span>
                  <span className="ml-auto text-xs font-semibold text-fg whitespace-nowrap">{laneCards.length} here</span>
                </span>
                {(overdue > 0 || stale > 0) && (
                  <span className="flex gap-3 text-xs pl-6">
                    {overdue > 0 && <span className="text-danger-on-tint">{overdue} {STATUS_LABEL.overdue}</span>}
                    {stale > 0 && <span className="text-warning-on-tint">{stale} {STATUS_LABEL.stale}</span>}
                  </span>
                )}
              </button>
              <div className="flex flex-wrap gap-2" data-testid="phone-lane-actions">
                {canAdd && (
                  <button type="button" className={ACTION_BTN} onClick={() => { setAddingLane(lane.id); setDraft(""); setAddError(null); if (collapsed) onToggleSwimlane(lane.id); }}>
                    <span aria-hidden="true" className="mr-1">+</span>Add card<span className="sr-only"> to {column.name} in {lane.name}</span>
                  </button>
                )}
                {isAdmin && (
                  <button type="button" className={ACTION_BTN} aria-label={`Edit swimlane ${lane.name}`} onClick={() => setEditingLane(lane.id)}>Edit</button>
                )}
                {onFocusLane && swimlanes.length > 1 && (
                  <button
                    type="button"
                    className={ACTION_BTN}
                    aria-pressed={focusedSwimlaneId === lane.id}
                    aria-label={focusedSwimlaneId === lane.id ? "Exit focus" : `Focus on ${lane.name}`}
                    onClick={() => (focusedSwimlaneId === lane.id ? onExitFocus?.() : onFocusLane(lane.id))}
                  >
                    {focusedSwimlaneId === lane.id ? "Exit focus" : "Focus"}
                  </button>
                )}
              </div>
              {canAdd && addingLane === lane.id && !collapsed && (
                <div className="flex flex-col gap-2" data-testid="phone-add-card">
                  <input
                    autoFocus
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.nativeEvent.isComposing) { e.preventDefault(); void submitCard(lane.id); }
                      if (e.key === "Escape") { e.stopPropagation(); setAddingLane(null); setAddError(null); }
                    }}
                    aria-label={`New card title in ${column.name}, ${lane.name}`}
                    placeholder="Card title…"
                    className="w-full min-h-11 text-sm border border-primary-emphasis rounded px-3 outline-none bg-surface text-fg placeholder-fg-muted"
                  />
                  <div className="flex gap-2">
                    <button type="button" className="inline-flex items-center justify-center min-h-11 px-4 text-sm rounded font-medium bg-button-primary text-on-primary hover:bg-button-primary-hover focus:outline-none focus:ring-2 focus:ring-primary-emphasis" onClick={() => void submitCard(lane.id)}>Add</button>
                    <button type="button" className={ACTION_BTN} onClick={() => { setAddingLane(null); setAddError(null); }}>Cancel</button>
                  </div>
                  <p className="text-xs min-h-4" role="status" aria-live="polite" aria-atomic="true"><span className="text-danger">{addError}</span></p>
                </div>
              )}
              {!collapsed && (
                <SortableContext items={shown.map((c) => c.id)} strategy={verticalListSortingStrategy}>
                  <div className="flex flex-col gap-1.5">
                    {shown.length === 0 && <p className="text-xs text-fg-tertiary px-1">No cards here</p>}
                    {shown.map((card) => (
                      <CardItem
                        key={card.id}
                        card={card}
                        onClick={() => onCardClick(card)}
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
          onUpdated={(updated) => { onSwimlaneUpdated(updated); setEditingLane(null); }}
          onDeleted={(id) => { onSwimlaneDeleted(id); setEditingLane(null); }}
          onClose={() => setEditingLane(null)}
          swimlaneFieldDefinitions={swimlaneFieldDefinitions}
          userDateFormat={userDateFormat}
        />
      )}
      {isAdmin && editingColumn && onColumnUpdated && onRequestDeleteColumn && (
        <EditColumnModal
          boardId={boardId}
          column={column}
          cardCount={count}
          boardColors={boardColors}
          isIntakeColumn={column.id === intakeColumnId}
          onUpdated={(updated) => { onColumnUpdated(updated); setEditingColumn(false); }}
          onRequestDelete={onRequestDeleteColumn}
          onClose={() => setEditingColumn(false)}
        />
      )}
    </div>
  );
}
