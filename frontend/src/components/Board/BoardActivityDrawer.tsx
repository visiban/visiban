import { useState } from "react";
import { formatRelativeTime } from "../../utils/date";

export type ActivityEntry = {
  id: string;
  timestamp: Date;
  kind: "move" | "create" | "member";
  actor: string;
  headline: string;
  detail: string;
};

type FilterTab = "all" | "moves" | "members";
type TimeWindow = "1h" | "24h" | "7d";

interface Props {
  feed: ActivityEntry[];
  onClose: () => void;
  onOpenHistory: () => void;
  /** Current time supplier — injected only for deterministic tests. */
  now?: () => number;
}

// Window sizes in milliseconds; 24h is the default per #746 AC.
const WINDOW_MS: Record<TimeWindow, number> = {
  "1h": 60 * 60 * 1000,
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
};

const DEFAULT_WINDOW: TimeWindow = "24h";

export default function BoardActivityDrawer({ feed, onClose, onOpenHistory, now = Date.now }: Props) {
  const [tab, setTab] = useState<FilterTab>("all");
  const [timeWindow, setTimeWindow] = useState<TimeWindow>(DEFAULT_WINDOW);

  const cutoff = now() - WINDOW_MS[timeWindow];

  const filtered = feed.filter((e) => {
    if (e.timestamp.getTime() < cutoff) return false;
    if (tab === "moves") return e.kind === "move" || e.kind === "create";
    if (tab === "members") return e.kind === "member";
    return true;
  });

  const tabs: { id: FilterTab; label: string }[] = [
    { id: "all", label: "All" },
    { id: "moves", label: "Moves" },
    { id: "members", label: "Members" },
  ];

  const windows: { id: TimeWindow; label: string }[] = [
    { id: "1h", label: "1h" },
    { id: "24h", label: "24h" },
    { id: "7d", label: "7d" },
  ];

  return (
    <aside className="w-72 bg-surface border-l border-line flex flex-col shrink-0">
      {/* Header */}
      <div className="px-4 py-3 border-b border-line flex items-center justify-between">
        <div>
          <div className="text-sm font-medium text-fg">Activity</div>
          <div className="text-[11px] text-fg-muted">Live · board events</div>
        </div>
        <button
          onClick={onClose}
          aria-label="Close activity drawer"
          className="text-fg-tertiary hover:text-fg hover:bg-surface-hover p-1 rounded transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
        >
          <svg className="w-4 h-4" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
            <path d="M3 3l10 10M13 3L3 13" />
          </svg>
        </button>
      </div>

      {/* Filter tabs */}
      <div className="px-4 py-2 border-b border-line flex gap-1 text-[11px]" role="group" aria-label="Activity kind filter">
        {tabs.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            aria-pressed={tab === t.id}
            className={`px-2 py-0.5 rounded transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis ${
              tab === t.id
                ? "bg-surface-hover text-fg font-medium"
                : "text-fg-tertiary hover:text-fg"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Time window selector */}
      <div
        className="px-4 py-1.5 border-b border-line flex items-center gap-2 text-[11px]"
        role="group"
        aria-label="Activity time window"
      >
        <span className="text-fg-muted shrink-0">Window</span>
        <div className="flex gap-1">
          {windows.map((w) => (
            <button
              key={w.id}
              onClick={() => setTimeWindow(w.id)}
              aria-pressed={timeWindow === w.id}
              className={`px-2 py-0.5 rounded transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis ${
                timeWindow === w.id
                  ? "bg-surface-hover text-fg font-medium"
                  : "text-fg-tertiary hover:text-fg"
              }`}
            >
              {w.label}
            </button>
          ))}
        </div>
      </div>

      {/* Feed */}
      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3 text-xs">
        {filtered.length === 0 ? (
          <p className="text-fg-muted italic text-center py-8">No activity yet</p>
        ) : (
          filtered.map((entry) => (
            <div key={entry.id}>
              <div className="text-fg-secondary">
                <span className="font-medium">{entry.actor}</span>
                {" "}
                {entry.headline}
              </div>
              {entry.detail && (
                <div className="text-fg-muted">{entry.detail}</div>
              )}
              <div className="text-fg-faint mt-0.5">
                {formatRelativeTime(entry.timestamp.toISOString())}
              </div>
            </div>
          ))
        )}
      </div>

      {/* Footer */}
      <div className="px-4 py-2 border-t border-line text-[11px] text-fg-muted flex items-center justify-between">
        <button
          onClick={onOpenHistory}
          className="text-fg-tertiary hover:text-fg transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis rounded"
        >
          Open full history →
        </button>
        <span className="text-fg-faint">⌘\ to close</span>
      </div>
    </aside>
  );
}
