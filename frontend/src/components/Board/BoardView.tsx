import { useState, useCallback } from "react";
import SummaryView from "./SummaryView";
import AnalyticsView from "./AnalyticsView";
import { useBoardSocket } from "../../hooks/useBoardSocket";
import type { BoardEvent } from "../../hooks/useBoardSocket";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import type { DragEndEvent, DragStartEvent } from "@dnd-kit/core";
import { SortableContext, horizontalListSortingStrategy, arrayMove } from "@dnd-kit/sortable";
import type { BoardFull, Card, Column, Swimlane, Label } from "../../types";
import { userDisplayName } from "../../types";
import ColumnHeader from "./ColumnHeader";
import SwimlaneRow from "./SwimlaneRow";
import CardItem from "../Card/CardItem";
import CardDetail from "../Card/CardDetail";
import AddColumnModal from "./AddColumnModal";
import AddSwimlaneModal from "../Swimlane/AddSwimlaneModal";
import FilterBar, { EMPTY_FILTER, countActiveFilters } from "./FilterBar";
import type { FilterState } from "./FilterBar";

interface Props {
  board: BoardFull;
  onMoveCard: (cardId: number, columnId: number, swimlaneId: number, position: number) => void;
  onCardAdded: (card: Card) => void;
  onCardDeleted: (cardId: number) => void;
  onCardUpdated: (card: Card) => void;
  onColumnAdded: (column: Column) => void;
  onColumnUpdated: (column: Column) => void;
  onColumnDeleted: (columnId: number) => void;
  onColumnsReordered: (orderedIds: number[]) => void;
  onSwimlaneAdded: (swimlane: Swimlane) => void;
  onSwimlaneUpdated: (swimlane: Swimlane) => void;
  onSwimlaneDeleted: (swimlaneId: number) => void;
  onLabelAdded: (label: Label) => void;
}

function ViewToggle({
  view,
  onChange,
}: {
  view: "board" | "summary" | "analytics";
  onChange: (v: "board" | "summary" | "analytics") => void;
}) {
  const btn = (label: string, val: "board" | "summary" | "analytics") => (
    <button
      onClick={() => onChange(val)}
      className={`text-xs px-2.5 py-1 rounded transition ${
        view === val
          ? "bg-blue-600 text-white"
          : "text-gray-500 hover:text-gray-800 hover:bg-gray-100"
      }`}
    >
      {label}
    </button>
  );
  return (
    <div className="flex items-center gap-0.5 bg-gray-100 rounded p-0.5">
      {btn("Board", "board")}
      {btn("Summary", "summary")}
      {btn("Analytics", "analytics")}
    </div>
  );
}

