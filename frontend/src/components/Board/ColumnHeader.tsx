import type { Column } from "../../types";

interface Props {
  column: Column;
  cardCount: number;
}

export default function ColumnHeader({ column, cardCount }: Props) {
  const overLimit = column.wip_limit !== null && cardCount > column.wip_limit;

  return (
    <div className="flex-1 min-w-[200px] px-3 py-3 border-r border-gray-200 bg-gray-50">
      <div className="flex items-center gap-2">
        <span
          className="w-2.5 h-2.5 rounded-full shrink-0"
          style={{ backgroundColor: column.color }}
        />
        <span className="font-semibold text-gray-700 text-sm truncate">{column.name}</span>
        <span
          className={`ml-auto text-xs font-medium px-1.5 py-0.5 rounded-full ${
            overLimit
              ? "bg-red-100 text-red-700"
              : "bg-gray-200 text-gray-500"
          }`}
        >
          {column.wip_limit !== null ? `${cardCount}/${column.wip_limit}` : cardCount}
        </span>
      </div>
    </div>
  );
}
