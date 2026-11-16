import { useState, useId } from "react";
import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";
import type { Card, CardDensity, Column, CustomFieldDefinition, Swimlane } from "../../types";
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
}

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
}: Props) {
  const ordered = [...columns].sort((a, b) => a.position - b.position);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const uid = useId();
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

  return (
    <div data-testid="phone-board" className="flex flex-col gap-2 px-3 pb-4 min-w-0">
      <div
        role="tablist"
        aria-label="Columns"
        data-testid="phone-column-switcher"
        className="flex gap-2 overflow-x-auto py-2 -mx-3 px-3 sticky top-0 z-20 bg-sunken"
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
                  <span aria-hidden="true" className="text-fg-secondary">{collapsed ? "▸" : "▾"}</span>
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
    </div>
  );
}
