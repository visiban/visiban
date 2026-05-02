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
  onRequestDelete: (column: Column) => void;
  collapsed: boolean;
  hidden?: boolean;
  abbreviation?: string;
  width?: number;
  onToggleCollapse: () => void;
  hardWipEnforced?: boolean;
}

export default function ColumnHeader({ column, cards, boardId, isAdmin, onColumnUpdated, onRequestDelete, collapsed, hidden, abbreviation, width, onToggleCollapse, hardWipEnforced }: Props) {
  const [editing, setEditing] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: `col:${column.id}`, disabled: !isAdmin });
  const style = { transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.3 : undefined };

  const cardCount = cards.length;
  const totalWeight = cards.reduce((sum, c) => sum + c.weight, 0);
  const overWip = column.wip_limit !== null && column.wip_limit > 0 && cardCount > column.wip_limit;
  const overWeight = column.weight_limit !== null && totalWeight > column.weight_limit;
  // Top accent strip — peripherally scannable cue for over-limit state. Worst-offender
  // takes precedence (WIP > weight); calm state has no strip.
  const accentClass = overWip
    ? "border-t-2 border-t-danger-emphasis"
    : overWeight
    ? "border-t-2 border-t-warning-emphasis"
    : "";
  const cardCountLabel = cardCount === 1 ? "1 card" : `${cardCount} cards`;
  const showStatsRow = column.wip_limit !== null || totalWeight > 0 || cardCount > 0;

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
        className="w-10 shrink-0 border-r border-line bg-surface/50"
        data-no-pan
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
        className={`w-10 shrink-0 flex flex-col items-center py-3 gap-2 border-r border-line bg-surface cursor-pointer hover:bg-surface-hover transition overflow-hidden focus:outline-none focus:ring-2 focus:ring-inset focus:ring-primary-emphasis ${accentClass}`}
        data-no-pan
        tabIndex={0}
        role="button"
        onClick={onToggleCollapse}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onToggleCollapse(); } }}
        title={
          overWip
            ? `Expand "${column.name}" · Over WIP limit (${cardCount}/${column.wip_limit})`
            : overWeight
            ? `Expand "${column.name}" · Over weight limit (${totalWeight}/${column.weight_limit})`
            : `Expand "${column.name}"`
        }
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
            overWip
              ? "text-danger font-semibold"
              : overWeight
              ? "text-warning font-semibold"
              : "bg-surface-hover text-fg-tertiary"
          }`}
        >
          {cardCount}
        </span>
        {(overWip || overWeight) && (
          <span aria-hidden="true" className={`text-[10px] leading-none ${overWip ? "text-danger" : "text-warning"}`}>⚠</span>
        )}
        <span
          className="text-[11px] font-bold text-fg-tertiary tracking-widest flex-1 flex items-center"
          style={{ writingMode: "vertical-rl", transform: "rotate(180deg)" }}
          title={column.name}
        >
          {abbreviation ?? column.name.slice(0, 3).toUpperCase()}
        </span>
        <span className="text-fg-muted text-xs">▶</span>
      </div>
    );
  }

  const nonAdminTitle = "You need admin access to change board settings";

  return (
    <>
      <div
        ref={setNodeRef}
        style={{ ...style, width: width ?? 220 }}
        className={`relative shrink-0 px-3 py-2 bg-surface border-r border-line group/col transition ${accentClass}`}
        data-no-pan
        onDoubleClick={isAdmin ? () => setEditing(true) : undefined}
      >
        {/* Row 1: collapse toggle, color dot, name, edit icon */}
        <div className="flex items-center gap-2">
          <button
            onClick={(e) => { e.stopPropagation(); onToggleCollapse(); }}
            className="text-fg-muted hover:text-fg-secondary transition text-xs shrink-0 focus:outline-none focus:ring-2 focus:ring-primary-emphasis rounded"
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
              className="flex-1 min-w-0 text-sm font-medium bg-sunken text-fg border border-primary-emphasis rounded px-1 py-0 outline-none"
            />
          ) : (
            <span
              className={`font-medium text-fg text-sm truncate ${isAdmin ? "cursor-text hover:text-fg" : ""}`}
              title={isAdmin ? "Click to rename" : column.name}
              onClick={isAdmin ? (e) => { e.stopPropagation(); startRenaming(); } : undefined}
            >
              {column.name}
            </span>
          )}
          {/* Edit icon — opens full modal */}
          <button
            type="button"
            className={`ml-auto transition text-xs shrink-0 focus:outline-none focus:opacity-100 focus:ring-2 focus:ring-primary-emphasis rounded ${isAdmin ? "text-fg-faint group-hover/col:text-fg-tertiary hover:text-fg" : "text-fg-faint opacity-50 cursor-not-allowed"}`}
            title={isAdmin ? "Edit column settings" : nonAdminTitle}
            onClick={isAdmin ? (e) => { e.stopPropagation(); setEditing(true); } : undefined}
            disabled={!isAdmin}
          >
            ✎
          </button>
        </div>

        {/* Stat row — surface only the worst-offender (WIP > weight); calm state shows
            just the card count. Drops the "WIP" / "Weight" label words when nothing is
            in trouble (per #963 — the limit phrasing only earns its place when a column
            is actually over). */}
        {showStatsRow && (
          // pl-[26px] aligns under the column name: 16px collapse-button column + 10px dot+gap
          <div className="mt-1.5 pl-[26px]">
            {overWip ? (
              <span
                className="text-xs font-medium text-danger"
                title={hardWipEnforced ? "WIP hard limit — no override possible" : "Over WIP limit"}
              >
                <span aria-hidden="true">{hardWipEnforced ? "⛔ " : "⚠ "}</span>
                Over WIP ·{" "}
                <span className="font-semibold">
                  {cardCount}/{column.wip_limit}
                </span>
              </span>
            ) : overWeight ? (
              <span
                className="text-xs font-medium text-warning"
                title="Over weight budget"
              >
                Weight{" "}
                <span className="font-semibold">
                  {totalWeight}/{column.weight_limit}
                </span>
              </span>
            ) : (
              <span
                className="text-xs font-medium text-fg-muted"
                title="Cards in column"
              >
                {cardCountLabel}
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
          onRequestDelete={onRequestDelete}
          onClose={() => setEditing(false)}
        />
      )}
    </>
  );
}
