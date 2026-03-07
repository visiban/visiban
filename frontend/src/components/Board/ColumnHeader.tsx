import { useState } from "react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { Card, Column } from "../../types";
import EditColumnModal from "./EditColumnModal";

interface Props {
  column: Column;
  cards: Card[];
  boardId: number;
  isAdmin: boolean;
  onColumnUpdated: (column: Column) => void;
  onColumnDeleted: (columnId: number) => void;
  collapsed: boolean;
  onToggleCollapse: () => void;
  onInsertLeft?: () => void;
  onInsertRight?: () => void;
}

export default function ColumnHeader({ column, cards, boardId, isAdmin, onColumnUpdated, onColumnDeleted, collapsed, onToggleCollapse, onInsertLeft, onInsertRight }: Props) {
  const [editing, setEditing] = useState(false);
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: `col:${column.id}`, disabled: !isAdmin });
  const style = { transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.3 : undefined };

  const cardCount = cards.length;
  const totalWeight = cards.reduce((sum, c) => sum + c.weight, 0);
  const overWip = column.wip_limit !== null && cardCount > column.wip_limit;
  const overWeight = column.weight_limit !== null && totalWeight > column.weight_limit;

  if (collapsed) {
    return (
      <div
        ref={setNodeRef}
        style={style}
        className="w-10 shrink-0 flex flex-col items-center py-3 gap-2 border-r border-gray-200 bg-gray-50 cursor-pointer hover:bg-gray-100 transition overflow-hidden"
        onClick={onToggleCollapse}
        title={`Expand "${column.name}"`}
        {...attributes}
        {...listeners}
      >
        <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: column.color }} />
        <span
          className={`text-xs font-medium px-1 py-0.5 rounded-full ${
            overWip ? "bg-red-100 text-red-700" : "bg-gray-200 text-gray-500"
          }`}
        >
          {cardCount}
        </span>
        <span
          className="text-xs font-semibold text-gray-500 flex-1 flex items-center"
          style={{ writingMode: "vertical-rl", transform: "rotate(180deg)" }}
        >
          {column.name}
        </span>
        <span className="text-gray-400 text-xs">▶</span>
      </div>
    );
  }

  return (
    <>
      <div
        ref={setNodeRef}
        style={style}
        className={`relative flex-1 min-w-[180px] px-3 py-3 border-r border-gray-200 bg-gray-50 group/col transition ${isAdmin ? "cursor-pointer hover:bg-gray-100" : ""}`}
        onClick={() => isAdmin && setEditing(true)}
        title={isAdmin ? "Click to edit column" : undefined}
      >
        {/* Insert-left button — visible on hover */}
        {isAdmin && (
          <button
            onClick={(e) => { e.stopPropagation(); onInsertLeft?.(); }}
            className="absolute left-0 top-0 bottom-0 w-4 flex items-center justify-center opacity-0 group-hover/col:opacity-100 bg-blue-50 hover:bg-blue-200 text-blue-400 hover:text-blue-700 text-sm font-bold transition z-10 rounded-l border-r border-blue-100"
            title="Insert column to the left"
          >
            +
          </button>
        )}
        {/* Insert-right button — visible on hover */}
        {isAdmin && (
          <button
            onClick={(e) => { e.stopPropagation(); onInsertRight?.(); }}
            className="absolute right-0 top-0 bottom-0 w-4 flex items-center justify-center opacity-0 group-hover/col:opacity-100 bg-blue-50 hover:bg-blue-200 text-blue-400 hover:text-blue-700 text-sm font-bold transition z-10 rounded-r border-l border-blue-100"
            title="Insert column to the right"
          >
            +
          </button>
        )}
        <div className="flex items-center gap-2">
          {/* Collapse toggle — stopPropagation so it doesn't open the edit modal */}
          <button
            onClick={(e) => { e.stopPropagation(); onToggleCollapse(); }}
            className="text-gray-300 hover:text-gray-600 transition text-xs shrink-0"
            title="Collapse column"
          >
            ◀
          </button>

          {/* Drag handle — admins only */}
          <span
            className={`w-2.5 h-2.5 rounded-full shrink-0 ${isAdmin ? "cursor-grab active:cursor-grabbing" : ""}`}
            style={{ backgroundColor: column.color }}
            title={isAdmin ? "Drag to reorder" : undefined}
            {...(isAdmin ? { ...attributes, ...listeners } : {})}
            onClick={(e) => e.stopPropagation()}
          />
          <span className="font-semibold text-gray-700 text-sm truncate">{column.name}</span>

          <div className="ml-auto flex items-center gap-1.5 shrink-0">
            <span
              className={`text-xs font-medium px-1.5 py-0.5 rounded-full ${
                overWip ? "bg-red-100 text-red-700" : "bg-gray-200 text-gray-500"
              }`}
              title="Cards / WIP limit"
            >
              {column.wip_limit !== null ? `${cardCount}/${column.wip_limit}` : cardCount}
            </span>

            {column.weight_limit !== null && (
              <span
                className={`text-xs font-medium px-1.5 py-0.5 rounded-full ${
                  overWeight ? "bg-orange-100 text-orange-700" : "bg-blue-50 text-blue-500"
                }`}
                title="Total weight / weight limit"
              >
                ⚖ {totalWeight}/{column.weight_limit}
              </span>
            )}

            {isAdmin && <span className="text-gray-300 group-hover:text-gray-500 transition text-xs">✎</span>}
          </div>
        </div>
      </div>

      {isAdmin && editing && (
        <EditColumnModal
          boardId={boardId}
          column={column}
          cardCount={cardCount}
          onUpdated={(col) => { onColumnUpdated(col); setEditing(false); }}
          onDeleted={(id) => { onColumnDeleted(id); setEditing(false); }}
          onClose={() => setEditing(false)}
        />
      )}
    </>
  );
}
