import { useEffect, useRef, useState } from "react";
import { getCardTimeline } from "../../api/cards";
import type { TimelineCounts, TimelineEventGroup, TimelinePage } from "../../api/cards";
import type { CardTimelineEntry, CardActivity, CardMovement, BoardUser } from "../../types";
import { userDisplayName } from "../../types";
import { formatRelativeTime, formatDateTimeUser } from "../../utils/date";
import type { UserDatePrefs } from "../../utils/date";
import { historyAttribution } from "../../utils/importedHistory";
import { activityLabel } from "../../utils/cardTimelineLabels";
import ActiveMark from "../Common/ActiveMark";
import { HISTORY_PAGE_LIMIT } from "./cardDetailTabMemory";

interface ActivityTabPanelProps {
  boardId: number;
  cardId: number;
  userDateFormat?: string;
  user?: UserDatePrefs | null;
  /**
   * The first unfiltered page (with `counts`) that CardDetail fetched on
   * open (#967). Used instead of a request while every type is shown, and
   * adopted again whenever CardDetail refetches it.
   */
  initialPage?: TimelinePage | null;
  /** Bumps when another session changed this card; a filtered view refetches. */
  refreshSignal?: number;
  /** Every first page this panel fetches, so the History tab count stays current. */
  onFirstPage?: (page: TimelinePage) => void;
  /** Set by the Details tab's Last activity line: focus the newest entry once shown. */
  focusFirstEntry?: boolean;
  /** Called once that focus has moved, so a later visit to the tab does not move it again. */
  onFirstEntryFocused?: () => void;
}

const EVENT_TYPE_OPTIONS: readonly { value: TimelineEventGroup; label: string }[] = [
  { value: "move",       label: "Column moves" },
  { value: "comment",    label: "Comments" },
  { value: "field",      label: "Field changes" },
  { value: "checklist",  label: "Checklist" },
  { value: "attachment", label: "Attachments" },
  { value: "system",     label: "System events" },
];

// #967: every type starts shown, so History answers "what changed and when"
// without a filter step, and the unfiltered first page CardDetail already
// fetched on open (for the tab count and the Last activity line) is reused.
const ALL_GROUPS: TimelineEventGroup[] = EVENT_TYPE_OPTIONS.map((o) => o.value);
const LAST_ON_REASON = "At least one type stays shown";

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
  imported_from_username: string | null;
};

type DisplayEntry = CardTimelineEntry | ChecklistGroup;

const DEFAULT_LIMIT = HISTORY_PAGE_LIMIT;

// Collapse consecutive same-type checklist entries into a single group,
// so a run of checklist events reads as one entry.
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
    // An imported entry never merges with one recorded on this board (or
    // with an import from a different source name), so the group's single
    // attribution line stays true for every item in it (#1675).
    const importedFrom = entry.imported_from_username ?? null;
    if (
      last?.kind === "checklist-group" &&
      last.event_type === (entry.event_type as ChecklistEventType) &&
      last.imported_from_username === importedFrom
    ) {
      last.items.push(value);
    } else {
      result.push({
        kind: "checklist-group",
        ts: entry.ts,
        event_type: entry.event_type as ChecklistEventType,
        items: [value],
        actor: entry.actor,
        imported_from_username: importedFrom,
      });
    }
  }
  return result;
}

function actorName(actor: BoardUser | null): string | null {
  return actor ? userDisplayName(actor) : null;
}

