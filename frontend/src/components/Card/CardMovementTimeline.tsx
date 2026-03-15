import { useEffect, useState } from "react";
import { getCardMovements, getCardActivities } from "../../api/cards";
import type { CardActivity, CardMovement } from "../../types";
import { userDisplayName } from "../../types";
import { formatDateTime } from "../../utils/date";

interface Props {
  boardId: number;
  cardId: number;
  columnIds?: Set<number>;
  userDateFormat?: string;
  userTimeFormat?: string;
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
    case "title_change":
      return { line1: `Renamed: "${a.from_value}" → "${a.to_value}"` };
    case "description_change":
      return { line1: "Description updated" };
    case "comment_added":
      return { line1: "Comment added" };
    case "attachment_added":
      return { line1: `Attached: ${a.to_value || "file"}` };
    case "attachment_deleted":
      return { line1: `Removed: ${a.from_value || "file"}` };
    case "checklist_item_added":
      return { line1: `Added checklist item: "${a.to_value}"` };
    case "checklist_item_checked":
      return { line1: `Checked: "${a.to_value}"` };
    case "checklist_item_unchecked":
      return { line1: `Unchecked: "${a.to_value}"` };
    case "checklist_item_deleted":
      return { line1: `Removed checklist item: "${a.from_value}"` };
    default:
      return { line1: (a.event_type as string).replace(/_/g, " ") };
  }
}

function ColumnName({ id, name, columnIds }: { id: number | null; name: string | null; columnIds?: Set<number> }) {
  if (!name) return <></>;

  // Deleted if FK was nulled out (id=null) but name was preserved,
  // or FK still set but column no longer in the live board.
  const isDeleted =
    (id === null && name !== "") ||
    (id !== null && columnIds !== undefined && !columnIds.has(id));
  if (isDeleted) {
    return <span className="italic text-red-400" title="This column has been deleted">Deleted — {name}</span>;
  }
  return <>{name}</>;
}

export default function CardMovementTimeline({ boardId, cardId, columnIds, userDateFormat = "MM/DD/YYYY", userTimeFormat = "12h" }: Props) {
  const [entries, setEntries] = useState<TimelineEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAll, setShowAll] = useState(false);

  useEffect(() => {
    Promise.all([
      getCardMovements(boardId, cardId),
      getCardActivities(boardId, cardId),
    ]).then(([movements, activities]) => {
      const combined: TimelineEntry[] = [
        ...movements.map((m) => ({ kind: "move" as const, ts: new Date(m.moved_at).getTime(), data: m })),
        ...activities.map((a) => ({ kind: "activity" as const, ts: new Date(a.created_at).getTime(), data: a })),
      ];
      combined.sort((a, b) => a.ts - b.ts);
      setEntries(combined);
    }).finally(() => setLoading(false));
  }, [boardId, cardId]);

  if (loading) return <p className="text-sm text-slate-400">Loading history…</p>;
  if (entries.length === 0) return <p className="text-sm text-slate-400">No activity yet.</p>;

  const visible = showAll ? entries : entries.filter((e) => e.kind === "move");

  // All move entries in chronological order, for time-spent calculation
  const moves = entries.filter((e) => e.kind === "move").map((e) => e.data as CardMovement);

  return (
    <div>
      <div className="flex items-center justify-end mb-3">
        <label className="flex items-center gap-1.5 text-xs text-slate-400 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={showAll}
            onChange={(e) => setShowAll(e.target.checked)}
            className="rounded border-slate-600"
          />
          Show full history
        </label>
      </div>

      <ol className="relative border-l border-slate-700 ml-2">
        {visible.map((entry) => {
          if (entry.kind === "move") {
            const m = entry.data as CardMovement;
            const actor = m.moved_by ? userDisplayName(m.moved_by) : null;

            if (m.from_column === null) {
              return (
                <li key={`move-${m.id}`} className="relative mb-3 ml-4">
                  <span className="absolute -left-[1.375rem] top-1/2 -translate-y-1/2 w-3 h-3 rounded-full bg-green-500 border-2 border-slate-800 shadow" />
                  <div className="bg-slate-800 border border-slate-700 rounded-lg px-3 py-2.5 flex flex-col gap-1 shadow-sm">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-slate-300">Created in <ColumnName id={m.to_column} name={m.to_column_name} columnIds={columnIds} /></span>
                      {actor && <span className="text-xs text-slate-400 ml-auto shrink-0">by {actor}</span>}
                    </div>
                    <time className="text-xs text-slate-400">{formatDateTime(m.moved_at, userDateFormat, userTimeFormat)}</time>
                  </div>
                </li>
              );
            }

            const moveIndex = moves.findIndex((mv) => mv.id === m.id);
            const nextMove = moves[moveIndex + 1];
            // Oldest-first: next move is chronologically later, so subtract current from next
            const duration = nextMove
              ? formatDuration(new Date(nextMove.moved_at).getTime() - new Date(m.moved_at).getTime())
              : null;

            return (
              <li key={`move-${m.id}`} className="relative mb-3 ml-4">
                <span className="absolute -left-[1.375rem] top-1/2 -translate-y-1/2 w-3 h-3 rounded-full bg-blue-500 border-2 border-slate-800 shadow" />
                <div className="bg-slate-800 border border-slate-700 rounded-lg px-3 py-2.5 flex flex-col gap-1 shadow-sm">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-medium text-slate-300">
                      <ColumnName id={m.from_column} name={m.from_column_name} columnIds={columnIds} />
                      {" → "}
                      <ColumnName id={m.to_column} name={m.to_column_name} columnIds={columnIds} />
                    </span>
                    {m.from_swimlane_name && m.to_swimlane_name && m.from_swimlane_name !== m.to_swimlane_name && (
                      <span className="text-xs text-slate-400">({m.from_swimlane_name} → {m.to_swimlane_name})</span>
                    )}
                    {actor && <span className="text-xs text-slate-400 ml-auto shrink-0">by {actor}</span>}
                  </div>
                  <div className="flex items-center gap-2">
                    <time className="text-xs text-slate-400">{formatDateTime(m.moved_at, userDateFormat, userTimeFormat)}</time>
                    {duration && <span className="text-xs text-blue-500 ml-auto shrink-0">Spent {duration} here</span>}
                  </div>
                </div>
              </li>
            );
          }

          const a = entry.data as CardActivity;
          const { line1 } = activityLabel(a);
          const actor = a.actor ? userDisplayName(a.actor) : null;

          return (
            <li key={`activity-${a.id}`} className="relative mb-3 ml-4">
              <span className="absolute -left-[1.375rem] top-1/2 -translate-y-1/2 w-3 h-3 rounded-full bg-slate-500 border-2 border-slate-800 shadow" />
              <div className="bg-slate-800 border border-slate-700 rounded-lg px-3 py-2.5 flex flex-col gap-1 shadow-sm">
                <div className="flex items-center gap-2">
                  <span className="text-sm text-slate-300">{line1}</span>
                  {actor && <span className="text-xs text-slate-400 ml-auto shrink-0">by {actor}</span>}
                </div>
                <time className="text-xs text-slate-400">{formatDateTime(a.created_at, userDateFormat, userTimeFormat)}</time>
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
