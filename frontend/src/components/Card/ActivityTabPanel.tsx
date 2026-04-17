import { useEffect, useState } from "react";
import { getCardTimeline } from "../../api/cards";
import type { CardTimelineEntry, CardActivity, CardMovement, BoardUser } from "../../types";
import { userDisplayName } from "../../types";
import { formatRelativeTime, formatDateStr } from "../../utils/date";
import ActivityFilterDropdown from "./ActivityFilterDropdown";

interface ActivityTabPanelProps {
  boardId: number;
  cardId: number;
  userDateFormat?: string;
}

const EVENT_TYPE_OPTIONS = [
  { value: "move",       label: "Column moves",  color: "#3b82f6" },
  { value: "comment",    label: "Comments",       color: "#38bdf8" },
  { value: "field",      label: "Field changes",  color: "#64748b" },
  { value: "checklist",  label: "Checklist",      color: "#64748b" },
  { value: "attachment", label: "Attachments",    color: "#14b8a6" },
  { value: "system",     label: "System events",  color: "#475569" },
] as const;

// Default filter lens — Column moves is the canonical "what happened to this
// card" signal, so the drawer opens with a focused view of moves only. Users
// can click "All" to see every event type, toggle individually, or use the
// "Reset to default" footer to return to this state.
const DEFAULT_SELECTED: string[] = ["move"];

type ChecklistEventType =
  | "checklist_item_added"
  | "checklist_item_checked"
  | "checklist_item_unchecked"
  | "checklist_item_deleted";

const CHECKLIST_EVENT_TYPES = new Set<string>([
  "checklist_item_added",
  "checklist_item_checked",
  "checklist_item_unchecked",
  "checklist_item_deleted",
]);

type ChecklistGroup = {
  kind: "checklist-group";
  ts: string;
  event_type: ChecklistEventType;
  items: string[];
  actor: BoardUser | null;
};

type DisplayEntry = CardTimelineEntry | ChecklistGroup;

const DEFAULT_LIMIT = 50;

// Collapse consecutive same-type checklist entries into a single group,
// matching the behaviour in CardMovementTimeline.
function collapseChecklistGroups(entries: CardTimelineEntry[]): DisplayEntry[] {
  const result: DisplayEntry[] = [];
  for (const entry of entries) {
    if (entry.kind !== "activity" || !CHECKLIST_EVENT_TYPES.has(entry.event_type)) {
      result.push(entry);
      continue;
    }
    const data = entry.data as unknown as CardActivity;
    const value =
      entry.event_type === "checklist_item_deleted" ? data.from_value : data.to_value;
    const last = result[result.length - 1];
    if (
      last?.kind === "checklist-group" &&
      last.event_type === (entry.event_type as ChecklistEventType)
    ) {
      last.items.push(value);
    } else {
      result.push({
        kind: "checklist-group",
        ts: entry.ts,
        event_type: entry.event_type as ChecklistEventType,
        items: [value],
        actor: entry.actor,
      });
    }
  }
  return result;
}

function actorName(actor: BoardUser | null): string | null {
  return actor ? userDisplayName(actor) : null;
}

function dotColor(entry: CardTimelineEntry | ChecklistGroup): string {
  if (entry.kind === "checklist-group") return "bg-slate-500";
  if (entry.kind === "move") {
    const data = entry.data as unknown as CardMovement;
    // Initial creation move: from_column is null
    if (data.from_column === null) return "bg-green-500";
    return "bg-blue-500";
  }
  // activity kind
  switch (entry.event_type) {
    case "comment_added":
      return "bg-sky-400";
    case "attachment_added":
    case "attachment_deleted":
      return "bg-teal-500";
    case "archived":
      return "bg-slate-600";
    case "reactivated":
      return "bg-violet-500";
    default:
      return "bg-slate-500";
  }
}

function activityLabel(
  event_type: string,
  data: Record<string, unknown>,
  userDateFormat = "MM/DD/YYYY"
): string {
  const d = data as unknown as CardActivity;
  switch (event_type) {
    case "priority_change":
      return `Priority: ${d.from_value} → ${d.to_value}`;
    case "weight_change":
      return `Weight: ${d.from_value} → ${d.to_value}`;
    case "assignee_change":
      return `Assignee: ${d.from_value} → ${d.to_value}`;
    case "label_change":
      return `Labels: ${d.to_value}`;
    case "title_change":
      return `Renamed: "${d.from_value}" → "${d.to_value}"`;
    case "description_change":
      return "Description updated";
    case "comment_added":
      return "Comment added";
    case "attachment_added":
      return `Attached: ${d.to_value || "file"}`;
    case "attachment_deleted":
      return `Removed: ${d.from_value || "file"}`;
    case "due_date_change": {
      const fmt = (iso: string) => (iso ? formatDateStr(iso, userDateFormat) : "(none)");
      return `Due date: ${fmt(d.from_value)} → ${fmt(d.to_value)}`;
    }
    case "archived":
      return "Card archived";
    case "reactivated":
      return "Card reactivated";
    default:
      return event_type.replace(/_/g, " ");
  }
}