export default function BoardView({ board, onMoveCard, onCardAdded, onCardDeleted, onCardUpdated, onColumnAdded, onColumnUpdated, onColumnDeleted, onColumnsReordered, onSwimlaneAdded, onSwimlaneUpdated, onSwimlaneDeleted, onLabelAdded }: Props) {
  const isAdmin = board.current_user_role === "admin" || board.current_user_role === "site_admin";
  const canEdit = isAdmin || board.current_user_role === "member";
  const canComment = canEdit || board.current_user_role === "collaborator";

  const handleSocketEvent = useCallback((event: BoardEvent) => {
    if (event.type === "card.moved" || event.type === "card.updated" || event.type === "card.created") {
      onCardUpdated(event as unknown as Card);
    } else if (event.type === "card.deleted") {
      onCardDeleted(event.card_id as number);
    }
  }, [onCardUpdated, onCardDeleted]);

  const { connected } = useBoardSocket(board.id, handleSocketEvent);

  const [activeCard, setActiveCard] = useState<Card | null>(null);
  const [activeColumn, setActiveColumn] = useState<Column | null>(null);
  const [selectedCard, setSelectedCard] = useState<Card | null>(null);
  const [showAddColumn, setShowAddColumn] = useState(false);
  const [showAddSwimlane, setShowAddSwimlane] = useState(false);
  const [collapsedColumns, setCollapsedColumns] = useState<Set<number>>(new Set());
  const [filters, setFilters] = useState<FilterState>(EMPTY_FILTER);
  const [showFilters, setShowFilters] = useState(false);
  const [view, setView] = useState<"board" | "summary" | "analytics">("board");

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
    const id = String(e.active.id);
    if (id.startsWith("col:")) {
      setActiveColumn(board.columns.find((c) => c.id === Number(id.slice(4))) ?? null);
    } else {
      setActiveCard(board.cards.find((c) => c.id === Number(id)) ?? null);
    }
  };

  const handleDragEnd = (e: DragEndEvent) => {
    const { over, active } = e;
    const activeId = String(active.id);

    if (activeId.startsWith("col:")) {
      setActiveColumn(null);
      if (!over) return;
      let overId = String(over.id);
      // Cells cover a larger area than column headers, so closestCenter may
      // resolve to "cell:{colId}:{swimlaneId}" — map back to the column id.
      if (overId.startsWith("cell:")) {
        overId = `col:${overId.split(":")[1]}`;
      }
      if (activeId === overId) return;
      const oldIndex = board.columns.findIndex((c) => `col:${c.id}` === activeId);
      const newIndex = board.columns.findIndex((c) => `col:${c.id}` === overId);
      if (oldIndex === -1 || newIndex === -1) return;
      const reordered = arrayMove(board.columns, oldIndex, newIndex);
      onColumnsReordered(reordered.map((c) => c.id));
      return;
    }

    setActiveCard(null);
    if (!over) return;
    const [, colId, swimId] = String(over.id).split(":");
    const cardId = Number(activeId);
    const card = board.cards.find((c) => c.id === cardId);
    if (!card) return;

    const targetColumnId = Number(colId);
    const targetSwimlaneId = Number(swimId);
    const siblings = board.cards
      .filter((c) => c.column === targetColumnId && c.swimlane === targetSwimlaneId && c.id !== cardId)
      .sort((a, b) => a.position - b.position);

    onMoveCard(cardId, targetColumnId, targetSwimlaneId, siblings.length);
  };

  const activeCount = countActiveFilters(filters);

  if (view === "summary") {
    return (
      <>
        <div className="flex items-center gap-2 px-3 py-1.5 bg-white border-b border-gray-200 shrink-0">
          <ViewToggle view={view} onChange={setView} />
        </div>
        <SummaryView boardId={board.id} columns={board.columns.map((c) => c.name)} />
      </>
    );
  }

  if (view === "analytics") {
    return (
      <>
        <div className="flex items-center gap-2 px-3 py-1.5 bg-white border-b border-gray-200 shrink-0">
          <ViewToggle view={view} onChange={setView} />
        </div>
        <AnalyticsView boardId={board.id} />
      </>
    );
  }

  return (
    <>
      <div className="flex items-center gap-2 px-3 py-1.5 bg-white border-b border-gray-200 shrink-0">
<<<<<<< HEAD
        <ViewToggle view={view} onChange={setView} />
        <span className="w-px h-4 bg-gray-200 mx-1" />
        <span
          className={`flex items-center gap-1 text-xs font-medium ${connected ? "text-green-500" : "text-gray-400"}`}
          title={connected ? "Live — real-time updates active" : "Connecting…"}
        >
          <span className={`w-1.5 h-1.5 rounded-full ${connected ? "bg-green-500" : "bg-gray-300"}`} />
          {connected ? "Live" : "Connecting…"}
        </span>
        <span className="w-px h-4 bg-gray-200" />
        <button
          onClick={() => setShowFilters((v) => !v)}
          className="text-xs text-blue-600 hover:text-blue-800 transition"
        >
          {showFilters ? "Hide filters" : "Filters"}
          {!showFilters && activeCount > 0 && (
            <span className="ml-1.5 bg-blue-100 text-blue-700 rounded-full px-1.5 py-0.5 font-medium">
              {activeCount} active
            </span>
          )}
        </button>
        {!showFilters && activeCount > 0 && (
          <button
            onClick={() => setFilters(EMPTY_FILTER)}
            className="text-xs text-gray-400 hover:text-gray-600 underline"
          >
            Clear
          </button>
        )}
      </div>
      {showFilters && <FilterBar board={board} filters={filters} onChange={setFilters} />}
      <DndContext sensors={sensors} onDragStart={handleDragStart} onDragEnd={handleDragEnd} collisionDetection={closestCenter}>
        {/*
          Single scroll container — header and body share the same horizontal
          scroll so fixed-width columns always line up.
        */}
        <div className="flex-1 overflow-auto">
          {/* Header row — sticky to the top of the scroll container */}
          <div className="flex sticky top-0 z-10 border-b border-gray-200 bg-gray-50">
            {/* Corner — also sticky to the left */}
            <div className="w-[220px] shrink-0 bg-gray-800 flex items-center justify-center sticky left-0 z-20">
              {isAdmin && (
                <button
                  onClick={() => setShowAddSwimlane(true)}
                  className="text-xs text-gray-400 hover:text-white transition px-2 py-1 rounded"
                >
                  + Swimlane
                </button>
              )}
            </div>

            <SortableContext items={board.columns.map((c) => `col:${c.id}`)} strategy={horizontalListSortingStrategy}>
              {board.columns.map((col) => (
                <ColumnHeader
                  key={col.id}
                  column={col}
                  cards={board.cards.filter((c) => c.column === col.id)}
                  boardId={board.id}
                  isAdmin={isAdmin}
                  onColumnUpdated={onColumnUpdated}
                  onColumnDeleted={onColumnDeleted}
                  collapsed={collapsedColumns.has(col.id)}
                  onToggleCollapse={() => toggleColumn(col.id)}
                />
              ))}
            </SortableContext>

            <div className="w-20 shrink-0 flex items-center px-2 bg-gray-50 border-l border-gray-200">
              {isAdmin && (
                <button
                  onClick={() => setShowAddColumn(true)}
                  className="text-xs text-gray-400 hover:text-gray-700 whitespace-nowrap px-2 py-1 rounded hover:bg-gray-100 transition"
                >
                  + Col
                </button>
              )}
            </div>
          </div>

          {/* Swimlane rows */}
          {board.swimlanes.map((swimlane) => (
            <SwimlaneRow
              key={swimlane.id}
              swimlane={swimlane}
              columns={board.columns}
              cards={board.cards.filter((c) => c.swimlane === swimlane.id)}
              boardId={board.id}
              isAdmin={isAdmin}
              canEdit={canEdit}
              collapsedColumnIds={collapsedColumns}
              filteredCardIds={filteredCardIds}
              onCardClick={setSelectedCard}
              onCardAdded={onCardAdded}
              onSwimlaneUpdated={onSwimlaneUpdated}
              onSwimlaneDeleted={onSwimlaneDeleted}
            />
          ))}

          {board.swimlanes.length === 0 && (
            <div className="flex flex-col items-center justify-center h-64 gap-3 text-gray-400">
              <p>No swimlanes yet.</p>
              {isAdmin && (
                <button
                  onClick={() => setShowAddSwimlane(true)}
                  className="text-sm bg-blue-600 text-white px-4 py-2 rounded-lg hover:bg-blue-700 transition"
                >
                  + Add first swimlane
                </button>
              )}
            </div>
          )}
        </div>

        <DragOverlay>
          {activeCard && <CardItem card={activeCard} overlay />}
          {activeColumn && (
            <div className="flex-1 min-w-[180px] px-3 py-3 border border-blue-400 bg-blue-50 rounded shadow-xl opacity-90">
              <div className="flex items-center gap-2">
                <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: activeColumn.color }} />
                <span className="font-semibold text-gray-700 text-sm">{activeColumn.name}</span>
              </div>
            </div>
          )}
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

      {isAdmin && showAddColumn && (
        <AddColumnModal
          boardId={board.id}
          onAdded={(col) => { onColumnAdded(col); setShowAddColumn(false); }}
          onClose={() => setShowAddColumn(false)}
        />
      )}

      {isAdmin && showAddSwimlane && (
        <AddSwimlaneModal
          boardId={board.id}
          onAdded={(swimlane) => { onSwimlaneAdded(swimlane); setShowAddSwimlane(false); }}
          onClose={() => setShowAddSwimlane(false)}
        />
      )}
    </>
  );
}
