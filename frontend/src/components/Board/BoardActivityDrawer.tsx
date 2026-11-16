import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent, ReactNode } from "react";
import { formatRelativeTime } from "../../utils/date";
import { formatShortcut } from "../../utils/platform";
import ActiveMark from "../Common/ActiveMark";
import { useIsLargeViewport } from "../../hooks/useIsLargeViewport";
import { useEscapeStack } from "../../hooks/useEscapeStack";
import Avatar from "../Common/Avatar";

export type ActivityEntry = {
  id: string;
  timestamp: Date;
  kind: "move" | "create" | "member";
  actor: string;
  headline: string;
  detail: string;
  /** Card title for move/create rows; the row's primary line (#2316). Absent for member rows. */
  subject?: string;
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

const KIND_OPTIONS: { id: FilterTab; label: string }[] = [
  { id: "all", label: "All" },
  { id: "moves", label: "Moves" },
  { id: "members", label: "Members" },
];

const WINDOW_OPTIONS: { id: TimeWindow; label: string }[] = [
  { id: "1h", label: "1h" },
  { id: "24h", label: "24h" },
  { id: "7d", label: "7d" },
];

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

  const [filterOpen, setFilterOpen] = useState(false);
  const filterBtnRef = useRef<HTMLButtonElement | null>(null);
  const filterPopRef = useRef<HTMLDivElement | null>(null);
  const filterShown = filterOpen && drawerTab === "recent";
  // Higher than the drawer's own 19 so the first Escape closes the popover and
  // a second closes the drawer; `false` lets the chain fall through when closed.
  useEscapeStack(() => {
    if (!filterShown) return false;
    setFilterOpen(false);
    filterBtnRef.current?.focus();
  }, 19.5);
  // Leaving Recent closes the popover for good, so returning does not reopen it.
  useEffect(() => {
    if (drawerTab !== "recent") setFilterOpen(false);
  }, [drawerTab]);
  useEffect(() => {
    if (!filterShown) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (filterPopRef.current?.contains(t) || filterBtnRef.current?.contains(t)) return;
      setFilterOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [filterShown]);
  // Focus moves into the popover on open so keyboard users can reach the options.
  useEffect(() => {
    if (filterShown) filterPopRef.current?.querySelector<HTMLButtonElement>('button[aria-pressed="true"]')?.focus();
  }, [filterShown]);
  // A non-default filter must never silently hide events (#746 behavior stays visible).
  const activeFilters = (tab !== "all" ? 1 : 0) + (timeWindow !== DEFAULT_WINDOW ? 1 : 0);

  const cutoff = now() - WINDOW_MS[timeWindow];

  const filtered = feed.filter((e) => {
    if (e.timestamp.getTime() < cutoff) return false;
    if (tab === "moves") return e.kind === "move" || e.kind === "create";
    if (tab === "members") return e.kind === "member";
    return true;
  });

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
          {drawerTab === "archived" && <div className="text-xs text-fg-tertiary">Restore archived cards</div>}
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
      <div className="px-4 border-b border-line flex items-center justify-between">
      <div className="flex gap-4 text-sm" role="tablist" aria-label="Activity sections">
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
      {drawerTab === "recent" && (
        <div className="relative">
          <button
            ref={filterBtnRef}
            type="button"
            aria-haspopup="dialog"
            aria-expanded={filterShown}
            aria-label={activeFilters ? `Filter activity, ${activeFilters} active` : "Filter activity"}
            onClick={() => setFilterOpen((o) => !o)}
            className={`relative inline-flex items-center gap-1 px-2 py-1 text-xs rounded border transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis ${
              activeFilters ? "text-info-on-tint bg-info/10 border-info/40" : "text-fg-tertiary hover:text-fg hover:bg-surface-hover border-line"
            }`}
          >
            <svg className="w-3.5 h-3.5" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
              <path d="M2 4h12M4.5 8h7M7 12h2" />
            </svg>
            Filter
            {activeFilters > 0 && (
              <span data-testid="activity-filter-count" aria-hidden="true" className="min-w-4 h-4 px-1 rounded-full bg-primary text-on-primary text-xs leading-4 text-center">
                {activeFilters}
              </span>
            )}
          </button>
          {filterShown && (
            <div
              ref={filterPopRef}
              role="dialog"
              aria-label="Activity filters"
              className="absolute right-0 top-full mt-1 z-10 w-56 rounded-lg border border-line bg-surface shadow-xl p-3 space-y-3 text-xs"
            >
              <div role="group" aria-label="Activity kind filter" className="space-y-1">
                <div className="text-fg-muted">Kind</div>
                <div className="flex gap-1">
                  {KIND_OPTIONS.map((t) => (
                    <button
                      key={t.id}
                      type="button"
                      onClick={() => setTab(t.id)}
                      aria-pressed={tab === t.id}
                      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis ${
                        tab === t.id ? "bg-surface-hover text-fg font-medium" : "text-fg-tertiary hover:text-fg"
                      }`}
                    >
                      <ActiveMark active={tab === t.id} />
                      {t.label}
                    </button>
                  ))}
                </div>
              </div>
              <div role="group" aria-label="Activity time window" className="space-y-1">
                <div className="text-fg-muted">Window</div>
                <div className="flex gap-1">
                  {WINDOW_OPTIONS.map((w) => (
                    <button
                      key={w.id}
                      type="button"
                      onClick={() => setTimeWindow(w.id)}
                      aria-pressed={timeWindow === w.id}
                      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis ${
                        timeWindow === w.id ? "bg-surface-hover text-fg font-medium" : "text-fg-tertiary hover:text-fg"
                      }`}
                    >
                      <ActiveMark active={timeWindow === w.id} />
                      {w.label}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>
      )}
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
      {/* Feed */}
      <div className="flex-1 overflow-y-auto px-4 text-sm focus:outline-none focus:ring-2 focus:ring-inset focus:ring-primary-emphasis" tabIndex={0}>
        {filtered.length === 0 ? (
          <p className="text-fg-muted italic text-center py-8 text-xs">{activeFilters ? "No activity matches the filter" : "No activity yet"}</p>
        ) : (
          <ul className="divide-y divide-line">
            {filtered.map((entry) => {
              const name = entry.actor.replace(/^@/, "");
              const primary = entry.subject ?? name;
              // A row without a card title (member events, or a move whose card is unknown)
              // keeps its headline and detail so no information from before #2316 is lost.
              const lines = entry.subject
                ? [entry.detail ? entry.detail.replace(" → ", " to ") : entry.kind === "create" ? "Created" : ""]
                : [entry.headline, entry.detail];
              return (
                <li key={entry.id} className="flex items-start gap-2 py-2.5">
                  <Avatar user={{ username: name, display_name: name, avatar_url: "" }} size="xs" className="mt-0.5" />
                  <div className="min-w-0 flex-1">
                    <div className="text-fg truncate">{primary}</div>
                    {lines.filter(Boolean).map((l, i) => <div key={i} className="text-fg-secondary text-xs">{l}</div>)}
                    {entry.subject && <span className="sr-only">by {entry.actor}</span>}
                  </div>
                  <time dateTime={entry.timestamp.toISOString()} className="text-xs text-fg-muted shrink-0 whitespace-nowrap">
                    {formatRelativeTime(entry.timestamp.toISOString())}
                  </time>
                </li>
              );
            })}
          </ul>
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
