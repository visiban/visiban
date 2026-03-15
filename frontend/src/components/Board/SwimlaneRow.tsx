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

export default function SwimlaneRow({ swimlane, columns, cards, boardId, isAdmin, canEdit, closeEditorOnEnter, collapsedColumnIds, hiddenColumnIds, filteredCardIds, selectedCardIds, highlightedCardId, onToggleCardSelection, onCardClick, onCardAdded, onSwimlaneUpdated, onSwimlaneDeleted, sidebarWidth, onResizeStart, colWidths, hideLabels, hideDueDate, hideAssignee, hidePriority, userTimezone, userDateFormat }: Props) {
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
        </div>

        {/* Cells — always iterate columns so collapsed-column stubs stay aligned */}
        {columns.map((col, colIdx) => {
          const cellCards = cards.filter((c) => c.column === col.id);
          const cellCount = cellCards.length;
          const cellWidth = colWidths?.get(col.id) ?? 220;

          // Visual cell separator matching column separator in header (no interaction)
          const sep = (
            <div key={`sep-${col.id}`} className="shrink-0 flex items-stretch" style={{ width: 16 }}>
              <div className="w-px self-stretch bg-slate-700" />
              <div className="flex-1" />
              <div className="w-px self-stretch bg-slate-700" />
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
