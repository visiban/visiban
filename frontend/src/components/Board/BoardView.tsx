import { useState, useCallback, useEffect, useRef } from "react";
import { useSearchParams } from "react-router-dom";
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
  useDroppable,
} from "@dnd-kit/core";
import type { DragEndEvent, DragStartEvent } from "@dnd-kit/core";
import { SortableContext, horizontalListSortingStrategy, verticalListSortingStrategy, arrayMove } from "@dnd-kit/sortable";
import type { BoardFull, Card, Column, Swimlane, Label } from "../../types";
import { userDisplayName } from "../../types";
import ColumnHeader from "./ColumnHeader";
import SwimlaneRow from "./SwimlaneRow";
import CardItem from "../Card/CardItem";
import CardDetail from "../Card/CardDetail";
import AddColumnModal from "./AddColumnModal";
import AddSwimlaneModal from "../Swimlane/AddSwimlaneModal";
import BoardSettingsModal from "./BoardSettingsModal";
import FilterBar, { EMPTY_FILTER, countActiveFilters } from "./FilterBar";
import type { FilterState } from "./FilterBar";
import KeyboardShortcutsOverlay from "./KeyboardShortcutsOverlay";
import BulkActionToolbar from "./BulkActionToolbar";
import { useViewPrefs } from "../../hooks/useViewPrefs";
import { todayInTimezone } from "../../utils/date";

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
  onSwimlanesReordered: (orderedIds: number[]) => void;
  onLabelAdded: (label: Label) => void;
  onBoardSettingsChanged?: (patch: Record<string, unknown>) => Promise<void>;
  userTimezone?: string;
}

