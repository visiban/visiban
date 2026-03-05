import { useState } from "react";
import type { Card, Column, Customer } from "../../types";
import BoardCell from "./BoardCell";

interface Props {
  customer: Customer;
  columns: Column[];
  cards: Card[];
  boardId: number;
  collapsedColumnIds: Set<number>;
  onCardClick: (card: Card) => void;
  onCardAdded: (card: Card) => void;
}

export default function SwimlaneRow({ customer, columns, cards, boardId, collapsedColumnIds, onCardClick, onCardAdded }: Props) {
  const [collapsed, setCollapsed] = useState(customer.is_collapsed);

  return (
    <div className="flex border-b border-gray-200 even:bg-gray-50 odd:bg-white">
      {/* Customer label — sticky to the left */}
      <div className="w-[220px] shrink-0 flex items-start gap-2 px-3 py-3 sticky left-0 z-10 bg-gray-800 border-r border-gray-700">
        <span
          className="w-1 self-stretch rounded-full shrink-0"
          style={{ backgroundColor: customer.color }}
        />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold text-white truncate">{customer.name}</p>
          <p className="text-xs text-gray-400 truncate">{customer.contact_email}</p>
        </div>
        <button
          onClick={() => setCollapsed((c) => !c)}
          className="text-gray-400 hover:text-white transition text-xs mt-0.5 shrink-0"
          title={collapsed ? "Expand" : "Collapse"}
        >
          {collapsed ? "▶" : "▼"}
        </button>
      </div>

      {/* Cells — direct children so widths match the header exactly */}
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
                customer={customer}
                cards={cards.filter((c) => c.column === col.id).sort((a, b) => a.position - b.position)}
                boardId={boardId}
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
  );
}
