import { useState } from "react";
import { useDroppable } from "@dnd-kit/core";
import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";
import type { Card, Column, Customer } from "../../types";
import CardItem from "../Card/CardItem";
import { createCard } from "../../api/cards";

interface Props {
  column: Column;
  customer: Customer;
  cards: Card[];
  boardId: number;
  filteredCardIds: Set<number> | null;
  onCardClick: (card: Card) => void;
  onCardAdded: (card: Card) => void;
}

export default function BoardCell({ column, customer, cards, boardId, filteredCardIds, onCardClick, onCardAdded }: Props) {
  const id = `cell:${column.id}:${customer.id}`;
  const { setNodeRef, isOver } = useDroppable({ id });
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState("");

  const handleAdd = async () => {
    if (!title.trim()) return;
    const card = await createCard(boardId, { column: column.id, customer: customer.id, title: title.trim() });
    onCardAdded(card);
    setTitle("");
    setAdding(false);
  };

  return (
    <div
      ref={setNodeRef}
      onContextMenu={(e) => { e.preventDefault(); setAdding(true); }}
      className={`flex-1 min-w-[180px] min-h-[80px] p-2 border-r border-gray-200 transition-colors ${
        isOver ? "bg-blue-50" : ""
      }`}
    >
      <SortableContext items={cards.map((c) => c.id)} strategy={verticalListSortingStrategy}>
        <div className="grid gap-1.5" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(100px, 1fr))" }}>
          {(filteredCardIds ? cards.filter((c) => filteredCardIds.has(c.id)) : cards).map((card) => (
            <CardItem
              key={card.id}
              card={card}
              onClick={() => onCardClick(card)}
            />
          ))}
        </div>
      </SortableContext>

      {adding ? (
        <div className="mt-1.5">
          <input
            autoFocus
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") handleAdd(); if (e.key === "Escape") setAdding(false); }}
            placeholder="Card title..."
            className="w-full text-sm border border-blue-400 rounded px-2 py-1 outline-none"
          />
          <div className="flex gap-1 mt-1">
            <button onClick={handleAdd} className="text-xs bg-blue-600 text-white px-2 py-0.5 rounded hover:bg-blue-700">Add</button>
            <button onClick={() => setAdding(false)} className="text-xs text-gray-500 hover:text-gray-700">Cancel</button>
          </div>
        </div>
      ) : (
        <button
          onClick={() => setAdding(true)}
          className="mt-1 w-full text-left text-xs text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded px-1 py-0.5 transition"
        >
          + Add card
        </button>
      )}
    </div>
  );
}
