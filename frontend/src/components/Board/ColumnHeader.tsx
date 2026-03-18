import { useState, useRef } from "react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { Card, Column } from "../../types";
import EditColumnModal from "./EditColumnModal";
import { updateColumn } from "../../api/boards";

interface Props {
  column: Column;
  cards: Card[];
  boardId: number;
  isAdmin: boolean;
  onColumnUpdated: (column: Column) => void;
  onColumnDeleted: (columnId: number) => void;
  collapsed: boolean;
  hidden?: boolean;
  abbreviation?: string;
  width?: number;
  onToggleCollapse: () => void;
}

export default function ColumnHeader({ column, cards, boardId, isAdmin, onColumnUpdated, onColumnDeleted, collapsed, hidden, abbreviation, width, onToggleCollapse }: Props) {
  const [editing, setEditing] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: `col:${column.id}`, disabled: !isAdmin });
  const style = { transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.3 : undefined };

  const cardCount = cards.length;
  const totalWeight = cards.reduce((sum, c) => sum + c.weight, 0);
  const overWip = column.wip_limit !== null && cardCount > column.wip_limit;
  const overWeight = column.weight_limit !== null && totalWeight > column.weight_limit;

  const startRenaming = () => {
    setDraft(column.name);
    setRenaming(true);
  };

  const commitRename = async () => {
    const trimmed = draft.trim();
    setRenaming(false);
    if (!trimmed || trimmed === column.name) return;
    const updated = await updateColumn(boardId, column.id, { name: trimmed });
    onColumnUpdated(updated);
  };

  const cancelRename = () => {
    setRenaming(false);
    setDraft("");
  };

  // Hidden by view prefs — render a narrow stub matching hidden cell width
  if (hidden) {
    return (
      <div
        ref={setNodeRef}
        style={style}
        className="w-10 shrink-0 border-r border-slate-700 bg-slate-800/50"
        {...attributes}
        {...listeners}
      />
    );
  }

  if (collapsed) {
    return (
      <div
        ref={setNodeRef}
        style={style}
        className="w-10 shrink-0 flex flex-col items-center py-3 gap-2 border-r border-slate-700 bg-slate-800 cursor-pointer hover:bg-slate-700 transition overflow-hidden"
        onClick={onToggleCollapse}
        title={`Expand "${column.name}"`}
      >
        {/* Color dot is the drag handle — same pattern as expanded header */}
        <span
          className={`w-2.5 h-2.5 rounded-full shrink-0 ${isAdmin ? "cursor-grab active:cursor-grabbing" : ""}`}
          style={{ backgroundColor: column.color }}
          title={isAdmin ? "Drag to reorder" : undefined}
          onClick={(e) => e.stopPropagation()}
          {...(isAdmin ? { ...attributes, ...listeners } : {})}
        />
        <span
          className={`text-xs font-medium px-1 py-0.5 rounded-full ${
            overWip ? "bg-red-900/50 text-red-400" : "bg-slate-700 text-slate-400"
          }`}
        >
          {cardCount}
        </span>
        <span
          className="text-[11px] font-bold text-slate-400 tracking-widest flex-1 flex items-center"
          style={{ writingMode: "vertical-rl", transform: "rotate(180deg)" }}
          title={column.name}
        >
          {abbreviation ?? column.name.slice(0, 3).toUpperCase()}
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
        style={{ ...style, width: width ?? 220 }}
        className={`relative shrink-0 px-3 py-2 bg-slate-800 border-r border-slate-700 group/col transition ${overWip ? "border-b-2 border-b-red-500/50" : ""}`}
        onDoubleClick={isAdmin ? () => setEditing(true) : undefined}
      >
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
          {renaming ? (
            <input
              ref={inputRef}
              autoFocus
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") { e.preventDefault(); commitRename(); }
                if (e.key === "Escape") { e.preventDefault(); cancelRename(); }
              }}
              onBlur={commitRename}
              onClick={(e) => e.stopPropagation()}
              className="flex-1 min-w-0 text-sm font-semibold bg-slate-900 text-slate-100 border border-blue-500 rounded px-1 py-0 outline-none"
            />
          ) : (
            <span
              className={`font-semibold text-slate-200 text-sm truncate ${isAdmin ? "cursor-text hover:text-white" : ""}`}
              title={isAdmin ? "Click to rename" : column.name}
              onClick={isAdmin ? (e) => { e.stopPropagation(); startRenaming(); } : undefined}
            >
              {column.name}
            </span>
          )}
          {/* Edit icon — opens full modal */}
          <span
            className={`ml-auto transition text-xs shrink-0 ${isAdmin ? "text-slate-600 group-hover/col:text-slate-400 cursor-pointer hover:text-slate-200" : "text-slate-700 opacity-50 cursor-not-allowed"}`}
            title={isAdmin ? "Edit column settings" : nonAdminTitle}
            onClick={isAdmin ? (e) => { e.stopPropagation(); setEditing(true); } : undefined}
          >
            ✎
          </span>
        </div>

        {/* Rows 2–3: WIP and Weight stats — only shown when meaningful */}
        {(column.wip_limit !== null || totalWeight > 0) && (
          <div className="flex flex-col gap-0.5 mt-1.5 pl-[26px]">
            {column.wip_limit !== null && (
              <span
                className={`text-[10px] font-medium ${overWip ? "text-red-400" : "text-slate-500"}`}
                title="Cards in column / WIP limit"
              >
                WIP{" "}
                <span className={`font-semibold ${overWip ? "text-red-400" : "text-slate-300"}`}>
                  {cardCount}/{column.wip_limit}
                </span>
              </span>
            )}
            {totalWeight > 0 && (
              <span
                className={`text-[10px] font-medium ${overWeight ? "text-orange-400" : "text-slate-500"}`}
                title="Total card weight / weight budget"
              >
                Weight{" "}
                <span className={`font-semibold ${overWeight ? "text-orange-400" : "text-slate-300"}`}>
                  {totalWeight}{column.weight_limit !== null ? `/${column.weight_limit}` : ""}
                </span>
              </span>
            )}
          </div>
        )}
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
