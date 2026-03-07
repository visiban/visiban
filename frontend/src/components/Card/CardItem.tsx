import { useDraggable } from "@dnd-kit/core";
import type { Card } from "../../types";
import { userDisplayName } from "../../types";

const PRIORITY_COLORS: Record<string, string> = {
  low:    "#6B7280",
  medium: "#3B82F6",
  high:   "#F59E0B",
  urgent: "#EF4444",
};

function formatDueDate(iso: string): { label: string; overdue: boolean } {
  const d = new Date(iso);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const diff = Math.round((d.getTime() - today.getTime()) / 86_400_000);
  if (diff < 0)  return { label: `${Math.abs(diff)}d late`, overdue: true };
  if (diff === 0) return { label: "Today", overdue: false };
  if (diff === 1) return { label: "Tomorrow", overdue: false };
  if (diff < 7)  return { label: `${diff}d`, overdue: false };
  return { label: d.toLocaleDateString(undefined, { month: "short", day: "numeric" }), overdue: false };
}

function initials(name: string) {
  return name.split(" ").map((w) => w[0]).slice(0, 2).join("").toUpperCase();
}

interface Props {
  card: Card;
  onClick?: () => void;
  overlay?: boolean;
}

export default function CardItem({ card, onClick, overlay }: Props) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: card.id });

  const isRecent = card.last_moved_at
    ? Date.now() - new Date(card.last_moved_at).getTime() < 86_400_000
    : false;

  const dueInfo = card.due_date ? formatDueDate(card.due_date) : null;
  const priorityColor = PRIORITY_COLORS[card.priority] ?? "#6B7280";
  const assigneeName = card.assignee ? userDisplayName(card.assignee) : null;

  const hasMetadata =
    card.labels.length > 0 ||
    card.checklist_total > 0 ||
    card.attachment_count > 0 ||
    dueInfo ||
    assigneeName ||
    card.weight > 1 ||
    card.is_stale ||
    isRecent;

  return (
    <div
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      onClick={onClick}
      className={`group bg-white rounded-md cursor-pointer select-none transition-all border border-gray-100 shadow-sm
        hover:shadow-md hover:border-gray-200
        ${isDragging && !overlay ? "opacity-25 shadow-none" : ""}
        ${overlay ? "shadow-xl rotate-1 opacity-95" : ""}
        ${card.is_stale ? "ring-1 ring-inset ring-amber-300" : ""}
      `}
      style={{ borderLeft: `3px solid ${priorityColor}` }}
    >
      <div className="px-2.5 py-2">
        <p className="text-xs font-medium text-gray-800 leading-snug line-clamp-2">{card.title}</p>

        {hasMetadata && (
          <div className="flex items-center gap-1.5 mt-1.5 min-w-0">
            {/* Label pills */}
            {card.labels.slice(0, 3).map((label) => {
              const display = label.name.length > 4 ? label.name.slice(0, 2).toUpperCase() : label.name;
              return (
                <span
                  key={label.id}
                  className="text-[9px] font-semibold px-1 py-0.5 rounded leading-none shrink-0"
                  style={{ backgroundColor: label.color + "22", color: label.color, border: `1px solid ${label.color}44` }}
                  title={label.name}
                >
                  {display}
                </span>
              );
            })}
            {card.labels.length > 3 && (
              <span className="text-[9px] text-gray-400 shrink-0">+{card.labels.length - 3}</span>
            )}

            {/* Checklist */}
            {card.checklist_total > 0 && (
              <span
                className={`text-[10px] font-medium shrink-0 ${
                  card.checklist_done === card.checklist_total ? "text-green-500" : "text-gray-400"
                }`}
                title={`${card.checklist_done}/${card.checklist_total} checklist items`}
              >
                ✓{card.checklist_done}/{card.checklist_total}
              </span>
            )}

            {/* Attachments */}
            {card.attachment_count > 0 && (
              <span className="text-[10px] text-gray-400 shrink-0" title={`${card.attachment_count} attachment(s)`}>
                📎{card.attachment_count}
              </span>
            )}

            <span className="flex-1 min-w-0" />

            {/* Stale indicator */}
            {card.is_stale && (
              <span title="Stale — no movement recently" className="text-amber-400 text-[10px] leading-none shrink-0">⏱</span>
            )}

            {/* Recently moved dot — visible on hover only */}
            {isRecent && !card.is_stale && (
              <span className="w-1.5 h-1.5 rounded-full bg-blue-400 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity" title="Recently moved" />
            )}

            {/* Due date */}
            {dueInfo && (
              <span
                className={`text-[10px] font-medium shrink-0 ${dueInfo.overdue ? "text-red-500" : "text-gray-400"}`}
                title={`Due ${card.due_date}`}
              >
                {dueInfo.label}
              </span>
            )}

            {/* Weight (only shown when > 1) */}
            {card.weight > 1 && (
              <span className="text-[10px] text-gray-300 font-medium shrink-0" title={`Weight: ${card.weight}`}>
                {card.weight}
              </span>
            )}

            {/* Assignee initials */}
            {assigneeName && (
              <span
                className="w-4 h-4 rounded-full bg-indigo-100 text-indigo-600 text-[8px] font-bold flex items-center justify-center shrink-0"
                title={assigneeName}
              >
                {initials(assigneeName)}
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