function formatDuration(ms: number): string {
  const minutes = Math.floor(ms / 60000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

export default function ActivityTabPanel({ boardId, cardId, userDateFormat = "MM/DD/YYYY" }: ActivityTabPanelProps) {
  const [entries, setEntries] = useState<CardTimelineEntry[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [offset, setOffset] = useState(0);
  const [selectedTypes, setSelectedTypes] = useState<string[]>(DEFAULT_SELECTED);

  // Fetch a page of timeline entries and append to state.
  const fetchPage = (pageOffset: number, reset: boolean) => {
    const params: { limit: number; offset: number; event_types?: string } = {
      limit: DEFAULT_LIMIT,
      offset: pageOffset,
    };
    if (selectedTypes.length > 0) {
      params.event_types = selectedTypes.join(",");
    }

    if (reset) {
      setLoading(true);
    } else {
      setLoadingMore(true);
    }
    setError(false);

    getCardTimeline(boardId, cardId, params)
      .then((data) => {
        setTotalCount(data.count);
        setHasMore(data.next !== null);
        setEntries((prev) => (reset ? data.results : [...prev, ...data.results]));
        setOffset(pageOffset + DEFAULT_LIMIT);
      })
      .catch(() => setError(true))
      .finally(() => {
        setLoading(false);
        setLoadingMore(false);
      });
  };

  // Re-fetch when card, board, or filter changes.
  useEffect(() => {
    setEntries([]);
    setOffset(0);
    setHasMore(false);
    setTotalCount(0);
    fetchPage(0, true);
    // fetchPage is stable across renders; selectedTypes is captured in closure.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boardId, cardId, selectedTypes.join(",")]);

  const handleLoadMore = () => {
    if (loadingMore || !hasMore) return;
    fetchPage(offset, false);
  };

  const handleFilterChange = (types: string[]) => {
    setSelectedTypes(types);
    // Reset pagination — the useEffect above will re-fetch.
  };

  // Build the timeline: collapse checklist groups for cleaner display.
  const moveEntries = entries.filter((e) => e.kind === "move") as CardTimelineEntry[];
  const displayEntries = collapseChecklistGroups(entries);

  return (
    <div>
      {/* Filter row */}
      <div className="flex items-center justify-between mb-4">
        <span className="text-xs text-slate-500">
          {loading
            ? "Loading…"
            : `${totalCount} event${totalCount !== 1 ? "s" : ""}`}
        </span>
        <ActivityFilterDropdown
          label="Filter"
          options={EVENT_TYPE_OPTIONS as unknown as { value: string; label: string; color: string }[]}
          selected={selectedTypes}
          onChange={handleFilterChange}
          defaultSelected={DEFAULT_SELECTED}
        />
      </div>

      {/* Loading state (initial load) */}
      {loading && (
        <div className="flex items-center justify-center py-8">
          <span className="w-5 h-5 border-2 border-blue-600 border-t-transparent rounded-full animate-spin" />
          <span className="ml-2 text-sm text-slate-400">Loading…</span>
        </div>
      )}

      {/* Error state */}
      {!loading && error && (
        <p className="text-sm text-red-400 text-center py-4">Failed to load activity.</p>
      )}

      {/* Empty state — no events at all */}
      {!loading && !error && entries.length === 0 && selectedTypes.length === 0 && (
        <div className="flex flex-col items-center gap-2 py-8 text-slate-600">
          <svg className="w-8 h-8" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round"
              d="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <p className="text-sm text-slate-400">No activity yet</p>
        </div>
      )}

      {/* Filter-active empty state */}
      {!loading && !error && entries.length === 0 && selectedTypes.length > 0 && (
        <div className="flex flex-col items-center gap-2 py-8 text-slate-600">
          <svg className="w-8 h-8" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round"
              d="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <p className="text-sm text-slate-400">No events match the current filter</p>
          <button
            onClick={() => setSelectedTypes([])}
            className="text-xs text-blue-400 hover:text-blue-300 transition focus:outline-none focus:ring-2 focus:ring-blue-500 rounded"
          >
            Clear filter
          </button>
        </div>
      )}

      {/* Timeline */}
      {!loading && !error && entries.length > 0 && (
        <ol className="relative border-l border-slate-700 ml-2">
          {displayEntries.map((entry) => {
            // Checklist group
            if (entry.kind === "checklist-group") {
              const cg = entry as ChecklistGroup;
              const actor = actorName(cg.actor);
              const plural = cg.items.length > 1;
              const labels: Record<ChecklistEventType, [string, string]> = {
                checklist_item_added:     ["Added checklist item",   "Added checklist items"],
                checklist_item_checked:   ["Checked",                "Checked"],
                checklist_item_unchecked: ["Unchecked",              "Unchecked"],
                checklist_item_deleted:   ["Removed checklist item", "Removed checklist items"],
              };
              const [singular, pluralLabel] = labels[cg.event_type];
              const label = plural ? pluralLabel : singular;
              const itemList = cg.items.map((i) => `"${i}"`).join(", ");
              return (
                <li key={`cg-${cg.ts}-${cg.event_type}`} className="relative mb-3 ml-4">
                  <div className="absolute -left-[1.375rem] top-1 w-3 h-3 rounded-full border-2 border-slate-800 shadow bg-slate-500" />
                  <div className="bg-slate-800 border border-slate-700 rounded-lg px-3 py-2.5 flex flex-col gap-1 shadow-sm">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm text-slate-300 truncate">
                        {label}: {itemList}
                      </span>
                      {actor && (
                        <span className="text-xs text-slate-400 ml-auto shrink-0">by {actor}</span>
                      )}
                    </div>
                    <time
                      className="text-xs text-slate-400"
                      dateTime={cg.ts}
                      title={new Date(cg.ts).toLocaleString()}
                    >
                      {formatRelativeTime(cg.ts)}
                    </time>
                  </div>
                </li>
              );
            }

            // Regular timeline entry (move or activity)
            const timelineEntry = entry as CardTimelineEntry;
            const dot = dotColor(timelineEntry);
            const actor = actorName(timelineEntry.actor);

            if (timelineEntry.kind === "move") {
              const m = timelineEntry.data as unknown as CardMovement;
              const description =
                m.from_column === null
                  ? `Created in ${m.to_column_name || ""}`
                  : `${m.from_column_name || ""} → ${m.to_column_name || ""}`;

              // Time-spent calculation: find the next move after this one (oldest-first)
              const moveIndex = moveEntries.findIndex((me) => {
                const md = me.data as unknown as CardMovement;
                return md.id === m.id;
              });
              // moveEntries are newest-first from the server; reverse index to find
              // the chronologically next move (lower index in newest-first order)
              const nextMoveEntry = moveEntries[moveIndex - 1];
              const duration =
                nextMoveEntry
                  ? formatDuration(
                      new Date(nextMoveEntry.ts).getTime() - new Date(timelineEntry.ts).getTime()
                    )
                  : null;

              return (
                <li key={`${timelineEntry.kind}-${timelineEntry.id}`} className="relative mb-3 ml-4">
                  <div className={`absolute -left-[1.375rem] top-1 w-3 h-3 rounded-full border-2 border-slate-800 shadow ${dot}`} />
                  <div className="bg-slate-800 border border-slate-700 rounded-lg px-3 py-2.5 flex flex-col gap-1 shadow-sm">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm text-slate-300 truncate" title={description}>
                        {description}
                        {m.from_swimlane_name && m.to_swimlane_name && m.from_swimlane_name !== m.to_swimlane_name && (
                          <span className="text-xs text-slate-400 ml-1">
                            ({m.from_swimlane_name} → {m.to_swimlane_name})
                          </span>
                        )}
                      </span>
                      {actor && (
                        <span className="text-xs text-slate-400 ml-auto shrink-0">by {actor}</span>
                      )}
                    </div>
                    <div className="flex items-center gap-2">
                      <time
                        className="text-xs text-slate-400"
                        dateTime={timelineEntry.ts}
                        title={new Date(timelineEntry.ts).toLocaleString()}
                      >
                        {formatRelativeTime(timelineEntry.ts)}
                      </time>
                      {duration && (
                        <span className="text-xs text-blue-500 ml-auto shrink-0">Spent {duration} here</span>
                      )}
                    </div>
                  </div>
                </li>
              );
            }

            // Activity entry
            const description = activityLabel(timelineEntry.event_type, timelineEntry.data, userDateFormat);
            return (
              <li key={`${timelineEntry.kind}-${timelineEntry.id}`} className="relative mb-3 ml-4">
                <div className={`absolute -left-[1.375rem] top-1 w-3 h-3 rounded-full border-2 border-slate-800 shadow ${dot}`} />
                <div className="bg-slate-800 border border-slate-700 rounded-lg px-3 py-2.5 flex flex-col gap-1 shadow-sm">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm text-slate-300 truncate" title={description}>
                      {description}
                    </span>
                    {actor && (
                      <span className="text-xs text-slate-400 ml-auto shrink-0">by {actor}</span>
                    )}
                  </div>
                  <time
                    className="text-xs text-slate-400"
                    dateTime={timelineEntry.ts}
                    title={new Date(timelineEntry.ts).toLocaleString()}
                  >
                    {formatRelativeTime(timelineEntry.ts)}
                  </time>
                </div>
              </li>
            );
          })}
        </ol>
      )}

      {/* Load more button */}
      {hasMore && !loading && (
        <div className="flex justify-center pt-2 pb-1">
          <button
            onClick={handleLoadMore}
            disabled={loadingMore}
            className="flex items-center gap-2 px-3 py-1.5 text-sm rounded text-slate-300 hover:text-white hover:bg-slate-700 disabled:opacity-40 disabled:cursor-not-allowed transition focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            {loadingMore && (
              <span className="w-4 h-4 border-2 border-blue-600 border-t-transparent rounded-full animate-spin" />
            )}
            {loadingMore ? "Loading…" : "Load more"}
          </button>
        </div>
      )}
    </div>
  );
}
