import { useState } from "react";
import type { Card, Column } from "../../types";
import EditColumnModal from "./EditColumnModal";

interface Props {
  column: Column;
  cards: Card[];
  boardId: number;
  onColumnUpdated: (column: Column) => void;
}

export default function ColumnHeader({ column, cards, boardId, onColumnUpdated }: Props) {
  const [editing, setEditing] = useState(false);

  const cardCount = cards.length;
  const totalWeight = cards.reduce((sum, c) => sum + c.weight, 0);

  const overWip = column.wip_limit !== null && cardCount > column.wip_limit;
  const overWeight = column.weight_limit !== null && totalWeight > column.weight_limit;

  return (
    <>
      <div
        className="flex-1 min-w-[200px] px-3 py-3 border-r border-gray-200 bg-gray-50 group cursor-pointer hover:bg-gray-100 transition"
        onClick={() => setEditing(true)}
        title="Click to edit column"
      >
        <div className="flex items-center gap-2">
          <span
            className="w-2.5 h-2.5 rounded-full shrink-0"
            style={{ backgroundColor: column.color }}
          />
          <span className="font-semibold text-gray-700 text-sm truncate">{column.name}</span>

          <div className="ml-auto flex items-center gap-1.5 shrink-0">
            {/* WIP badge */}
            <span
              className={`text-xs font-medium px-1.5 py-0.5 rounded-full ${
                overWip ? "bg-red-100 text-red-700" : "bg-gray-200 text-gray-500"
              }`}
              title="Cards / WIP limit"
            >
              {column.wip_limit !== null ? `${cardCount}/${column.wip_limit}` : cardCount}
            </span>

            {/* Weight badge */}
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

            <span className="text-gray-300 group-hover:text-gray-500 transition text-xs">✎</span>
          </div>
        </div>
      </div>

      {editing && (
        <EditColumnModal
          boardId={boardId}
          column={column}
          onUpdated={(col) => { onColumnUpdated(col); setEditing(false); }}
          onClose={() => setEditing(false)}
        />
      )}
    </>
  );
}
