import { useState } from "react";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import type { DragEndEvent, DragStartEvent } from "@dnd-kit/core";
import type { BoardFull, Card, Column, Customer } from "../../types";
import ColumnHeader from "./ColumnHeader";
import SwimlaneRow from "./SwimlaneRow";
import CardItem from "../Card/CardItem";
import CardDetail from "../Card/CardDetail";
import AddColumnModal from "./AddColumnModal";
import AddCustomerModal from "../Customer/AddCustomerModal";

interface Props {
  board: BoardFull;
  onMoveCard: (cardId: number, columnId: number, customerId: number, position: number) => void;
  onCardAdded: (card: Card) => void;
  onCardDeleted: (cardId: number) => void;
  onCardUpdated: (card: Card) => void;
  onColumnAdded: (column: Column) => void;
  onColumnUpdated: (column: Column) => void;
  onCustomerAdded: (customer: Customer) => void;
}

export default function BoardView({ board, onMoveCard, onCardAdded, onCardDeleted, onCardUpdated, onColumnAdded, onColumnUpdated, onCustomerAdded }: Props) {
  const [activeCard, setActiveCard] = useState<Card | null>(null);
  const [selectedCard, setSelectedCard] = useState<Card | null>(null);
  const [showAddColumn, setShowAddColumn] = useState(false);
  const [showAddCustomer, setShowAddCustomer] = useState(false);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  const handleDragStart = (e: DragStartEvent) => {
    const card = board.cards.find((c) => c.id === Number(e.active.id));
    setActiveCard(card ?? null);
  };

  const handleDragEnd = (e: DragEndEvent) => {
    setActiveCard(null);
    const { over, active } = e;
    if (!over) return;

    const [, colId, custId] = String(over.id).split(":");
    const cardId = Number(active.id);
    const card = board.cards.find((c) => c.id === cardId);
    if (!card) return;

    const targetColumnId = Number(colId);
    const targetCustomerId = Number(custId);
    const siblings = board.cards
      .filter((c) => c.column === targetColumnId && c.customer === targetCustomerId && c.id !== cardId)
      .sort((a, b) => a.position - b.position);

    onMoveCard(cardId, targetColumnId, targetCustomerId, siblings.length);
  };

  return (
    <>
      <DndContext sensors={sensors} onDragStart={handleDragStart} onDragEnd={handleDragEnd}>
        {/*
          Single scroll container — header and body share the same horizontal
          scroll so fixed-width columns always line up.
        */}
        <div className="flex-1 overflow-auto">
          {/* Header row — sticky to the top of the scroll container */}
          <div className="flex sticky top-0 z-10 border-b border-gray-200 bg-gray-50">
            {/* Corner — also sticky to the left */}
            <div className="w-[220px] shrink-0 bg-gray-800 flex items-center justify-center sticky left-0 z-20">
              <button
                onClick={() => setShowAddCustomer(true)}
                className="text-xs text-gray-400 hover:text-white transition px-2 py-1 rounded"
              >
                + Customer
              </button>
            </div>

            {board.columns.map((col) => (
              <ColumnHeader
                key={col.id}
                column={col}
                cards={board.cards.filter((c) => c.column === col.id)}
                boardId={board.id}
                onColumnUpdated={onColumnUpdated}
              />
            ))}

            <div className="w-20 shrink-0 flex items-center px-2 bg-gray-50 border-l border-gray-200">
              <button
                onClick={() => setShowAddColumn(true)}
                className="text-xs text-gray-400 hover:text-gray-700 whitespace-nowrap px-2 py-1 rounded hover:bg-gray-100 transition"
              >
                + Col
              </button>
            </div>
          </div>

          {/* Swimlane rows */}
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
            <div className="flex flex-col items-center justify-center h-64 gap-3 text-gray-400">
              <p>No customers yet.</p>
              <button
                onClick={() => setShowAddCustomer(true)}
                className="text-sm bg-blue-600 text-white px-4 py-2 rounded-lg hover:bg-blue-700 transition"
              >
                + Add first customer
              </button>
            </div>
          )}
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
          onUpdated={onCardUpdated}
        />
      )}

      {showAddColumn && (
        <AddColumnModal
          boardId={board.id}
          onAdded={(col) => { onColumnAdded(col); setShowAddColumn(false); }}
          onClose={() => setShowAddColumn(false)}
        />
      )}

      {showAddCustomer && (
        <AddCustomerModal
          boardId={board.id}
          onAdded={(cust) => { onCustomerAdded(cust); setShowAddCustomer(false); }}
          onClose={() => setShowAddCustomer(false)}
        />
      )}
    </>
  );
}
