import { useState } from "react";
import { useDroppable, useDndContext } from "@dnd-kit/core";
import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";
import type { Card, Column, Swimlane } from "../../types";
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
  hideLabels?: boolean;
  hideDueDate?: boolean;
  hideAssignee?: boolean;
  hidePriority?: boolean;
  userTimezone?: string;
  userDateFormat?: string;
}

export default function BoardCell({ column, swimlane, cards, boardId, canEdit, closeEditorOnEnter, filteredCardIds, selectedCardIds, highlightedCardId, onToggleCardSelection, onCardClick, onCardAdded, hideLabels, hideDueDate, hideAssignee, hidePriority, userTimezone, userDateFormat }: Props) {
  const id = `cell:${column.id}:${swimlane.id}`;
  const { setNodeRef, isOver } = useDroppable({ id });
  const { active } = useDndContext();
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState("");

  const handleAdd = async () => {
    if (!title.trim()) return;
    const card = await createCard(boardId, { column: column.id, swimlane: swimlane.id, title: title.trim() });
    onCardAdded(card);
    setTitle("");
    setAdding(false);
  };

  return (
    <div
      ref={setNodeRef}
      onContextMenu={(e) => { if (column.allow_card_creation && canEdit) { e.preventDefault(); setAdding(true); } }}
      className={`flex-1 min-w-[200px] min-h-[80px] p-2 border-r border-slate-700/50 transition-colors ${
        isOver ? "bg-blue-900/20" : ""
      }`}
    >
      <SortableContext items={cards.map((c) => c.id)} strategy={verticalListSortingStrategy}>
        <div className="grid gap-1.5" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(100px, 1fr))" }}>
          {(filteredCardIds ? cards.filter((c) => filteredCardIds.has(c.id)) : cards).map((card) => (
            <CardItem
              key={card.id}
              card={card}
              onClick={() => onCardClick(card)}
              selected={selectedCardIds.has(card.id)}
              highlighted={highlightedCardId === card.id}
              onSelect={canEdit ? () => onToggleCardSelection(card.id) : undefined}
              hideLabels={hideLabels}
              hideDueDate={hideDueDate}
              hideAssignee={hideAssignee}
              hidePriority={hidePriority}
              userTimezone={userTimezone}
              userDateFormat={userDateFormat}
            />
          ))}
        </div>
        {cards.length === 0 && active && (
          <div className={`h-10 rounded border-2 border-dashed transition-colors ${
            isOver ? "border-blue-500 bg-blue-900/20" : "border-slate-700"
          }`} />
        )}
      </SortableContext>

      {column.allow_card_creation && canEdit && (
        adding ? (
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
              className="w-full text-xs border border-blue-500 rounded-md px-2 py-1.5 outline-none bg-slate-800 text-slate-100 placeholder-slate-500"
            />
            <div className="flex gap-1.5 mt-1.5">
              <button onClick={handleAdd} className="text-xs bg-blue-600 text-white px-2.5 py-1 rounded-md hover:bg-blue-700 transition font-medium">Add</button>
              <button onClick={() => setAdding(false)} className="text-xs text-slate-400 hover:text-slate-300 transition">Cancel</button>
            </div>
          </div>
        ) : (
          <button
            onClick={() => setAdding(true)}
            className="mt-1 w-full text-left text-[11px] text-slate-500 hover:text-slate-300 hover:bg-slate-700/50 rounded-md px-1.5 py-1 transition"
          >
            + Add card
          </button>
        )
      )}
    </div>
  );
}