function dotColor(entry: CardTimelineEntry | ChecklistGroup): string {
  if (entry.kind === "checklist-group") return "bg-fg-muted";
  if (entry.kind === "move") {
    const data = entry.data as unknown as CardMovement;
    // Initial creation move: from_column is null
    if (data.from_column === null) return "bg-success-emphasis";
    return "bg-primary-emphasis";
  }
  // activity kind
  switch (entry.event_type) {
    case "comment_added":
      return "bg-activity-date";
    case "attachment_added":
    case "attachment_deleted":
      return "bg-activity-assign";
    case "archived":
      return "bg-surface-active";
    case "reactivated":
      return "bg-activity-reactivated";
    default:
      return "bg-fg-muted";
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

export default function ActivityTabPanel({
  boardId, cardId, userDateFormat = "MM/DD/YYYY", user,
  initialPage = null, refreshSignal = 0, onFirstPage, focusFirstEntry = false, onFirstEntryFocused,
}: ActivityTabPanelProps) {
  const [entries, setEntries] = useState<CardTimelineEntry[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [counts, setCounts] = useState<TimelineCounts | null>(initialPage?.counts ?? null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [offset, setOffset] = useState(0);
  const [selectedTypes, setSelectedTypes] = useState<TimelineEventGroup[]>(ALL_GROUPS);
  const allShown = selectedTypes.length === ALL_GROUPS.length;
  const allShownRef = useRef(allShown);
  allShownRef.current = allShown;
  const onFirstPageRef = useRef(onFirstPage);
  onFirstPageRef.current = onFirstPage;
  const listRef = useRef<HTMLOListElement>(null);

  // Request sequence: every first-page fetch, adopt and filter change bumps it,
  // and a response whose sequence is no longer current is dropped. Without it a
  // late filtered response overwrote the unfiltered list adopted after the user
  // toggled a type off and back on (#967).
  const requestSeqRef = useRef(0);

  const adoptFirstPage = (data: TimelinePage) => {
    requestSeqRef.current += 1;
    setLoadingMore(false);
    setTotalCount(data.count);
    setHasMore(data.next !== null);
    setEntries(data.results);
    setOffset(DEFAULT_LIMIT);
    if (data.counts) setCounts(data.counts);
    setError(false);
    setLoading(false);
  };

  // Fetch a page of timeline entries; the first page also asks for counts.
  const fetchPage = (pageOffset: number, reset: boolean) => {
    const params: { limit: number; offset: number; event_types?: string; include_counts?: boolean } = {
      limit: DEFAULT_LIMIT,
      offset: pageOffset,
    };
    if (!allShownRef.current) {
      params.event_types = selectedTypes.join(",");
    }
    if (reset) {
      requestSeqRef.current += 1;
      setLoadingMore(false);
    }
    const seq = requestSeqRef.current;
    if (reset) {
      params.include_counts = true;
      setLoading(true);
    } else {
      setLoadingMore(true);
    }
    setError(false);

    getCardTimeline(boardId, cardId, params)
      .then((data) => {
        if (seq !== requestSeqRef.current) return;
        if (reset) {
          adoptFirstPage(data);
          onFirstPageRef.current?.(data);
          return;
        }
        setTotalCount(data.count);
        setHasMore(data.next !== null);
        setEntries((prev) => [...prev, ...data.results]);
        setOffset(pageOffset + DEFAULT_LIMIT);
      })
      .catch(() => {
        if (seq === requestSeqRef.current) setError(true);
      })
      .finally(() => {
        if (seq !== requestSeqRef.current) return;
        setLoading(false);
        setLoadingMore(false);
      });
  };

  // Re-fetch when card, board, or filter changes. With every type shown, the
  // page CardDetail already fetched is used instead of a second request.
  useEffect(() => {
    if (allShownRef.current && initialPage) {
      adoptFirstPage(initialPage);
      return;
    }
    setEntries([]);
    setOffset(0);
    setHasMore(false);
    setTotalCount(0);
    fetchPage(0, true);
    // fetchPage/adoptFirstPage only set state; initialPage is adopted by the next effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-run only on card or filter change; see comment above
  }, [boardId, cardId, selectedTypes.join(",")]);

  // CardDetail refetched its first page (open, or another session's change).
  const adoptedPageRef = useRef(initialPage);
  useEffect(() => {
    if (!initialPage || adoptedPageRef.current === initialPage) return;
    adoptedPageRef.current = initialPage;
    if (initialPage.counts) setCounts(initialPage.counts);
    if (allShownRef.current) adoptFirstPage(initialPage);
  }, [initialPage]);

  // A filtered view is not covered by CardDetail's refetch: fetch it again.
  const lastSignalRef = useRef(refreshSignal);
  useEffect(() => {
    if (lastSignalRef.current === refreshSignal) return;
    lastSignalRef.current = refreshSignal;
    if (!allShownRef.current) fetchPage(0, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs only in response to refreshSignal
  }, [refreshSignal]);

  // The Last activity jump: focus the newest entry once it has rendered.
  useEffect(() => {
    if (!focusFirstEntry || loading) return;
    listRef.current?.querySelector<HTMLElement>("li")?.focus();
    onFirstEntryFocused?.();
  }, [focusFirstEntry, loading, entries, onFirstEntryFocused]);

  const handleLoadMore = () => {
    if (loadingMore || !hasMore) return;
    fetchPage(offset, false);
  };

  const toggleType = (group: TimelineEventGroup) => {
    const on = selectedTypes.includes(group);
    // aria-disabled does not stop activation: guard the last type shown.
    if (on && selectedTypes.length === 1) return;
    setSelectedTypes(on
      ? selectedTypes.filter((g) => g !== group)
      : ALL_GROUPS.filter((g) => g === group || selectedTypes.includes(g)));
    // Pagination resets: the first effect above re-fetches.
  };

  // Build the timeline: collapse checklist groups for cleaner display.
  const moveEntries = entries.filter((e) => e.kind === "move") as CardTimelineEntry[];
  const displayEntries = collapseChecklistGroups(entries);

  return (
    <div>
      {/* Type filter (#967): independent toggles, not a tablist. Each shows
          the card's total for that type; at least one stays on. */}
      <div className="flex flex-col gap-2 mb-4">
        <div role="group" aria-label="Show" className="flex flex-wrap gap-1.5 text-xs">
          {EVENT_TYPE_OPTIONS.map((o) => {
            const on = selectedTypes.includes(o.value);
            const lastOn = on && selectedTypes.length === 1;
            const count = counts?.[o.value];
            return (
              <button
                key={o.value}
                type="button"
                aria-pressed={on}
                aria-label={count !== undefined ? `${o.label}, ${count}` : undefined}
                aria-disabled={lastOn || undefined}
                aria-describedby={lastOn ? `history-filter-reason-${cardId}` : undefined}
                title={lastOn ? LAST_ON_REASON : undefined}
                onClick={() => toggleType(o.value)}
                className={`inline-flex items-center gap-1 px-2 py-1 rounded border transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis ${
                  on ? "bg-surface-hover border-line-strong text-fg font-medium" : "border-line text-fg-tertiary hover:text-fg"
                } ${lastOn ? "cursor-not-allowed" : ""}`}
              >
                <ActiveMark active={on} />
                <span>{o.label}</span>
                {count !== undefined && <span className="text-fg-tertiary font-normal">{count}</span>}
              </button>
            );
          })}
        </div>
        <p id={`history-filter-reason-${cardId}`} className="sr-only">{LAST_ON_REASON}</p>
        {/* Always mounted: a filter change announces the new total. */}
        <span role="status" aria-live="polite" aria-atomic="true" className="text-xs text-fg-muted">
          {loading
            ? "Loading…"
            : `${totalCount} event${totalCount !== 1 ? "s" : ""}`}
        </span>
      </div>

      {/* Loading state (initial load) */}
      {loading && (
        <div className="flex items-center justify-center py-8">
          <span className="w-5 h-5 border-2 border-primary border-t-transparent rounded-full animate-spin" />
          <span className="ml-2 text-sm text-fg-tertiary">Loading…</span>
        </div>
      )}

      {/* Error state */}
      {!loading && error && (
        <p className="text-sm text-danger text-center py-4">Failed to load activity.</p>
      )}

      {/* Empty state — no events at all */}
      {!loading && !error && entries.length === 0 && allShown && (
        <div className="flex flex-col items-center gap-2 py-8 text-fg-muted">
          <svg className="w-8 h-8" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round"
              d="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <p className="text-sm text-fg-tertiary">No activity yet</p>
        </div>
      )}

      {/* Filter-active empty state */}
      {!loading && !error && entries.length === 0 && !allShown && (
        <div className="flex flex-col items-center gap-2 py-8 text-fg-muted">
          <svg className="w-8 h-8" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round"
              d="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <p className="text-sm text-fg-tertiary">No events match the current filter</p>
          <button
            type="button"
            onClick={() => setSelectedTypes(ALL_GROUPS)}
            className="py-1 text-xs text-info hover:underline transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis rounded"
          >
            Show all types
          </button>
        </div>
      )}

      {/* Timeline */}
      {!loading && !error && entries.length > 0 && (
        <ol ref={listRef} className="relative border-l border-line ml-2">
          {displayEntries.map((entry) => {
            // Checklist group
            if (entry.kind === "checklist-group") {
              const cg = entry as ChecklistGroup;
              const attribution = historyAttribution(actorName(cg.actor), cg.imported_from_username);
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
                <li key={`cg-${cg.ts}-${cg.event_type}`} tabIndex={-1} className="relative mb-3 ml-4 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-emphasis">
                  <div className="absolute -left-[1.375rem] top-1 w-3 h-3 rounded-full border-2 border-line-subtle shadow bg-fg-muted" />
                  <div className="bg-surface border border-line rounded-lg px-3 py-2.5 flex flex-col gap-1 shadow-sm">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm text-fg-secondary truncate">
                        {label}: {itemList}
                      </span>
                      {attribution && (
                        <span className="text-xs text-fg-tertiary ml-auto shrink-0 max-w-full truncate" title={attribution}>{attribution}</span>
                      )}
                    </div>
                    <time
                      className="text-xs text-fg-tertiary"
                      dateTime={cg.ts}
                      title={formatDateTimeUser(cg.ts, user)}
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
            const attribution = historyAttribution(
              actorName(timelineEntry.actor),
              timelineEntry.imported_from_username,
            );

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
                <li key={`${timelineEntry.kind}-${timelineEntry.id}`} tabIndex={-1} className="relative mb-3 ml-4 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-emphasis">
                  <div className={`absolute -left-[1.375rem] top-1 w-3 h-3 rounded-full border-2 border-line-subtle shadow ${dot}`} />
                  <div className="bg-surface border border-line rounded-lg px-3 py-2.5 flex flex-col gap-1 shadow-sm">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm text-fg-secondary truncate" title={description}>
                        {description}
                        {m.from_swimlane_name && m.to_swimlane_name && m.from_swimlane_name !== m.to_swimlane_name && (
                          <span className="text-xs text-fg-tertiary ml-1">
                            ({m.from_swimlane_name} → {m.to_swimlane_name})
                          </span>
                        )}
                      </span>
                      {attribution && (
                        <span className="text-xs text-fg-tertiary ml-auto shrink-0 max-w-full truncate" title={attribution}>{attribution}</span>
                      )}
                    </div>
                    <div className="flex items-center gap-2">
                      <time
                        className="text-xs text-fg-tertiary"
                        dateTime={timelineEntry.ts}
                        title={formatDateTimeUser(timelineEntry.ts, user)}
                      >
                        {formatRelativeTime(timelineEntry.ts)}
                      </time>
                      {duration && (
                        <span className="text-xs text-info ml-auto shrink-0">Spent {duration} here</span>
                      )}
                    </div>
                  </div>
                </li>
              );
            }

            // Activity entry
            const description = activityLabel(timelineEntry.event_type, timelineEntry.data, userDateFormat);
            return (
              <li key={`${timelineEntry.kind}-${timelineEntry.id}`} tabIndex={-1} className="relative mb-3 ml-4 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-emphasis">
                <div className={`absolute -left-[1.375rem] top-1 w-3 h-3 rounded-full border-2 border-line-subtle shadow ${dot}`} />
                <div className="bg-surface border border-line rounded-lg px-3 py-2.5 flex flex-col gap-1 shadow-sm">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm text-fg-secondary truncate" title={description}>
                      {description}
                    </span>
                    {attribution && (
                      <span className="text-xs text-fg-tertiary ml-auto shrink-0 max-w-full truncate" title={attribution}>{attribution}</span>
                    )}
                  </div>
                  <time
                    className="text-xs text-fg-tertiary"
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
            type="button"
            onClick={handleLoadMore}
            disabled={loadingMore}
            className="flex items-center gap-2 px-3 py-1.5 text-sm rounded text-fg-secondary hover:text-fg hover:bg-surface-hover disabled:opacity-40 disabled:cursor-not-allowed transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
          >
            {loadingMore && (
              <span className="w-4 h-4 border-2 border-primary border-t-transparent rounded-full animate-spin" />
            )}
            {loadingMore ? "Loading…" : "Load more"}
          </button>
        </div>
      )}
    </div>
  );
}
