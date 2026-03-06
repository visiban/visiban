import { useEffect, useState } from "react";
import { getCardMovements, getCardActivities } from "../../api/cards";
import type { CardActivity, CardMovement } from "../../types";
import { userDisplayName } from "../../types";

interface Props {
  boardId: number;
  cardId: number;
}

type TimelineEntry =
  | { kind: "move"; ts: number; data: CardMovement }
  | { kind: "activity"; ts: number; data: CardActivity };

function formatDuration(ms: number): string {
  const minutes = Math.floor(ms / 60000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

function activityLabel(a: CardActivity): { line1: string; detail?: string } {
  switch (a.event_type) {
    case "priority_change":
      return { line1: `Priority: ${a.from_value} → ${a.to_value}` };
    case "weight_change":
      return { line1: `Weight: ${a.from_value} → ${a.to_value}` };
    case "assignee_change":
      return { line1: `Assignee: ${a.from_value} → ${a.to_value}` };
    case "label_change":
      return { line1: `Labels: ${a.to_value}` };
    case "description_change":
      return { line1: "Description updated" };
    case "comment_added":
      return { line1: "Comment added" };
    case "attachment_added":
      return { line1: `Attached: ${a.to_value || "file"}` };
    case "attachment_deleted":
      return { line1: `Removed: ${a.from_value || "file"}` };
    default:
      return { line1: (a.event_type as string).replace(/_/g, " ") };
  }
}

export default function CardMovementTimeline({ boardId, cardId }: Props) {
  const [entries, setEntries] = useState<TimelineEntry[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      getCardMovements(boardId, cardId),
      getCardActivities(boardId, cardId),
    ]).then(([movements, activities]) => {
      const combined: TimelineEntry[] = [
        ...movements.map((m) => ({ kind: "move" as const, ts: new Date(m.moved_at).getTime(), data: m })),
        ...activities.map((a) => ({ kind: "activity" as const, ts: new Date(a.created_at).getTime(), data: a })),
      ];
      combined.sort((a, b) => b.ts - a.ts);
      setEntries(combined);
    }).finally(() => setLoading(false));
  }, [boardId, cardId]);

  if (loading) return <p className="text-sm text-gray-400">Loading history…</p>;
  if (entries.length === 0) return <p className="text-sm text-gray-400">No activity yet.</p>;

  // For move entries, find the next move to compute time spent
  const moves = entries.filter((e) => e.kind === "move").map((e) => e.data as CardMovement);

  return (
    <ol className="relative border-l border-gray-200 ml-2">
      {entries.map((entry) => {
        if (entry.kind === "move") {
          const m = entry.data as CardMovement;
          const moveIndex = moves.findIndex((mv) => mv.id === m.id);
          const nextMove = moves[moveIndex + 1];
          const duration = nextMove
            ? formatDuration(new Date(m.moved_at).getTime() - new Date(nextMove.moved_at).getTime())
            : null;
          const actor = m.moved_by ? (userDisplayName(m.moved_by)) : null;

          return (
            <li key={`move-${m.id}`} className="relative mb-3 ml-4">
              <span className="absolute -left-[1.375rem] top-1/2 -translate-y-1/2 w-3 h-3 rounded-full bg-blue-500 border-2 border-white shadow" />
              <div className="bg-white border border-gray-100 rounded-lg px-3 py-2.5 flex flex-col gap-1 shadow-sm">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-sm font-medium text-gray-700">
                    {m.from_column_name} → {m.to_column_name}
                  </span>
                  {m.from_customer_name && m.to_customer_name && m.from_customer_name !== m.to_customer_name && (
                    <span className="text-xs text-gray-400">({m.from_customer_name} → {m.to_customer_name})</span>
                  )}
                  {actor && <span className="text-xs text-gray-400 ml-auto shrink-0">by {actor}</span>}
                </div>
                <div className="flex items-center gap-2">
                  <time className="text-xs text-gray-400">{new Date(m.moved_at).toLocaleString()}</time>
                  {duration && <span className="text-xs text-blue-500 ml-auto shrink-0">Spent {duration} here</span>}
                </div>
              </div>
            </li>
          );
        }

        const a = entry.data as CardActivity;
        const { line1 } = activityLabel(a);
        const actor = a.actor ? (userDisplayName(a.actor)) : null;

        return (
          <li key={`activity-${a.id}`} className="relative mb-3 ml-4">
            <span className="absolute -left-[1.375rem] top-1/2 -translate-y-1/2 w-3 h-3 rounded-full bg-gray-300 border-2 border-white shadow" />
            <div className="bg-white border border-gray-100 rounded-lg px-3 py-2.5 flex flex-col gap-1 shadow-sm">
              <div className="flex items-center gap-2">
                <span className="text-sm text-gray-700">{line1}</span>
                {actor && <span className="text-xs text-gray-400 ml-auto shrink-0">by {actor}</span>}
              </div>
              <time className="text-xs text-gray-400">{new Date(a.created_at).toLocaleString()}</time>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
