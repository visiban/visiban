import { useDraggable } from "@dnd-kit/core";
import type { Card } from "../../types";
import { userDisplayName } from "../../types";
import { PRIORITY_COLORS } from "../../constants/colors";

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
  selected?: boolean;
  onSelect?: () => void;
}

export default function CardItem({ card, onClick, overlay, selected, onSelect }: Props) {
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
      className={`group bg-white rounded-md cursor-pointer select-none transition-all border shadow-sm relative z-0
        hover:shadow-lg hover:border-gray-200 hover:z-20
        ${isDragging && !overlay ? "opacity-25 shadow-none" : ""}
        ${overlay ? "shadow-xl rotate-1 opacity-95" : ""}
        ${selected ? "ring-2 ring-blue-400 border-blue-200 bg-blue-50/30" : card.is_stale ? "ring-1 ring-inset ring-amber-300 border-gray-100" : "border-gray-100"}
      `}
      style={{ borderLeft: `3px solid ${priorityColor}` }}
    >
      {onSelect && (
        <div
          className={`absolute top-1 right-1 w-4 h-4 rounded border flex items-center justify-center cursor-pointer transition z-10
            ${selected ? "bg-blue-500 border-blue-500 text-white opacity-100" : "border-gray-300 bg-white opacity-0 group-hover:opacity-100"}
          `}
          onClick={(e) => { e.stopPropagation(); e.preventDefault(); onSelect(); }}
          onPointerDown={(e) => e.stopPropagation()}
        >
          {selected && (
            <svg className="w-2.5 h-2.5" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M2 6l3 3 5-5" />
            </svg>
          )}
        </div>
      )}
      <div className="px-2.5 py-2">
        <p className="text-xs font-medium text-gray-800 leading-snug line-clamp-2">{card.title}</p>

        {/* Description — revealed on hover */}
        {card.description && (
          <div className="overflow-hidden max-h-0 group-hover:max-h-20 transition-all duration-150 ease-out">
            <p className="text-[10px] text-gray-400 leading-relaxed line-clamp-4 mt-1.5 border-t border-gray-50 pt-1.5">
              {card.description}
            </p>
          </div>
        )}

        {hasMetadata && (
          <div className="flex items-center gap-1 mt-1.5 overflow-hidden group-hover:overflow-visible group-hover:flex-wrap">
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

            {/* Stale indicator */}
            {card.is_stale && (
              <span title="Stale — no movement recently" className="text-amber-400 text-[10px] leading-none shrink-0">⏱</span>
            )}

            {/* Recently moved dot — visible on hover only */}
            {isRecent && !card.is_stale && (
              <span className="w-1.5 h-1.5 rounded-full bg-blue-400 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity" title="Recently moved" />
            )}

            {/* Priority label — visible on hover */}
            <span
              className="text-[9px] font-semibold opacity-0 group-hover:opacity-100 transition-opacity shrink-0 capitalize"
              style={{ color: priorityColor }}
            >
              {card.priority}
            </span>

            {/* Assignee initials — pushed to end via margin */}
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
