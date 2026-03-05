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
      className={`bg-white rounded-lg shadow-sm border-l-4 px-3 py-2 cursor-pointer hover:shadow-md transition select-none ${
        isDragging && !overlay ? "opacity-30" : ""
      } ${overlay ? "shadow-xl rotate-2 opacity-95" : ""}`}
      style={{ borderLeftColor: PRIORITY_COLORS[card.priority] ?? "#6B7280" }}
    >
      <div className="flex items-start gap-1.5">
        <p className="text-sm text-gray-800 font-medium flex-1 leading-snug">{card.title}</p>
        {isRecent && (
          <span className="w-2 h-2 rounded-full bg-blue-400 shrink-0 mt-1" title="Recently moved" />
        )}
      </div>

      <div className="flex items-center gap-2 mt-1.5 flex-wrap">
        {card.labels.map((label) => (
          <span
            key={label.id}
            className="text-xs px-1.5 py-0.5 rounded-full text-white font-medium"
            style={{ backgroundColor: label.color }}
          >
            {label.name}
          </span>
        ))}
        {card.due_date && (
          <span className="text-xs text-gray-400 ml-auto">{card.due_date}</span>
        )}
        {card.assignee && (
          <span className="text-xs bg-gray-100 text-gray-600 rounded-full px-1.5 py-0.5">
            {card.assignee.first_name || card.assignee.username}
          </span>
        )}
      </div>
    </div>
  );
}
