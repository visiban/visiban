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
  onInsertAbove?: () => void;
  onInsertBelow?: () => void;
  sidebarWidth?: number;
  onResizeStart?: (e: React.MouseEvent) => void;
  colWidths?: Map<number, number>;
  hideLabels?: boolean;
  hideDueDate?: boolean;
  hideAssignee?: boolean;
  hidePriority?: boolean;
  userTimezone?: string;
  userDateFormat?: string;
}

export default function SwimlaneRow({ swimlane, columns, cards, boardId, isAdmin, canEdit, closeEditorOnEnter, collapsedColumnIds, hiddenColumnIds, filteredCardIds, selectedCardIds, highlightedCardId, onToggleCardSelection, onCardClick, onCardAdded, onSwimlaneUpdated, onSwimlaneDeleted, onInsertAbove, onInsertBelow, sidebarWidth, onResizeStart, colWidths, hideLabels, hideDueDate, hideAssignee, hidePriority, userTimezone, userDateFormat }: Props) {
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
        <div
          className="shrink-0 flex items-start gap-2 pl-1 pr-3 py-3 sticky left-0 z-10 bg-slate-800 border-r border-slate-700 border-l-[3px] group relative"
          style={{ width: sidebarWidth ?? 220, borderLeftColor: swimlane.color || "transparent" }}
        >
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
              className="text-slate-600 hover:text-slate-300 cursor-grab active:cursor-grabbing text-sm select-none shrink-0 mt-0.5"
              title="Drag to reorder"
            >
              ⠿
            </span>
          )}

          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold text-white truncate">{swimlane.name}</p>
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

          {/* Resize handle — right edge of sidebar */}
          {onResizeStart && (
            <div
              onMouseDown={onResizeStart}
              className="absolute right-0 top-0 bottom-0 w-2 cursor-col-resize flex items-center justify-center group/resize hover:bg-blue-500/20 active:bg-blue-500/30 transition-colors z-20"
              title="Drag to resize"
            >
              <div className="w-0.5 h-6 rounded-full bg-slate-600/0 group-hover/resize:bg-blue-400 transition-colors" />
            </div>
          )}
        </div>

        {/* Cells — always iterate columns so collapsed-column stubs stay aligned */}
        {columns.map((col) => {
          const cellCards = cards.filter((c) => c.column === col.id);
          const cellCount = cellCards.length;
          const cellWidth = colWidths?.get(col.id) ?? 220;

          // Hidden by view prefs — show a narrow placeholder to preserve grid alignment
          if (hiddenColumnIds?.has(col.id)) {
            return (
              <div
                key={col.id}
                className="w-10 shrink-0 border-r border-slate-700 flex items-center justify-center py-1"
              >
                {cellCount > 0 && (
                  <span className="text-xs text-slate-600 font-medium">{cellCount}</span>
                )}
              </div>
            );
          }

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
                style={{ width: cellWidth }}
                className="shrink-0 border-r border-slate-700 flex items-center justify-center"
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
