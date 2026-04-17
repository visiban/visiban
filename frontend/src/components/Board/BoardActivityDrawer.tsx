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

interface Props {
  feed: ActivityEntry[];
  onClose: () => void;
  onOpenHistory: () => void;
}

export default function BoardActivityDrawer({ feed, onClose, onOpenHistory }: Props) {
  const [tab, setTab] = useState<FilterTab>("all");

  const filtered = feed.filter((e) => {
    if (tab === "moves") return e.kind === "move" || e.kind === "create";
    if (tab === "members") return e.kind === "member";
    return true;
  });

  const tabs: { id: FilterTab; label: string }[] = [
    { id: "all", label: "All" },
    { id: "moves", label: "Moves" },
    { id: "members", label: "Members" },
  ];

  return (
    <aside className="w-72 bg-slate-800 border-l border-slate-700 flex flex-col shrink-0">
      {/* Header */}
      <div className="px-4 py-3 border-b border-slate-700 flex items-center justify-between">
        <div>
          <div className="text-sm font-medium text-slate-200">Activity</div>
          <div className="text-[11px] text-slate-500">Live · board events</div>
        </div>
        <button
          onClick={onClose}
          aria-label="Close activity drawer"
          className="text-slate-400 hover:text-white hover:bg-slate-700 p-1 rounded transition focus:outline-none focus:ring-2 focus:ring-blue-500"
        >
          <svg className="w-4 h-4" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
            <path d="M3 3l10 10M13 3L3 13" />
          </svg>
        </button>
      </div>

      {/* Filter tabs */}
      <div className="px-4 py-2 border-b border-slate-700 flex gap-1 text-[11px]">
        {tabs.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            aria-pressed={tab === t.id}
            className={`px-2 py-0.5 rounded transition focus:outline-none focus:ring-2 focus:ring-blue-500 ${
              tab === t.id
                ? "bg-slate-700 text-slate-200 font-medium"
                : "text-slate-400 hover:text-slate-200"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Feed */}
      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3 text-xs">
        {filtered.length === 0 ? (
          <p className="text-slate-500 italic text-center py-8">No activity yet</p>
        ) : (
          filtered.map((entry) => (
            <div key={entry.id}>
              <div className="text-slate-300">
                <span className="font-medium">{entry.actor}</span>
                {" "}
                {entry.headline}
              </div>
              {entry.detail && (
                <div className="text-slate-500">{entry.detail}</div>
              )}
              <div className="text-slate-600 mt-0.5">
                {formatRelativeTime(entry.timestamp.toISOString())}
              </div>
            </div>
          ))
        )}
      </div>

      {/* Footer */}
      <div className="px-4 py-2 border-t border-slate-700 text-[11px] text-slate-500 flex items-center justify-between">
        <button
          onClick={onOpenHistory}
          className="text-slate-400 hover:text-slate-200 transition focus:outline-none focus:ring-2 focus:ring-blue-500 rounded"
        >
          Open full history →
        </button>
        <span className="text-slate-600">⌘\ to close</span>
      </div>
    </aside>
  );
}
