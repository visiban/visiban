import { useState, useRef } from "react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { Card, Column, Swimlane } from "../../types";
import { updateSwimlane } from "../../api/boards";
import BoardCell from "./BoardCell";
import EditSwimlaneModal from "./EditSwimlaneModal";

interface Props {
  swimlane: Swimlane;
  columns: Column[];
  cards: Card[];
  boardId: number;
  isAdmin: boolean;
  canEdit: boolean;
  closeEditorOnEnter: boolean;
  collapsedColumnIds: Set<number>;
  hiddenColumnIds?: Set<number>;
  filteredCardIds: Set<number> | null;
  selectedCardIds: Set<number>;
  highlightedCardId?: number | null;
  onToggleCardSelection: (cardId: number) => void;
  onCardClick: (card: Card) => void;
  onCardAdded: (card: Card) => void;
  onSwimlaneUpdated: (swimlane: Swimlane) => void;
  onSwimlaneDeleted: (swimlaneId: number) => void;
  sidebarWidth?: number;
  onResizeStart?: (e: React.MouseEvent) => void;
  colWidths?: Map<number, number>;
  setColumnWidth?: (colId: number, width: number) => void;
  minHeight?: number;
  setSwimlaneHeight?: (h: number) => void;
  hideLabels?: boolean;
  hideDueDate?: boolean;
  hideAssignee?: boolean;
  hidePriority?: boolean;
  userTimezone?: string;
  userDateFormat?: string;
}

