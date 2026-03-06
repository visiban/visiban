import { useState } from "react";
import type { Card, Column, Swimlane } from "../../types";
import BoardCell from "./BoardCell";
import EditSwimlaneModal from "./EditSwimlaneModal";

interface Props {
  swimlane: Swimlane;
  columns: Column[];
  cards: Card[];
  boardId: number;
  collapsedColumnIds: Set<number>;
  filteredCardIds: Set<number> | null;
  onCardClick: (card: Card) => void;
  onCardAdded: (card: Card) => void;
  onSwimlaneUpdated: (swimlane: Swimlane) => void;
  onSwimlaneDeleted: (swimlaneId: number) => void;
}

export default function SwimlaneRow({ swimlane, columns, cards, boardId, collapsedColumnIds, filteredCardIds, onCardClick, onCardAdded, onSwimlaneUpdated, onSwimlaneDeleted }: Props) {
  const [collapsed, setCollapsed] = useState(swimlane.is_collapsed);
  const [editing, setEditing] = useState(false);

  return (
    <>
      <div className="flex border-b border-gray-200 even:bg-gray-50 odd:bg-white">
        {/* Swimlane label — sticky to the left */}
        <div className="w-[220px] shrink-0 flex items-start gap-2 px-3 py-3 sticky left-0 z-10 bg-gray-800 border-r border-gray-700 group">
          {/* Color stripe */}
          <span className="w-1 self-stretch rounded-full shrink-0" style={{ backgroundColor: swimlane.color }} />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold text-white truncate">{swimlane.name}</p>
            <p className="text-xs text-gray-400 truncate">{swimlane.contact_email}</p>
          </div>
          <div className="flex items-center gap-1 shrink-0">
            <button
              onClick={() => setEditing(true)}
              className="text-gray-500 hover:text-white transition text-xs opacity-0 group-hover:opacity-100"
              title="Edit swimlane"
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
        </div>

        {/* Cells */}
        {collapsed ? (
          <div className="flex items-center px-4 text-sm text-gray-400 italic">
            {cards.length} card{cards.length !== 1 ? "s" : ""} hidden
          </div>
        ) : (
          <>
            {columns.map((col) =>
              collapsedColumnIds.has(col.id) ? (
                <div key={col.id} className="w-10 shrink-0 border-r border-gray-100" />
              ) : (
                <BoardCell
                  key={col.id}
                  column={col}
                  swimlane={swimlane}
                  cards={cards.filter((c) => c.column === col.id).sort((a, b) => a.position - b.position)}
                  boardId={boardId}
                  filteredCardIds={filteredCardIds}
                  onCardClick={onCardClick}
                  onCardAdded={onCardAdded}
                />
              )
            )}
            {/* Spacer matching the fixed-width "+ Col" button in the header */}
            <div className="w-20 shrink-0" />
          </>
        )}
      </div>

      {editing && (
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
