import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent, ReactNode } from "react";
import { formatRelativeTime } from "../../utils/date";
import { formatShortcut } from "../../utils/platform";
import ActiveMark from "../Common/ActiveMark";
import { useIsLargeViewport } from "../../hooks/useIsLargeViewport";
import { useEscapeStack } from "../../hooks/useEscapeStack";

export type ActivityEntry = {
  id: string;
  timestamp: Date;
  kind: "move" | "create" | "member";
  actor: string;
  headline: string;
  detail: string;
};

/** The drawer's two top-level tabs (#2274). */
export type DrawerTab = "recent" | "archived";

type FilterTab = "all" | "moves" | "members";
type TimeWindow = "1h" | "24h" | "7d";

interface Props {
  feed: ActivityEntry[];
  onClose: () => void;
  onOpenHistory: () => void;
  /** Active top-level tab; owned by the host so Y and the archive toast can open Archived. */
  tab?: DrawerTab;
  onTabChange?: (tab: DrawerTab) => void;
  /** Body of the Archived tab (the embedded ArchivedCardsPanel); mounted only while that tab is active. */
  archivedContent?: ReactNode;
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

const DRAWER_TABS: { id: DrawerTab; label: string }[] = [
  { id: "recent", label: "Recent" },
  { id: "archived", label: "Archived" },
];

export default function BoardActivityDrawer({
  feed, onClose, onOpenHistory, tab: drawerTab = "recent", onTabChange, archivedContent, now = Date.now,
}: Props) {
  const tabRefs = useRef<Record<DrawerTab, HTMLButtonElement | null>>({ recent: null, archived: null });
  // Roving tabindex + arrow keys: a real ARIA tabs widget (frontend/CLAUDE.md § active state).
  const onTabKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight" && e.key !== "Home" && e.key !== "End") return;
    e.preventDefault();
    const next: DrawerTab =
      e.key === "Home" ? "recent" : e.key === "End" ? "archived" : drawerTab === "recent" ? "archived" : "recent";
    onTabChange?.(next);
    tabRefs.current[next]?.focus();
  };
  // #2274 — below `lg` the floating sheet would cover the whole board and
  // clip off-screen, so it becomes a full-height right edge panel instead.
  const isLarge = useIsLargeViewport();
  // The drawer is non-modal, so Escape sits BELOW every control that opens over
  // or inside the board (dropdowns 25, View menu 26, inline fields 21, bulk
  // confirm 20) and above the movement-history slide-in (18). One registration
  // for both tabs; below `lg` it is also the only keyboard way out besides Ctrl+\.
  useEscapeStack(onClose, 19);
  // Focus the active tab on open and whenever the host switches tabs (Y, the
  // View menu, the archive toast), so keyboard users land inside the drawer.
  useEffect(() => {
    tabRefs.current[drawerTab]?.focus();
  }, [drawerTab]);
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
    <aside
      aria-label="Activity"
      data-testid="activity-drawer"
      className={`w-96 max-w-full bg-surface border-line shadow-xl flex flex-col ${
        isLarge
          ? "absolute top-2 right-3 z-30 max-h-[calc(100%-1rem)] rounded-lg border"
          : "fixed inset-y-0 right-0 z-40 border-l"
      }`}
    >
      {/* Header */}
      <div className="px-4 py-3 border-b border-line flex items-center justify-between">
        <div>
          <div className="text-sm font-medium text-fg">Activity</div>
          <div className="text-xs text-fg-tertiary">{drawerTab === "archived" ? "Restore archived cards" : "Live · board events"}</div>
        </div>
        <button type="button"
          onClick={onClose}
          aria-label="Close activity drawer"
          className="text-fg-tertiary hover:text-fg hover:bg-surface-hover p-1 rounded transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
        >
          <svg className="w-4 h-4" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
            <path d="M3 3l10 10M13 3L3 13" />
          </svg>
        </button>
      </div>

      {/* Recent | Archived */}
      <div className="px-4 border-b border-line flex gap-4 text-sm" role="tablist" aria-label="Activity sections">
        {DRAWER_TABS.map((t) => {
          const active = drawerTab === t.id;
          return (
            <button
              key={t.id}
              ref={(el) => { tabRefs.current[t.id] = el; }}
              type="button"
              role="tab"
              id={`activity-tab-${t.id}`}
              aria-selected={active}
              aria-controls="activity-tabpanel"
              tabIndex={active ? 0 : -1}
              onClick={() => onTabChange?.(t.id)}
              onKeyDown={onTabKeyDown}
              className={`relative px-1 py-2 transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis rounded ${
                active ? "text-fg font-medium" : "text-fg-tertiary hover:text-fg"
              }`}
            >
              {t.label}
              {active && <span aria-hidden="true" data-testid="drawer-tab-underline" className="absolute inset-x-0 -bottom-px h-0.5 bg-primary-emphasis" />}
            </button>
          );
        })}
      </div>

      <div
        id="activity-tabpanel"
        role="tabpanel"
        aria-labelledby={`activity-tab-${drawerTab}`}
        className="flex-1 min-h-0 flex flex-col"
      >
      {drawerTab === "archived" ? (
        <div className="flex-1 overflow-y-auto" tabIndex={0}>{archivedContent}</div>
      ) : (
      <>
      {/* Filter tabs */}
      <div className="px-4 py-2 border-b border-line flex gap-1 text-xs" role="group" aria-label="Activity kind filter">
        {tabs.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            aria-pressed={tab === t.id}
            className={`inline-flex items-center gap-1 px-2 py-0.5 rounded transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis ${
              tab === t.id
                ? "bg-surface-hover text-fg font-medium"
                : "text-fg-tertiary hover:text-fg"
            }`}
          >
            <ActiveMark active={tab === t.id} />
            {t.label}
          </button>
        ))}
      </div>

      {/* Time window selector */}
      <div
        className="px-4 py-1.5 border-b border-line flex items-center gap-2 text-xs"
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
              className={`inline-flex items-center gap-1 px-2 py-0.5 rounded transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis ${
                timeWindow === w.id
                  ? "bg-surface-hover text-fg font-medium"
                  : "text-fg-tertiary hover:text-fg"
              }`}
            >
              <ActiveMark active={timeWindow === w.id} />
              {w.label}
            </button>
          ))}
        </div>
      </div>

      {/* Feed */}
      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3 text-xs" tabIndex={0}>
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
              <div className="text-fg-muted mt-0.5">
                {formatRelativeTime(entry.timestamp.toISOString())}
              </div>
            </div>
          ))
        )}
      </div>

      </>
      )}
      </div>

      {/* Footer */}
      <div className="px-4 py-2 border-t border-line text-xs text-fg-muted flex items-center justify-between">
        <button
          type="button"
          onClick={onOpenHistory}
          className="text-fg-secondary underline hover:text-fg transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis rounded"
        >
          Open the full History view
        </button>
        <span className="text-fg-muted">{formatShortcut({ mod: true, key: "\\" })} to close</span>
      </div>
    </aside>
  );
}
