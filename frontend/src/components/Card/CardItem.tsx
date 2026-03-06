import { useDraggable } from "@dnd-kit/core";
import type { Card } from "../../types";

const PRIORITY_COLORS: Record<string, string> = {
  low: "#6B7280",
  medium: "#3B82F6",
  high: "#F59E0B",
  urgent: "#EF4444",
};

interface Props {
  card: Card;
  onClick?: () => void;
  overlay?: boolean;
}

export default function CardItem({ card, onClick, overlay }: Props) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: card.id });

  const isRecent = card.last_moved_at
    ? Date.now() - new Date(card.last_moved_at).getTime() < 24 * 60 * 60 * 1000
    : false;

  return (
    <div
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      onClick={onClick}
      className={`aspect-square bg-white rounded-lg shadow-sm border border-gray-200 cursor-pointer hover:shadow-md transition select-none flex flex-col overflow-hidden ${
        isDragging && !overlay ? "opacity-30" : ""
      } ${overlay ? "shadow-xl rotate-2 opacity-95" : ""}`}
    >
      {/* Priority strip */}
      <div className="h-1 shrink-0" style={{ backgroundColor: PRIORITY_COLORS[card.priority] ?? "#6B7280" }} />

      <div className="p-2 flex flex-col gap-1.5 flex-1">
        {/* Title */}
        <p className="text-xs text-gray-800 font-medium leading-snug line-clamp-3">{card.title}</p>

        {/* Footer row */}
        <div className="flex items-center justify-between mt-auto gap-1">
          {/* Label dots + attachment count + checklist progress */}
          <div className="flex items-center gap-1 flex-wrap">
            {card.labels.slice(0, 4).map((label) => (
              <span
                key={label.id}
                className="w-2 h-2 rounded-full shrink-0"
                style={{ backgroundColor: label.color }}
                title={label.name}
              />
            ))}
            {card.checklist_total > 0 && (
              <span
                className={`flex items-center gap-0.5 text-xs font-medium ${card.checklist_done === card.checklist_total ? "text-green-500" : "text-gray-400"}`}
                title={`${card.checklist_done}/${card.checklist_total} checklist items done`}
              >
                ✓ {card.checklist_done}/{card.checklist_total}
              </span>
            )}
            {card.attachment_count > 0 && (
              <span
                className="flex items-center gap-0.5 text-xs text-gray-400"
                title={`${card.attachment_count} attachment${card.attachment_count !== 1 ? "s" : ""}`}
              >
                <svg className="w-3 h-3" viewBox="0 0 16 16" fill="currentColor">
                  <path d="M4.5 3a2.5 2.5 0 0 1 5 0v9a1.5 1.5 0 0 1-3 0V5a.5.5 0 0 1 1 0v7a.5.5 0 0 0 1 0V3a1.5 1.5 0 1 0-3 0v9a2.5 2.5 0 0 0 5 0V5a.5.5 0 0 1 1 0v7a3.5 3.5 0 1 1-7 0z"/>
                </svg>
                {card.attachment_count}
              </span>
            )}
          </div>

          <div className="flex items-center gap-1 shrink-0">
            {isRecent && (
              <span className="w-1.5 h-1.5 rounded-full bg-blue-400" title="Recently moved" />
            )}
            <span className="text-xs text-gray-400 font-medium" title="Weight">
              {card.weight}
            </span>
          </div>
        </div>

        {/* Due date */}
        {card.due_date && (
          <p className="text-xs text-gray-400 leading-none">{card.due_date}</p>
        )}
      </div>
    </div>
  );
}