export default function SwimlaneRow({ swimlane, columns, cards, boardId, isAdmin, canEdit, closeEditorOnEnter, collapsedColumnIds, hiddenColumnIds, filteredCardIds, selectedCardIds, highlightedCardId, onToggleCardSelection, onCardClick, onCardAdded, onSwimlaneUpdated, onSwimlaneDeleted, sidebarWidth, onResizeStart, colWidths, setColumnWidth, minHeight, setSwimlaneHeight, hideLabels, hideDueDate, hideAssignee, hidePriority, userTimezone, userDateFormat }: Props) {
  const [collapsed, setCollapsed] = useState(swimlane.is_collapsed);
  const [editing, setEditing] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const rowRef = useRef<HTMLDivElement>(null);
  const heightResizeState = useRef<{ startY: number; startHeight: number } | null>(null);

  const startRenaming = () => {
    setDraft(swimlane.name);
    setRenaming(true);
  };

  const commitRename = async () => {
    const trimmed = draft.trim();
    setRenaming(false);
    if (!trimmed || trimmed === swimlane.name) return;
    const updated = await updateSwimlane(boardId, swimlane.id, { name: trimmed, color: swimlane.color });
    onSwimlaneUpdated(updated);
  };

  const cancelRename = () => {
    setRenaming(false);
    setDraft("");
  };

  const handleHeightResizeStart = (e: React.MouseEvent) => {
    if (!setSwimlaneHeight) return;
    e.preventDefault();
    e.stopPropagation();
    const startHeight = rowRef.current ? rowRef.current.getBoundingClientRect().height : (minHeight ?? 80);
    heightResizeState.current = { startY: e.clientY, startHeight };
    const onMove = (ev: MouseEvent) => {
      if (!heightResizeState.current) return;
      setSwimlaneHeight(heightResizeState.current.startHeight + (ev.clientY - heightResizeState.current.startY));
    };
    const onUp = () => {
      heightResizeState.current = null;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

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
        ref={(el) => { setNodeRef(el); (rowRef as React.MutableRefObject<HTMLDivElement | null>).current = el; }}
        style={{ transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.3 : 1, minHeight: minHeight ?? undefined }}
        className="relative flex border-b border-slate-700 bg-slate-800"
      >
        {/* Swimlane label — sticky to the left */}
        <div
          className="shrink-0 flex items-start gap-2 pl-1 pr-3 py-3 sticky left-0 z-10 bg-slate-800 border-l-[3px] group relative"
          style={{ width: sidebarWidth ?? 220, borderLeftColor: swimlane.color || "transparent" }}
        >
          {/* Drag handle */}
          {isAdmin && (
            <span
              {...attributes}
              {...listeners}
              className="text-slate-600 hover:text-slate-300 cursor-grab active:cursor-grabbing text-sm select-none shrink-0 mt-0.5"
              title="Drag to reorder"
            >
              ⠿
            </span>
          )}

          <div className="flex-1 min-w-0">
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
                className="w-full text-sm font-semibold bg-slate-900 text-white border border-blue-500 rounded px-1 py-0 outline-none"
              />
            ) : (
              <p
                className={`text-sm font-semibold text-white truncate ${isAdmin ? "cursor-text hover:text-blue-200" : ""}`}
                title={isAdmin ? "Click to rename" : swimlane.name}
                onClick={isAdmin ? (e) => { e.stopPropagation(); startRenaming(); } : undefined}
              >
                {swimlane.name}
              </p>
            )}
            <p className="text-xs text-slate-400 truncate">{swimlane.contact_email}</p>
          </div>
          <div className="flex items-center gap-1 shrink-0">
            <button
              onClick={() => { if (isAdmin) setEditing(true); }}
              className={`transition text-xs ${isAdmin ? "text-slate-400 hover:text-white opacity-30 group-hover:opacity-100" : "text-slate-600 opacity-50 cursor-not-allowed"}`}
              title={isAdmin ? "Edit swimlane" : "You need admin access to change board settings"}
              disabled={!isAdmin}
            >
              ✎
            </button>
            <button
              onClick={() => setCollapsed((c) => !c)}
              className="text-slate-400 hover:text-white transition shrink-0"
              title={collapsed ? "Expand" : "Collapse"}
            >
              <svg
                className={`w-3.5 h-3.5 transition-transform ${collapsed ? "-rotate-90" : ""}`}
                viewBox="0 0 20 20"
                fill="currentColor"
              >
                <path fillRule="evenodd" d="M5.293 7.293a1 1 0 011.414 0L10 10.586l3.293-3.293a1 1 0 111.414 1.414l-4 4a1 1 0 01-1.414 0l-4-4a1 1 0 010-1.414z" clipRule="evenodd" />
              </svg>
            </button>
          </div>
        </div>

        {/* Cells — always iterate columns so collapsed-column stubs stay aligned */}
        {columns.map((col, colIdx) => {
          const cellCards = cards.filter((c) => c.column === col.id);
          const cellCount = cellCards.length;
          const cellWidth = colWidths?.get(col.id) ?? 220;

          // Interactive cell separator — drag resizes the column to the left
          const handleSepMouseDown = setColumnWidth
            ? (e: React.MouseEvent) => {
                e.preventDefault();
                const startX = e.clientX;
                const startWidth = cellWidth;
                let dragging = false;
                const onMove = (ev: MouseEvent) => {
                  const delta = ev.clientX - startX;
                  if (!dragging && Math.abs(delta) > 4) dragging = true;
                  if (dragging) setColumnWidth(col.id, startWidth + delta);
                };
                const onUp = () => {
                  window.removeEventListener("mousemove", onMove);
                  window.removeEventListener("mouseup", onUp);
                };
                window.addEventListener("mousemove", onMove);
                window.addEventListener("mouseup", onUp);
              }
            : undefined;

          const sep = (
            <div
              key={`sep-${col.id}`}
              className={`shrink-0 flex items-stretch select-none ${setColumnWidth ? "cursor-col-resize" : ""}`}
              style={{ width: 16 }}
              onMouseDown={handleSepMouseDown}
            >
              <div className="w-px self-stretch bg-slate-600/70" />
              <div className="flex-1 bg-slate-900/70" />
              <div className="w-px self-stretch bg-slate-600/70" />
            </div>
          );

          // Hidden by view prefs — show a narrow placeholder to preserve grid alignment
          if (hiddenColumnIds?.has(col.id)) {
            return (
              <div key={col.id} className="contents">
                {sep}
                <div className="w-10 shrink-0 flex items-center justify-center py-1">
                  {cellCount > 0 && (
                    <span className="text-xs text-slate-600 font-medium">{cellCount}</span>
                  )}
                </div>
              </div>
            );
          }

          if (collapsedColumnIds.has(col.id)) {
            // Collapsed column: show per-swimlane card count
            return (
              <div key={col.id} className="contents">
                {sep}
                <div className="w-10 shrink-0 flex items-center justify-center py-1">
                  {cellCount > 0 && (
                    <span className="text-xs text-slate-400 font-medium">{cellCount}</span>
                  )}
                </div>
              </div>
            );
          }

          if (collapsed) {
            // Swimlane collapsed, non-collapsed column: show hidden count placeholder
            return (
              <div key={col.id} className="contents">
                {sep}
                <div
                  style={{ width: cellWidth }}
                  className="shrink-0 flex items-center justify-center"
                >
                  {cellCount > 0 && (
                    <span className="text-xs text-slate-400 italic">{cellCount} hidden</span>
                  )}
                </div>
              </div>
            );
          }

          return (
            <div key={col.id} className="contents">
              {sep}
              <BoardCell
                column={col}
                swimlane={swimlane}
                cards={cellCards.sort((a, b) => a.position - b.position)}
                boardId={boardId}
                canEdit={canEdit}
                closeEditorOnEnter={closeEditorOnEnter}
                filteredCardIds={filteredCardIds}
                selectedCardIds={selectedCardIds}
                highlightedCardId={highlightedCardId}
                onToggleCardSelection={onToggleCardSelection}
                onCardClick={onCardClick}
                onCardAdded={onCardAdded}
                hideLabels={hideLabels}
                hideDueDate={hideDueDate}
                hideAssignee={hideAssignee}
                hidePriority={hidePriority}
                userTimezone={userTimezone}
                userDateFormat={userDateFormat}
                width={cellWidth}
              />
            </div>
          );
        })}
        {/* Trailing separator to match header's trailing ColumnSeparator */}
        <div className="shrink-0 flex items-stretch" style={{ width: 16 }}>
          <div className="w-px self-stretch bg-slate-600/70" />
          <div className="flex-1 bg-slate-900/70" />
          <div className="w-px self-stretch bg-slate-600/70" />
        </div>
        {/* Bottom resize handle — drag to set row min-height */}
        {setSwimlaneHeight && (
          <div
            className="absolute bottom-0 left-0 right-0 h-1.5 cursor-row-resize hover:bg-blue-400/20 transition-colors group/resize"
            onMouseDown={handleHeightResizeStart}
          >
            <div className="absolute bottom-0 left-0 right-0 h-px bg-blue-400/0 group-hover/resize:bg-blue-400/40 transition-colors" />
          </div>
        )}
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
