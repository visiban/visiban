import { useState } from "react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { Card, Column, Swimlane } from "../../types";
import BoardCell from "./BoardCell";
import EditSwimlaneModal from "./EditSwimlaneModal";

interface Props {
  swimlane: Swimlane;
  columns: Column[];
  cards: Card[];
  boardId: number;
  isAdmin: boolean;
  canEdit: boolean;
  collapsedColumnIds: Set<number>;
  filteredCardIds: Set<number> | null;
  selectedCardIds: Set<number>;
  highlightedCardId?: number | null;
  onToggleCardSelection: (cardId: number) => void;
  onCardClick: (card: Card) => void;
  onCardAdded: (card: Card) => void;
  onSwimlaneUpdated: (swimlane: Swimlane) => void;
  onSwimlaneDeleted: (swimlaneId: number) => void;
  onInsertAbove?: () => void;
  onInsertBelow?: () => void;
}

export default function SwimlaneRow({ swimlane, columns, cards, boardId, isAdmin, canEdit, collapsedColumnIds, filteredCardIds, selectedCardIds, highlightedCardId, onToggleCardSelection, onCardClick, onCardAdded, onSwimlaneUpdated, onSwimlaneDeleted , onInsertAbove, onInsertBelow }: Props) {
  const [collapsed, setCollapsed] = useState(swimlane.is_collapsed);
  const [editing, setEditing] = useState(false);

  const {
    setNodeRef,
    attributes,
    listeners,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: `swim:${swimlane.id}`, disabled: !isAdmin });

  return (
    <>
      <div
        ref={setNodeRef}
        style={{ transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.3 : 1 }}
        className="flex border-b border-slate-700 bg-slate-800"
      >
        {/* Swimlane label — sticky to the left */}
        <div className="w-[220px] shrink-0 flex items-start gap-2 px-3 py-3 sticky left-0 z-10 bg-gray-800 border-r border-gray-700 group relative">
          {/* Insert above button */}
          {isAdmin && onInsertAbove && (
            <button
              onClick={onInsertAbove}
              className="absolute top-0 left-0 right-0 h-3 flex items-center justify-center opacity-0 group-hover:opacity-100 transition z-10 hover:bg-blue-600/20"
              title="Insert swimlane above"
            >
              <span className="text-blue-400 text-xs leading-none">+</span>
            </button>
          )}

          {/* Drag handle */}
          {isAdmin && (
            <span
              {...attributes}
              {...listeners}
              className="text-gray-600 hover:text-gray-300 cursor-grab active:cursor-grabbing text-sm select-none shrink-0 mt-0.5"
              title="Drag to reorder"
            >
              ⠿
            </span>
          )}

          {/* Color stripe */}
          <span className="w-1 self-stretch rounded-full shrink-0" style={{ backgroundColor: swimlane.color }} />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold text-white truncate">{swimlane.name}</p>
            <p className="text-xs text-gray-400 truncate">{swimlane.contact_email}</p>
          </div>
          <div className="flex items-center gap-1 shrink-0">
            <button
              onClick={() => { if (isAdmin) setEditing(true); }}
              className={`transition text-xs ${isAdmin ? "text-gray-500 hover:text-white opacity-0 group-hover:opacity-100" : "text-gray-600 opacity-50 cursor-not-allowed"}`}
              title={isAdmin ? "Edit swimlane" : "You need admin access to change board settings"}
              disabled={!isAdmin}
            >
              ✎
            </button>
            <button
              onClick={() => setCollapsed((c) => !c)}
              className="text-gray-400 hover:text-white transition text-xs mt-0.5"
              title={collapsed ? "Expand" : "Collapse"}
            >
              {collapsed ? "▶" : "▼"}
            </button>
          </div>

          {/* Insert below button */}
          {isAdmin && onInsertBelow && (
            <button
              onClick={onInsertBelow}
              className="absolute bottom-0 left-0 right-0 h-3 flex items-center justify-center opacity-0 group-hover:opacity-100 transition z-10 hover:bg-blue-600/20"
              title="Insert swimlane below"
            >
              <span className="text-blue-400 text-xs leading-none">+</span>
            </button>
          )}
        </div>

        {/* Cells — always iterate columns so collapsed-column stubs stay aligned */}
        {columns.map((col) => {
          const cellCards = cards.filter((c) => c.column === col.id);
          const cellCount = cellCards.length;

          if (collapsedColumnIds.has(col.id)) {
            // Collapsed column: show per-swimlane card count
            return (
              <div
                key={col.id}
                className="w-10 shrink-0 border-r border-slate-700 flex items-center justify-center py-1"
              >
                {cellCount > 0 && (
                  <span className="text-xs text-slate-400 font-medium">{cellCount}</span>
                )}
              </div>
            );
          }

          if (collapsed) {
            // Swimlane collapsed, non-collapsed column: show hidden count placeholder
            return (
              <div
                key={col.id}
                className="flex-1 min-w-[200px] border-r border-slate-700 flex items-center justify-center"
              >
                {cellCount > 0 && (
                  <span className="text-xs text-slate-400 italic">{cellCount} hidden</span>
                )}
              </div>
            );
          }

          return (
            <BoardCell
              key={col.id}
              column={col}
              swimlane={swimlane}
              cards={cellCards.sort((a, b) => a.position - b.position)}
              boardId={boardId}
              canEdit={canEdit}
              filteredCardIds={filteredCardIds}
              selectedCardIds={selectedCardIds}
              highlightedCardId={highlightedCardId}
              onToggleCardSelection={onToggleCardSelection}
              onCardClick={onCardClick}
              onCardAdded={onCardAdded}
            />
          );
        })}
        {/* Spacer matching the fixed-width "+ Col" button in the header */}
        {!collapsed && <div className="w-20 shrink-0" />}
      </div>

      {isAdmin && editing && (
        <EditSwimlaneModal
          boardId={boardId}
          swimlane={swimlane}
          cardCount={cards.length}
          onUpdated={(s) => { onSwimlaneUpdated(s); setEditing(false); }}
          onDeleted={(id) => { onSwimlaneDeleted(id); setEditing(false); }}
          onClose={() => setEditing(false)}
        />
      )}
    </>
  );
}
