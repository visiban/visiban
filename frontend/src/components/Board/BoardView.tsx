import { useState } from "react";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import type { DragEndEvent, DragStartEvent } from "@dnd-kit/core";
import type { BoardFull, Card } from "../../types";
import ColumnHeader from "./ColumnHeader";
import SwimlaneRow from "./SwimlaneRow";
import CardItem from "../Card/CardItem";
import CardDetail from "../Card/CardDetail";

interface Props {
  board: BoardFull;
  onMoveCard: (cardId: number, columnId: number, customerId: number, position: number) => void;
  onCardAdded: (card: Card) => void;
  onCardDeleted: (cardId: number) => void;
}

export default function BoardView({ board, onMoveCard, onCardAdded, onCardDeleted }: Props) {
  const [activeCard, setActiveCard] = useState<Card | null>(null);
  const [selectedCard, setSelectedCard] = useState<Card | null>(null);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  const handleDragStart = (e: DragStartEvent) => {
    const card = board.cards.find((c) => c.id === Number(e.active.id));
    setActiveCard(card ?? null);
  };

  const handleDragEnd = (e: DragEndEvent) => {
    setActiveCard(null);
    const { over, active } = e;
    if (!over) return;

    // Droppable IDs are "cell:{columnId}:{customerId}"
    const [, colId, custId] = String(over.id).split(":");
    const cardId = Number(active.id);
    const card = board.cards.find((c) => c.id === cardId);
    if (!card) return;

    const targetColumnId = Number(colId);
    const targetCustomerId = Number(custId);

    const siblings = board.cards
      .filter((c) => c.column === targetColumnId && c.customer === targetCustomerId && c.id !== cardId)
      .sort((a, b) => a.position - b.position);

    const position = siblings.length;
    onMoveCard(cardId, targetColumnId, targetCustomerId, position);
  };

  return (
    <>
      <DndContext sensors={sensors} onDragStart={handleDragStart} onDragEnd={handleDragEnd}>
        <div className="flex flex-col h-full overflow-hidden">
          {/* Column headers */}
          <div
            className="flex sticky top-0 z-10 bg-gray-50 border-b border-gray-200"
            style={{ gridTemplateColumns: `220px repeat(${board.columns.length}, minmax(200px, 1fr))` }}
          >
            <div className="w-[220px] shrink-0 bg-gray-800" />
            {board.columns.map((col) => (
              <ColumnHeader
                key={col.id}
                column={col}
                cardCount={board.cards.filter((c) => c.column === col.id).length}
              />
            ))}
          </div>

          {/* Swimlane rows */}
          <div className="overflow-y-auto flex-1">
            {board.customers.map((customer) => (
              <SwimlaneRow
                key={customer.id}
                customer={customer}
                columns={board.columns}
                cards={board.cards.filter((c) => c.customer === customer.id)}
                boardId={board.id}
                onCardClick={setSelectedCard}
                onCardAdded={onCardAdded}
              />
            ))}
            {board.customers.length === 0 && (
              <div className="flex items-center justify-center h-64 text-gray-400">
                No customers yet. Add a customer to get started.
              </div>
            )}
          </div>
        </div>

        <DragOverlay>
          {activeCard && <CardItem card={activeCard} overlay />}
        </DragOverlay>
      </DndContext>

      {selectedCard && (
        <CardDetail
          card={selectedCard}
          board={board}
          onClose={() => setSelectedCard(null)}
          onDeleted={(id) => { onCardDeleted(id); setSelectedCard(null); }}
        />
      )}
    </>
  );
}
