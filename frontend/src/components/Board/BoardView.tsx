import { useState } from "react";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import type { DragEndEvent, DragStartEvent } from "@dnd-kit/core";
import type { BoardFull, Card, Column, Customer, Label } from "../../types";
import { userDisplayName } from "../../types";
import ColumnHeader from "./ColumnHeader";
import SwimlaneRow from "./SwimlaneRow";
import CardItem from "../Card/CardItem";
import CardDetail from "../Card/CardDetail";
import AddColumnModal from "./AddColumnModal";
import AddCustomerModal from "../Customer/AddCustomerModal";
import FilterBar, { EMPTY_FILTER, countActiveFilters } from "./FilterBar";
import type { FilterState } from "./FilterBar";

interface Props {
  board: BoardFull;
  onMoveCard: (cardId: number, columnId: number, customerId: number, position: number) => void;
  onCardAdded: (card: Card) => void;
  onCardDeleted: (cardId: number) => void;
  onCardUpdated: (card: Card) => void;
  onColumnAdded: (column: Column) => void;
  onColumnUpdated: (column: Column) => void;
  onCustomerAdded: (customer: Customer) => void;
  onLabelAdded: (label: Label) => void;
}

export default function BoardView({ board, onMoveCard, onCardAdded, onCardDeleted, onCardUpdated, onColumnAdded, onColumnUpdated, onCustomerAdded, onLabelAdded }: Props) {
  const [activeCard, setActiveCard] = useState<Card | null>(null);
  const [selectedCard, setSelectedCard] = useState<Card | null>(null);
  const [showAddColumn, setShowAddColumn] = useState(false);
  const [showAddCustomer, setShowAddCustomer] = useState(false);
  const [collapsedColumns, setCollapsedColumns] = useState<Set<number>>(new Set());
  const [filters, setFilters] = useState<FilterState>(EMPTY_FILTER);

  const filteredCardIds: Set<number> | null = (() => {
    if (countActiveFilters(filters) === 0) return null;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const nextWeek = new Date(today);
    nextWeek.setDate(today.getDate() + 7);
    const matching = board.cards.filter((card) => {
      if (filters.search) {
        const q = filters.search.toLowerCase();
        const matches =
          card.title.toLowerCase().includes(q) ||
          card.description.toLowerCase().includes(q) ||
          (card.assignee && userDisplayName(card.assignee).toLowerCase().includes(q)) ||
          card.labels.some((l) => l.name.toLowerCase().includes(q));
        if (!matches) return false;
      }
      if (filters.assigneeId !== null) {
        if (filters.assigneeId === -1 && card.assignee !== null) return false;
        if (filters.assigneeId !== -1 && card.assignee?.id !== filters.assigneeId) return false;
      }
      if (filters.labelIds.length > 0 && !filters.labelIds.every((id) => card.labels.some((l) => l.id === id))) return false;
      if (filters.priorities.length > 0 && !filters.priorities.includes(card.priority)) return false;
      if (filters.dueDate !== null) {
        if (filters.dueDate === "none" && card.due_date !== null) return false;
        if (filters.dueDate === "overdue") {
          if (!card.due_date || new Date(card.due_date) >= today) return false;
        }
        if (filters.dueDate === "today") {
          if (!card.due_date) return false;
          const d = new Date(card.due_date);
          if (d.getTime() !== today.getTime()) return false;
        }
        if (filters.dueDate === "this_week") {
          if (!card.due_date) return false;
          const d = new Date(card.due_date);
          if (d < today || d >= nextWeek) return false;
        }
      }
      return true;
    });
    return new Set(matching.map((c) => c.id));
  })();

  const toggleColumn = (id: number) => setCollapsedColumns((prev) => {
    const next = new Set(prev);
    next.has(id) ? next.delete(id) : next.add(id);
    return next;
  });

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
      <FilterBar board={board} filters={filters} onChange={setFilters} />
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
                + Swimlane
              </button>
            </div>

            {board.columns.map((col) => (
              <ColumnHeader
                key={col.id}
                column={col}
                cards={board.cards.filter((c) => c.column === col.id)}
                boardId={board.id}
                onColumnUpdated={onColumnUpdated}
                collapsed={collapsedColumns.has(col.id)}
                onToggleCollapse={() => toggleColumn(col.id)}
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
              collapsedColumnIds={collapsedColumns}
              filteredCardIds={filteredCardIds}
              onCardClick={setSelectedCard}
              onCardAdded={onCardAdded}
            />
          ))}

          {board.customers.length === 0 && (
            <div className="flex flex-col items-center justify-center h-64 gap-3 text-gray-400">
              <p>No swimlanes yet.</p>
              <button
                onClick={() => setShowAddCustomer(true)}
                className="text-sm bg-blue-600 text-white px-4 py-2 rounded-lg hover:bg-blue-700 transition"
              >
                + Add first swimlane
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
          onLabelAdded={onLabelAdded}
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
