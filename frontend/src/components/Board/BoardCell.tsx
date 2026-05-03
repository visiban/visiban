import { useState, memo } from "react";
import { useDroppable, useDndContext } from "@dnd-kit/core";
import { SortableContext, verticalListSortingStrategy, rectSortingStrategy } from "@dnd-kit/sortable";
import type { Card, CardDensity, Column, Swimlane } from "../../types";
import CardItem from "../Card/CardItem";
import { createCard } from "../../api/cards";

interface Props {
  column: Column;
  swimlane: Swimlane;
  cards: Card[];
  boardId: number;
  canEdit: boolean;
  closeEditorOnEnter: boolean;
  filteredCardIds: Set<number> | null;
  selectedCardIds: Set<number>;
  highlightedCardId?: number | null;
  onToggleCardSelection: (cardId: number) => void;
  onCardClick: (card: Card) => void;
  onCardAdded: (card: Card) => void;
  density?: CardDensity;
  userTimezone?: string;
  userDateFormat?: string;
  width?: number;
  compact?: boolean;
  staleness_threshold_days?: number;
  stale_warning_pct?: number;
}

const BoardCell = memo(function BoardCell({ column, swimlane, cards, boardId, canEdit, closeEditorOnEnter, filteredCardIds, selectedCardIds, highlightedCardId, onToggleCardSelection, onCardClick, onCardAdded, density, userTimezone, userDateFormat, width, compact, staleness_threshold_days, stale_warning_pct }: Props) {
  const id = `cell:${column.id}:${swimlane.id}`;
  const { setNodeRef, isOver } = useDroppable({ id });
  const { active } = useDndContext();
  const isDraggingCard = active != null && !String(active.id).startsWith("swim:") && !String(active.id).startsWith("col:");
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState("");
  const [addError, setAddError] = useState<string | null>(null);

  const handleAdd = async () => {
    if (!title.trim()) return;
    setAddError(null);
    try {
      const card = await createCard(boardId, { column: column.id, swimlane: swimlane.id, title: title.trim() });
      onCardAdded(card);
      setTitle("");
      setAdding(false);
    } catch {
      setAddError("Failed to add card.");
    }
  };

  // The cell becomes the keyboard-reachable creation surface when it has nothing
  // in it (#962). Tab → empty cell → Enter / Space opens the new-card input. The
  // dashed border + centered "+ Add card" overlay gives Sam a discoverable click
  // target on day one. Populated cells fall back to the dense layout with the
  // unobtrusive bottom-aligned button.
  const isEmptyAddable = cards.length === 0 && !adding && column.allow_card_creation && canEdit;
  const startAdding = () => setAdding(true);

  return (
    <div
      ref={setNodeRef}
      role={isEmptyAddable ? "button" : undefined}
      tabIndex={isEmptyAddable ? 0 : undefined}
      aria-label={isEmptyAddable ? `Add card to ${column.name} in ${swimlane.name}` : undefined}
      onClick={isEmptyAddable ? startAdding : undefined}
      onKeyDown={isEmptyAddable ? (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          startAdding();
        }
      } : undefined}
      // Double-click and right-click open the new-card input on any cell — empty
      // or populated. They're the long-standing power-user shortcuts; the cell-
      // as-button (#962) only adds the *empty-cell* keyboard path on top.
      onDoubleClick={() => { if (column.allow_card_creation && canEdit) setAdding(true); }}
      onContextMenu={(e) => { if (column.allow_card_creation && canEdit) { e.preventDefault(); setAdding(true); } }}
      style={{ width: width ?? 220 }}
      className={`group/cell relative shrink-0 min-h-[80px] p-2 transition-colors bg-canvas ${
        isOver && isDraggingCard ? "bg-surface-hover/40" : ""
      } ${cards.length === 0 && !adding ? "border border-dashed border-line/50" : "border-r border-line/50"} ${
        isEmptyAddable ? "cursor-pointer hover:bg-surface-hover/30 focus:outline-none focus:ring-2 focus:ring-inset focus:ring-primary-emphasis" : ""
      }`}
    >
      {cards.length >= 2 && (
        <span className="absolute top-1.5 right-2 text-xs font-medium text-fg-faint select-none pointer-events-none">
          {cards.length}
        </span>
      )}
      <SortableContext items={cards.map((c) => c.id)} strategy={compact ? rectSortingStrategy : verticalListSortingStrategy}>
        <div className={compact ? "grid grid-cols-2 gap-1.5" : "flex flex-col gap-1.5"}>
          {(filteredCardIds ? cards.filter((c) => filteredCardIds.has(c.id)) : cards).map((card) => (
            <CardItem
              key={card.id}
              card={card}
              onClick={() => onCardClick(card)}
              selected={selectedCardIds.has(card.id)}
              highlighted={highlightedCardId === card.id}
              onSelect={canEdit ? () => onToggleCardSelection(card.id) : undefined}
              density={density}
              userTimezone={userTimezone}
              userDateFormat={userDateFormat}
              compact={compact}
              staleness_threshold_days={staleness_threshold_days}
              stale_warning_pct={stale_warning_pct}
            />
          ))}
        </div>
        {cards.length === 0 && active && (
          <div className={`h-10 rounded border-2 border-dashed transition-colors ${
            isOver ? "border-primary-emphasis bg-info/20" : "border-line"
          }`} />
        )}
      </SortableContext>

      {column.allow_card_creation && canEdit && adding && (
        <div className="mt-1.5">
          <input
            autoFocus
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                if (closeEditorOnEnter) { e.preventDefault(); handleAdd(); }
                // else: fall through so the browser inserts a newline (default textarea behavior)
              }
              if (e.key === "Escape") setAdding(false);
            }}
            placeholder="Card title…"
            className="w-full text-xs border border-primary-emphasis rounded px-2 py-1.5 outline-none bg-surface text-fg placeholder-fg-muted"
          />
          <div className="flex gap-1.5 mt-1.5">
            <button onClick={handleAdd} className="text-xs bg-button-primary text-on-primary px-2.5 py-1 rounded hover:bg-button-primary-hover transition font-medium focus:outline-none focus:ring-2 focus:ring-primary-emphasis">Add</button>
            <button onClick={() => { setAdding(false); setAddError(null); }} className="text-xs text-fg-tertiary hover:text-fg-secondary transition rounded focus:outline-none focus:ring-2 focus:ring-primary-emphasis">Cancel</button>
          </div>
          <p className="text-xs h-4"><span className="text-danger">{addError}</span></p>
        </div>
      )}

      {/* Empty-cell centered affordance — overlay-positioned and decorative; the
          cell wrapper itself is the focusable role="button" surface. Hidden during
          a card drag so the drop indicator owns the visual frame. */}
      {isEmptyAddable && !active && (
        <div
          className="absolute inset-0 flex items-center justify-center pointer-events-none text-xs text-fg-muted group-hover/cell:text-fg group-focus/cell:text-fg transition"
          aria-hidden="true"
        >
          + Add card
        </div>
      )}

      {/* Populated-cell affordance — bottom-aligned, low-key. Stays as a separate
          button so a focused card stack can Tab into "+ Add card" without the
          whole cell intercepting Enter. */}
      {column.allow_card_creation && canEdit && !adding && cards.length > 0 && (
        <button
          onClick={() => setAdding(true)}
          className="w-full text-left text-xs rounded px-1.5 py-1 transition mt-1 text-fg-faint hover:text-fg-secondary hover:bg-surface-hover/50 focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
        >
          + Add card
        </button>
      )}
    </div>
  );
});

export default BoardCell;