function ColumnTrashZone() {
  const { setNodeRef, isOver } = useDroppable({ id: "trash:column" });
  return (
    <div
      ref={setNodeRef}
      className={`w-20 shrink-0 flex items-center justify-center px-2 border-l transition-colors ${
        isOver
          ? "bg-red-900/50 border-red-700"
          : "bg-red-950/30 border-slate-700"
      }`}
    >
      <span className={`text-xs font-medium whitespace-nowrap ${isOver ? "text-red-700" : "text-red-400"}`}>
        <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4 mx-auto mb-0.5" viewBox="0 0 20 20" fill="currentColor">
          <path fillRule="evenodd" d="M9 2a1 1 0 00-.894.553L7.382 4H4a1 1 0 000 2v10a2 2 0 002 2h8a2 2 0 002-2V6a1 1 0 100-2h-3.382l-.724-1.447A1 1 0 0011 2H9zM7 8a1 1 0 012 0v6a1 1 0 11-2 0V8zm5-1a1 1 0 00-1 1v6a1 1 0 102 0V8a1 1 0 00-1-1z" clipRule="evenodd" />
        </svg>
        Delete
      </span>
    </div>
  );
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
          : "text-slate-400 hover:text-white hover:bg-slate-600"
      }`}
    >
      {label}
    </button>
  );
  return (
    <div className="flex items-center gap-0.5 bg-slate-700 rounded p-0.5">
      {btn("Board", "board")}
      {btn("Summary", "summary")}
      {btn("Analytics", "analytics")}
    </div>
  );
}

export default function BoardView({ board, onMoveCard, onCardAdded, onCardDeleted, onCardUpdated, onColumnAdded, onColumnUpdated, onColumnDeleted, onColumnsReordered, onSwimlaneAdded, onSwimlaneUpdated, onSwimlaneDeleted, onSwimlanesReordered, onLabelAdded, onBoardSettingsChanged, userTimezone = "" }: Props) {
  const isAdmin = board.current_user_role === "admin" || board.current_user_role === "site_admin";
  const canEdit = isAdmin || board.current_user_role === "member";

  const { prefs: viewPrefs, toggleHiddenColumn, toggleHiddenSwimlane, setCardFieldPref } = useViewPrefs(board.id);
  const hiddenColumnIds = new Set(viewPrefs.hiddenColumnIds);
  const hiddenSwimlaneIds = new Set(viewPrefs.hiddenSwimlaneIds);

  const handleSocketEvent = useCallback((event: BoardEvent) => {
    if (event.type === "card.created") {
      onCardAdded(event as unknown as Card);
    } else if (event.type === "card.moved" || event.type === "card.updated") {
      onCardUpdated(event as unknown as Card);
    } else if (event.type === "card.deleted") {
      onCardDeleted(event.card_id as number);
    } else if (event.type === "column.created") {
      onColumnAdded(event as unknown as Column);
    } else if (event.type === "column.updated") {
      onColumnUpdated(event as unknown as Column);
    } else if (event.type === "column.deleted") {
      onColumnDeleted(event.column_id as number);
    } else if (event.type === "swimlane.created") {
      onSwimlaneAdded(event as unknown as Swimlane);
    } else if (event.type === "swimlane.updated") {
      onSwimlaneUpdated(event as unknown as Swimlane);
    } else if (event.type === "swimlane.deleted") {
      onSwimlaneDeleted(event.swimlane_id as number);
    }
  }, [onCardAdded, onCardUpdated, onCardDeleted, onColumnAdded, onColumnUpdated, onColumnDeleted, onSwimlaneAdded, onSwimlaneUpdated, onSwimlaneDeleted]);

  const { connected } = useBoardSocket(board.id, handleSocketEvent);

  const [searchParams, setSearchParams] = useSearchParams();
  const [activeCard, setActiveCard] = useState<Card | null>(null);
  const [activeColumn, setActiveColumn] = useState<Column | null>(null);
  const [activeSwimlane, setActiveSwimlane] = useState<Swimlane | null>(null);
  const [selectedCard, setSelectedCard] = useState<Card | null>(null);
  const [highlightedCardId, setHighlightedCardId] = useState<number | null>(null);
  const [cardNotFound, setCardNotFound] = useState(false);

  // Auto-open card from ?card= query param (e.g. from notification deep-link)
  useEffect(() => {
    const cardId = Number(searchParams.get("card"));
    if (!cardId) return;
    const card = board.cards.find((c) => c.id === cardId);
    if (card) {
      setSelectedCard(card);
      setHighlightedCardId(cardId);
      setTimeout(() => setHighlightedCardId(null), 1500);
      setSearchParams((prev) => { prev.delete("card"); return prev; }, { replace: true });
    } else {
      setCardNotFound(true);
      setSearchParams((prev) => { prev.delete("card"); return prev; }, { replace: true });
      setTimeout(() => setCardNotFound(false), 4000);
    }
  }, [board.cards, searchParams, setSearchParams]);
  const [showAddColumn, setShowAddColumn] = useState(false);
  // When non-null, new column is inserted at this index (0 = first)
  const [insertPosition, setInsertPosition] = useState<number | null>(null);
  const [showAddSwimlane, setShowAddSwimlane] = useState(false);
  // When non-null, new swimlane is inserted at this index (0 = first)
  const [insertSwimlanePosition, setInsertSwimlanePosition] = useState<number | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [collapsedColumns, setCollapsedColumns] = useState<Set<number>>(new Set());
  const [filters, setFilters] = useState<FilterState>(EMPTY_FILTER);
  const [showFilters, setShowFilters] = useState(false);
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [confirmDeleteColumn, setConfirmDeleteColumn] = useState<Column | null>(null);
  const [view, setView] = useState<"board" | "summary" | "analytics">("board");
  const [selectedCardIds, setSelectedCardIds] = useState<Set<number>>(new Set());
  const searchRef = useRef<HTMLInputElement>(null);

  const toggleCardSelection = useCallback((cardId: number) => {
    setSelectedCardIds((prev) => {
      const next = new Set(prev);
      if (next.has(cardId)) next.delete(cardId);
      else next.add(cardId);
      return next;
    });
  }, []);

  const clearSelection = useCallback(() => setSelectedCardIds(new Set()), []);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if (e.key === "Escape") {
        if (selectedCardIds.size > 0) { clearSelection(); return; }
      } else if (e.key === "f") {
        e.preventDefault();
        setShowFilters((v) => !v);
      } else if (e.key === "/") {
        e.preventDefault();
        setShowFilters(true);
        setTimeout(() => searchRef.current?.focus(), 0);
      } else if (e.key === "?") {
        e.preventDefault();
        setShowShortcuts((v) => !v);
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [selectedCardIds, clearSelection]);

  // Prune selection when cards are removed (e.g. by another user via WebSocket)
  useEffect(() => {
    const cardIds = new Set(board.cards.map((c) => c.id));
    setSelectedCardIds((prev) => {
      const pruned = new Set([...prev].filter((id) => cardIds.has(id)));
      return pruned.size === prev.size ? prev : pruned;
    });
  }, [board.cards]);

  const filteredCardIds: Set<number> | null = (() => {
    if (countActiveFilters(filters) === 0) return null;
    // Use the user's stored timezone so that "Today" / "Overdue" boundaries
    // are computed at midnight in their local time, not the browser's locale.
    const todayStr = todayInTimezone(userTimezone);
    const nextWeekMs = new Date(todayStr + "T00:00:00Z").getTime() + 7 * 86_400_000;
    const nw = new Date(nextWeekMs);
    const pad = (n: number) => String(n).padStart(2, "0");
    const nextWeekStr = `${nw.getUTCFullYear()}-${pad(nw.getUTCMonth() + 1)}-${pad(nw.getUTCDate())}`;
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
          if (!card.due_date || card.due_date >= todayStr) return false;
        }
        if (filters.dueDate === "today") {
          if (card.due_date !== todayStr) return false;
        }
        if (filters.dueDate === "this_week") {
          if (!card.due_date || card.due_date < todayStr || card.due_date >= nextWeekStr) return false;
        }
      }
      return true;
    });
    return new Set(matching.map((c) => c.id));
  })();

  const handleColumnAdded = useCallback((col: Column) => {
    onColumnAdded(col);
    if (insertPosition !== null) {
      const currentIds = board.columns.map((c) => c.id);
      const newOrder = [
        ...currentIds.slice(0, insertPosition),
        col.id,
        ...currentIds.slice(insertPosition),
      ];
      onColumnsReordered(newOrder);
    }
  }, [board.columns, insertPosition, onColumnAdded, onColumnsReordered]);

  const handleSwimlaneAdded = useCallback((swimlane: Swimlane) => {
    onSwimlaneAdded(swimlane);
    if (insertSwimlanePosition !== null) {
      const currentIds = board.swimlanes.map((s) => s.id);
      const newOrder = [
        ...currentIds.slice(0, insertSwimlanePosition),
        swimlane.id,
        ...currentIds.slice(insertSwimlanePosition),
      ];
      onSwimlanesReordered(newOrder);
    }
  }, [board.swimlanes, insertSwimlanePosition, onSwimlaneAdded, onSwimlanesReordered]);

  const toggleColumn = (id: number) => setCollapsedColumns((prev) => {
    const next = new Set(prev);
    if (next.has(id)) { next.delete(id); } else { next.add(id); }
    return next;
  });

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  const handleDragStart = (e: DragStartEvent) => {
    clearSelection();
    const id = String(e.active.id);
    if (id.startsWith("col:")) {
      setActiveColumn(board.columns.find((c) => c.id === Number(id.slice(4))) ?? null);
    } else if (id.startsWith("swim:")) {
      setActiveSwimlane(board.swimlanes.find((s) => s.id === Number(id.slice(5))) ?? null);
    } else {
      setActiveCard(board.cards.find((c) => c.id === Number(id)) ?? null);
    }
  };

  const handleDragEnd = (e: DragEndEvent) => {
    const { over, active } = e;
    const activeId = String(active.id);

    if (activeId.startsWith("col:")) {
      const draggedColumn = activeColumn;
      setActiveColumn(null);
      if (!over) return;
      const overId = String(over.id);

      // Dropped on trash zone — confirm before deleting
      if (overId === "trash:column" && draggedColumn) {
        setConfirmDeleteColumn(draggedColumn);
        return;
      }

      // Cells cover a larger area than column headers, so closestCenter may
      // resolve to "cell:{colId}:{swimlaneId}" — map back to the column id.
      let mappedOverId = overId;
      if (mappedOverId.startsWith("cell:")) {
        mappedOverId = `col:${mappedOverId.split(":")[1]}`;
      }
      if (activeId === mappedOverId) return;
      const oldIndex = board.columns.findIndex((c) => `col:${c.id}` === activeId);
      const newIndex = board.columns.findIndex((c) => `col:${c.id}` === mappedOverId);
      if (oldIndex === -1 || newIndex === -1) return;
      const reordered = arrayMove(board.columns, oldIndex, newIndex);
      onColumnsReordered(reordered.map((c) => c.id));
      return;
    }

    if (activeId.startsWith("swim:")) {
      setActiveSwimlane(null);
      if (!over) return;
      const overId = String(over.id);
      if (!overId.startsWith("swim:")) return;
      if (activeId === overId) return;
      const oldIndex = board.swimlanes.findIndex((s) => `swim:${s.id}` === activeId);
      const newIndex = board.swimlanes.findIndex((s) => `swim:${s.id}` === overId);
      if (oldIndex === -1 || newIndex === -1) return;
      const reordered = arrayMove(board.swimlanes, oldIndex, newIndex);
      onSwimlanesReordered(reordered.map((s) => s.id));
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
        <div className="flex items-center gap-2 px-3 py-1.5 bg-slate-800 border-b border-slate-700 shrink-0">
          <ViewToggle view={view} onChange={setView} />
        </div>
        <SummaryView boardId={board.id} columns={board.columns.map((c) => c.name)} />
      </>
    );
  }

  if (view === "analytics") {
    return (
      <>
        <div className="flex items-center gap-2 px-3 py-1.5 bg-slate-800 border-b border-slate-700 shrink-0">
          <ViewToggle view={view} onChange={setView} />
        </div>
        <AnalyticsView boardId={board.id} currentUserRole={board.current_user_role} />
      </>
    );
  }

  return (
    <>
      <div className="flex items-center gap-2 px-3 py-1.5 bg-slate-800 border-b border-slate-700 shrink-0 flex-wrap">
        <ViewToggle view={view} onChange={setView} />
        <span className="w-px h-4 bg-slate-600 shrink-0" />
        <button
          onClick={() => setShowFilters((v) => !v)}
          className="text-xs text-blue-600 hover:text-blue-800 transition shrink-0"
        >
          {showFilters ? "Hide filters" : "Filters"}
          {!showFilters && activeCount > 0 && (
            <span className="ml-1.5 bg-blue-100 text-blue-700 rounded-full px-1.5 py-0.5 font-medium">
              {activeCount}
            </span>
          )}
        </button>

        {/* Inline filter controls — same row, wrap to next line on narrow viewports */}
        {showFilters && <FilterBar board={board} filters={filters} onChange={setFilters} searchRef={searchRef} />}

        <span className="w-px h-4 bg-slate-600 ml-auto shrink-0" />
        <button
          onClick={() => setShowShortcuts((v) => !v)}
          className="text-xs text-slate-500 hover:text-slate-300 transition font-mono shrink-0"
          title="Keyboard shortcuts (?)"
        >
          ?
        </button>
        <span className="w-px h-4 bg-slate-600 shrink-0" />
        <button
          onClick={() => { if (isAdmin) setShowSettings(true); }}
          className={`text-xs transition shrink-0 ${isAdmin ? "text-slate-400 hover:text-slate-200" : "text-slate-600 opacity-50 cursor-not-allowed"}`}
          title={isAdmin ? undefined : "You need admin access to change board settings"}
          disabled={!isAdmin}
        >
          Settings
        </button>
        <span className="w-px h-4 bg-slate-600 shrink-0" />
        <span
          className={`flex items-center gap-1 text-xs font-medium shrink-0 ${connected ? "text-green-500" : "text-gray-400"}`}
          title={connected ? "Live — real-time updates active" : "Connecting…"}
        >
          <span className={`w-1.5 h-1.5 rounded-full ${connected ? "bg-green-500" : "bg-slate-500"}`} />
          {connected ? "Live" : "Connecting…"}
        </span>
      </div>
      {cardNotFound && (
        <div className="mx-4 mt-2 px-4 py-2 bg-amber-900/50 border border-amber-700 rounded-lg text-amber-200 text-sm">
          Card not found — it may have been archived or deleted.
        </div>
      )}
      <DndContext sensors={sensors} onDragStart={handleDragStart} onDragEnd={handleDragEnd} collisionDetection={closestCenter}>
        {/*
          Single scroll container — header and body share the same horizontal
          scroll so fixed-width columns always line up.
        */}
        <div className="flex-1 overflow-auto bg-slate-900">
          {/*
            min-w-max wrapper — gives the sticky header row and all swimlane
            rows the same containing-block width (max-content).  Without this,
            a sticky element may be sized to the scroll-container's layout
            width rather than the full scrollable content width, so its flex-1
            columns become narrower than the corresponding cells below.
          */}
          <div className="min-w-max">
          {/* Header row — sticky to the top of the scroll container */}
          <div className="flex sticky top-0 z-10 border-b border-slate-700 bg-slate-800">
            {/* Corner — also sticky to the left */}
            <div className="w-[220px] shrink-0 bg-gray-800 flex items-center justify-center sticky left-0 z-20">
              {isAdmin && (
                <button
                  onClick={() => { setInsertSwimlanePosition(null); setShowAddSwimlane(true); }}
                  className="text-xs text-gray-400 hover:text-white transition px-2 py-1 rounded"
                >
                  + Swimlane
                </button>
              )}
            </div>

            <SortableContext items={board.columns.map((c) => `col:${c.id}`)} strategy={horizontalListSortingStrategy}>
              {board.columns.map((col, idx) => (
                <ColumnHeader
                  key={col.id}
                  column={col}
                  cards={board.cards.filter((c) => c.column === col.id)}
                  boardId={board.id}
                  isAdmin={isAdmin}
                  onColumnUpdated={onColumnUpdated}
                  onColumnDeleted={onColumnDeleted}
                  collapsed={collapsedColumns.has(col.id)}
                  hidden={hiddenColumnIds.has(col.id)}
                  onToggleCollapse={() => toggleColumn(col.id)}
                  onInsertLeft={() => { setInsertPosition(idx); setShowAddColumn(true); }}
                  onInsertRight={() => { setInsertPosition(idx + 1); setShowAddColumn(true); }}
                />
              ))}
            </SortableContext>

            {activeColumn ? (
              <ColumnTrashZone />
            ) : (
              <div className="w-20 shrink-0 flex items-center px-2 bg-slate-800 border-l border-slate-700">
                {isAdmin && (
                  <button
                    onClick={() => setShowAddColumn(true)}
                    className="text-xs text-slate-400 hover:text-slate-200 whitespace-nowrap px-2 py-1 rounded hover:bg-slate-700 transition"
                  >
                    + Col
                  </button>
                )}
              </div>
            )}
          </div>

          {/* Empty state: no columns */}
          {board.columns.length === 0 && (
            <div className="flex flex-col items-center justify-center h-64 gap-3 text-gray-400">
              <p className="text-sm">No columns — add one to continue.</p>
              {isAdmin && (
                <button
                  onClick={() => setShowAddColumn(true)}
                  className="text-sm bg-blue-600 text-white px-4 py-2 rounded-lg hover:bg-blue-700 transition"
                >
                  + Add column
                </button>
              )}
            </div>
          )}

          {/* Swimlane rows */}
          {board.columns.length > 0 && (
            <SortableContext items={board.swimlanes.map((s) => `swim:${s.id}`)} strategy={verticalListSortingStrategy}>
              {board.swimlanes
                .filter((swimlane) => !hiddenSwimlaneIds.has(swimlane.id))
                .map((swimlane, idx) => (
            <SwimlaneRow
              key={swimlane.id}
              swimlane={swimlane}
              columns={board.columns}
              cards={board.cards.filter((c) => c.swimlane === swimlane.id)}
              boardId={board.id}
              isAdmin={isAdmin}
              canEdit={canEdit}
              closeEditorOnEnter={board.close_editor_on_enter}
              collapsedColumnIds={collapsedColumns}
              hiddenColumnIds={hiddenColumnIds}
              filteredCardIds={filteredCardIds}
              selectedCardIds={selectedCardIds}
              highlightedCardId={highlightedCardId}
              onToggleCardSelection={toggleCardSelection}
              onCardClick={(card) => { clearSelection(); setSelectedCard(card); }}
              onCardAdded={onCardAdded}
              onSwimlaneUpdated={onSwimlaneUpdated}
              onSwimlaneDeleted={onSwimlaneDeleted}
              onInsertAbove={() => { setInsertSwimlanePosition(idx); setShowAddSwimlane(true); }}
              onInsertBelow={() => { setInsertSwimlanePosition(idx + 1); setShowAddSwimlane(true); }}
              hideLabels={viewPrefs.hideLabels}
              hideDueDate={viewPrefs.hideDueDate}
              hideAssignee={viewPrefs.hideAssignee}
              hidePriority={viewPrefs.hidePriority}
              userTimezone={userTimezone}
            />
              ))}
            </SortableContext>
          )}

          {/* Empty state: has columns but no swimlanes */}
          {board.columns.length > 0 && board.swimlanes.length === 0 && (
            <div className="flex flex-col items-center justify-center h-64 gap-3 text-gray-400">
              <p className="text-sm">No swimlanes — add one to continue.</p>
              {isAdmin && (
                <button
                  onClick={() => setShowAddSwimlane(true)}
                  className="text-sm bg-blue-600 text-white px-4 py-2 rounded-lg hover:bg-blue-700 transition"
                >
                  + Add swimlane
                </button>
              )}
            </div>
          )}
          </div>{/* end min-w-max wrapper */}
        </div>

        <DragOverlay>
          {activeCard && <CardItem card={activeCard} overlay userTimezone={userTimezone} />}
          {activeColumn && (
            <div className="flex-1 min-w-[180px] px-3 py-3 border border-blue-400 bg-blue-50 rounded shadow-xl opacity-90">
              <div className="flex items-center gap-2">
                <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: activeColumn.color }} />
                <span className="font-semibold text-slate-300 text-sm">{activeColumn.name}</span>
              </div>
            </div>
          )}
          {activeSwimlane && (
            <div className="w-[220px] px-3 py-3 border border-blue-400 bg-slate-800 rounded shadow-xl opacity-90 flex items-center gap-2">
              <span className="w-1 h-8 rounded-full shrink-0" style={{ backgroundColor: activeSwimlane.color }} />
              <span className="font-semibold text-white text-sm truncate">{activeSwimlane.name}</span>
            </div>
          )}
        </DragOverlay>
      </DndContext>

      {selectedCardIds.size > 0 && canEdit && (
        <BulkActionToolbar
          board={board}
          selectedCardIds={selectedCardIds}
          onCardsUpdated={(cards) => cards.forEach(onCardUpdated)}
          onCardsDeleted={(ids) => ids.forEach(onCardDeleted)}
          onClearSelection={clearSelection}
        />
      )}

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
          onAdded={handleColumnAdded}
          onClose={() => { setShowAddColumn(false); setInsertPosition(null); }}
        />
      )}

      {isAdmin && showAddSwimlane && (
        <AddSwimlaneModal
          boardId={board.id}
          onAdded={(swimlane) => { handleSwimlaneAdded(swimlane); setShowAddSwimlane(false); setInsertSwimlanePosition(null); }}
          onClose={() => { setShowAddSwimlane(false); setInsertSwimlanePosition(null); }}
        />
      )}

      {showSettings && (
        <BoardSettingsModal
          board={board}
          isAdmin={isAdmin}
          onClose={() => setShowSettings(false)}
          viewPrefs={viewPrefs}
          onToggleHiddenColumn={toggleHiddenColumn}
          onToggleHiddenSwimlane={toggleHiddenSwimlane}
          onSetCardFieldPref={setCardFieldPref}
          onBoardSettingsChanged={onBoardSettingsChanged}
        />
      )}

      {showShortcuts && <KeyboardShortcutsOverlay onClose={() => setShowShortcuts(false)} />}

      {confirmDeleteColumn && (() => {
        const cardCount = board.cards.filter((c) => c.column === confirmDeleteColumn.id).length;
        return (
          <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
            <div className="bg-gray-800 rounded-xl p-6 w-full max-w-sm shadow-xl">
              <h3 className="text-white font-semibold text-lg mb-2">Delete column?</h3>
              <p className="text-gray-400 text-sm mb-1">
                <span className="text-white font-medium">{confirmDeleteColumn.name}</span> will be permanently deleted.
              </p>
              {cardCount > 0 && (
                <p className="text-red-400 text-sm mb-1">
                  {cardCount} card{cardCount !== 1 ? "s" : ""} in this column will also be deleted.
                </p>
              )}
              <p className="text-gray-500 text-sm mb-5">This cannot be undone.</p>
              <div className="flex gap-3 justify-end">
                <button
                  onClick={() => setConfirmDeleteColumn(null)}
                  className="text-gray-400 text-sm hover:text-white px-3 py-1.5"
                >
                  Cancel
                </button>
                <button
                  onClick={() => {
                    onColumnDeleted(confirmDeleteColumn.id);
                    setConfirmDeleteColumn(null);
                  }}
                  className="bg-red-600 hover:bg-red-700 text-white text-sm px-4 py-1.5 rounded-lg"
                >
                  Delete
                </button>
              </div>
            </div>
          </div>
        );
      })()}
    </>
  );
}
