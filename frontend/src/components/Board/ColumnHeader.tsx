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
        className="w-10 shrink-0 flex flex-col items-center py-3 gap-2 border-r border-slate-700 bg-slate-800 cursor-pointer hover:bg-slate-700 transition overflow-hidden"
        onClick={onToggleCollapse}
        title={`Expand "${column.name}"`}
        {...attributes}
        {...listeners}
      >
        <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: column.color }} />
        <span
          className={`text-xs font-medium px-1 py-0.5 rounded-full ${
            overWip ? "bg-red-900/50 text-red-400" : "bg-slate-700 text-slate-400"
          }`}
        >
          {cardCount}
        </span>
        <span
          className="text-xs font-semibold text-slate-400 flex-1 flex items-center"
          style={{ writingMode: "vertical-rl", transform: "rotate(180deg)" }}
        >
          {column.name}
        </span>
        <span className="text-slate-500 text-xs">▶</span>
      </div>
    );
  }

  const nonAdminTitle = "You need admin access to change board settings";

  return (
    <>
      <div
        ref={setNodeRef}
        style={style}
        className={`relative flex-1 min-w-[200px] px-3 py-2 border-r border-slate-700 bg-slate-800 group/col transition ${isAdmin ? "cursor-pointer hover:bg-slate-700" : ""}`}
        onClick={() => isAdmin && setEditing(true)}
        title={isAdmin ? "Click to edit column" : undefined}
      >
        {/* Insert-left button — visible on hover for admins; always visible but dimmed for non-admins */}
        <button
          onClick={(e) => { e.stopPropagation(); if (isAdmin) onInsertLeft?.(); }}
          className={`absolute left-0 top-0 bottom-0 w-4 flex items-center justify-center bg-blue-900/40 text-blue-400 text-sm font-bold transition z-10 rounded-l border-r border-blue-800/50 ${isAdmin ? "opacity-0 group-hover/col:opacity-100 hover:bg-blue-800/60 hover:text-blue-300" : "opacity-50 cursor-not-allowed"}`}
          title={isAdmin ? "Insert column to the left" : nonAdminTitle}
          disabled={!isAdmin}
        >
          +
        </button>
        {/* Insert-right button — visible on hover for admins; always visible but dimmed for non-admins */}
        <button
          onClick={(e) => { e.stopPropagation(); if (isAdmin) onInsertRight?.(); }}
          className={`absolute right-0 top-0 bottom-0 w-4 flex items-center justify-center bg-blue-900/40 text-blue-400 text-sm font-bold transition z-10 rounded-r border-l border-blue-800/50 ${isAdmin ? "opacity-0 group-hover/col:opacity-100 hover:bg-blue-800/60 hover:text-blue-300" : "opacity-50 cursor-not-allowed"}`}
          title={isAdmin ? "Insert column to the right" : nonAdminTitle}
          disabled={!isAdmin}
        >
          +
        </button>

        {/* Row 1: collapse toggle, color dot, name, edit icon */}
        <div className="flex items-center gap-2">
          <button
            onClick={(e) => { e.stopPropagation(); onToggleCollapse(); }}
            className="text-slate-500 hover:text-slate-300 transition text-xs shrink-0"
            title="Collapse column"
          >
            ◀
          </button>
          <span
            className={`w-2.5 h-2.5 rounded-full shrink-0 ${isAdmin ? "cursor-grab active:cursor-grabbing" : ""}`}
            style={{ backgroundColor: column.color }}
            title={isAdmin ? "Drag to reorder" : undefined}
            {...(isAdmin ? { ...attributes, ...listeners } : {})}
            onClick={(e) => e.stopPropagation()}
          />
          <span className="font-semibold text-slate-200 text-sm truncate">{column.name}</span>
          {/* Edit icon — shown to all, dimmed and non-interactive for non-admins */}
          <span
            className={`ml-auto transition text-xs shrink-0 ${isAdmin ? "text-slate-600 group-hover/col:text-slate-400" : "text-slate-700 opacity-50 cursor-not-allowed"}`}
            title={isAdmin ? "Click to edit column" : nonAdminTitle}
          >
            ✎
          </span>
        </div>

        {/* Row 2: WIP and Weight stats with labels */}
        <div className="flex items-center gap-3 mt-1.5 pl-[26px]">
          <span
            className={`text-[10px] font-medium ${overWip ? "text-red-400" : "text-slate-500"}`}
            title="Cards in column / WIP limit"
          >
            WIP{" "}
            <span className={`font-semibold ${overWip ? "text-red-400" : "text-slate-300"}`}>
              {cardCount}/{column.wip_limit ?? "∞"}
            </span>
          </span>
          <span
            className={`text-[10px] font-medium ${overWeight ? "text-orange-400" : "text-slate-500"}`}
            title="Total card weight / weight budget"
          >
            Weight{" "}
            <span className={`font-semibold ${overWeight ? "text-orange-400" : "text-slate-300"}`}>
              {totalWeight}/{column.weight_limit ?? "∞"}
            </span>
          </span>
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
