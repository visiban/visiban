import { useEffect, useState } from "react";
import { getBoardAnalytics } from "../../api/boards";
import { agingStage } from "../../utils/agingTint";
import { formatBlockedDuration } from "../../utils/blockedState";
import FlowMetricsDashboard from "./flowMetrics/FlowMetricsDashboard";
import ActiveMark from "../Common/ActiveMark";

interface StalledCard {
  id: number;
  uid: string;
  title: string;
  days_since_move: number;
}

interface SwimlaneStat {
  id: number;
  name: string;
  /** @deprecated Use throughput_avg_days_per_column for period-filtered dwell. */
  avg_days_per_column: Record<string, number | null>;
  /** @deprecated Use throughput_is_outlier. */
  is_outlier: Record<string, boolean>;
  // Age mode — current dwell for cards presently in each column (snapshot of "now").
  age_avg_days_per_column?: Record<string, number | null>;
  age_is_outlier?: Record<string, boolean>;
  // Throughput mode — dwell for cards that exited each column within the period.
  throughput_avg_days_per_column?: Record<string, number | null>;
  throughput_card_count_per_column?: Record<string, number>;
  throughput_is_outlier?: Record<string, boolean>;
  deal_velocity_days: number | null;
  stalled_cards: StalledCard[];
}

/** Manual blocked time in the analytics window (#1149). */
interface BlockedSummary {
  /** Blocked days per column (where each block started), every column included. */
  days_per_column: Record<string, number>;
  /** Same time in seconds; absent from a server older than this field. */
  seconds_per_column?: Record<string, number>;
  blocks_per_column: Record<string, number>;
  /** Every block in the window, deleted columns included; absent from a server older than this field. */
  total?: { days: number; seconds: number; blocks: number };
  top_reasons: { reason: string; count: number; total_days: number; total_seconds?: number }[];
}

interface AnalyticsData {
  days: number;
  columns: string[];
  done_columns?: string[];
  swimlanes: SwimlaneStat[];
  stalled_threshold_days: number;
  staleness_threshold_days: number;
  stale_warning_pct: number;
  /** Additive (#1149); absent from a server that predates it. */
  blocked?: BlockedSummary;
}

/**
 * Blocked time per column and the most common reasons (#1149). Renders
 * nothing when no block overlapped the window, so a board that never uses
 * blocking sees no new empty section.
 */
/** Blocked time for display: hours under a day, never a misleading "0d". */
function blockedTimeText(seconds: number | undefined, days: number): string {
  return formatBlockedDuration((seconds ?? days * 86_400) * 1000, 2);
}

function BlockedTimeSection({ blocked, columns, days }: { blocked: BlockedSummary; columns: string[]; days: number }) {
  const cols = columns.filter((c) => (blocked.blocks_per_column[c] ?? 0) > 0);
  if (cols.length === 0 && blocked.top_reasons.length === 0) return null;
  return (
    <section aria-labelledby="analytics-blocked-heading" className="flex flex-col gap-2" data-testid="analytics-blocked">
      <h3 id="analytics-blocked-heading" className="text-sm font-semibold text-fg-secondary">
        Blocked time (last {days} days)
      </h3>
      {cols.length > 0 && (
        <table className="text-sm border-collapse" aria-label="Blocked time per column">
          <thead>
            <tr className="text-left text-xs text-fg-muted uppercase tracking-wider">
              <th className="pb-1 pr-4 font-medium">Column</th>
              <th className="pb-1 px-3 font-medium text-right">Time blocked</th>
              <th className="pb-1 px-3 font-medium text-right">Times blocked</th>
            </tr>
          </thead>
          <tbody>
            {cols.map((c) => (
              <tr key={c} className="border-t border-line">
                <td className="py-1 pr-4 text-fg max-w-[12rem] truncate" title={c}>{c}</td>
                <td className="py-1 px-3 text-right font-mono text-fg-secondary">
                  {blockedTimeText(blocked.seconds_per_column?.[c], blocked.days_per_column[c] ?? 0)}
                </td>
                <td className="py-1 px-3 text-right font-mono text-fg-tertiary">{blocked.blocks_per_column[c] ?? 0}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {blocked.top_reasons.length > 0 && (
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-fg-muted mb-1">Top reasons</p>
          <ol className="flex flex-col gap-0.5 text-sm" aria-label="Top block reasons">
            {blocked.top_reasons.map((r) => (
              <li key={r.reason} className="flex items-baseline gap-2 min-w-0">
                <span className="text-fg truncate min-w-0" title={r.reason}>{r.reason}</span>
                <span className="text-xs text-fg-tertiary shrink-0">
                  {r.count} {r.count === 1 ? "block" : "blocks"} · {blockedTimeText(r.total_seconds, r.total_days)}
                </span>
              </li>
            ))}
          </ol>
        </div>
      )}
    </section>
  );
}

type DaysOption = 7 | 30 | 90;
type ViewMode = "age" | "throughput";

interface Props {
  boardId: number;
  currentUserRole: string | null;
  /** Called with a card ID when the user clicks a stalled card row. */
  onOpenCard?: (cardId: number) => void;
  /** The flow dashboard's filter options (#448). */
  swimlanes?: { id: number; name: string }[];
  labels?: { id: number; name: string }[];
  /** The flow dashboard's empty state links back to the board. */
  onGoToBoard?: () => void;
}

/** The engraved divider between dashboard sections (§ Analytics / split-panel scroll layout). */
function SectionSeparator() {
  return (
    <div className="mx-4" role="separator">
      <div className="h-px bg-sunken" />
      <div className="h-px bg-surface-active/50" />
    </div>
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────────

type HeatLevel = "high" | "warning" | "ok";

// Each level carries a non-color cue (glyph + text) so the threshold is not
// conveyed by hue alone (WCAG 1.4.1, #1591). Glyphs differ in shape.
const HEAT_LEVELS: Record<HeatLevel, { glyph: string; label: string; legend: string; cls: string }> = {
  high: { glyph: "▲\uFE0E", label: "High", legend: "At or over threshold", cls: "bg-danger/30 text-danger-on-tint font-semibold" },
  warning: { glyph: "◆\uFE0E", label: "Warning", legend: "Approaching threshold", cls: "bg-warning/20 text-warning-on-tint" },
  ok: { glyph: "●\uFE0E", label: "OK", legend: "Within threshold", cls: "bg-success/20 text-success-on-tint" },
};

// Shares the card tint's threshold math (agingStage) so the two can never
// disagree about where "warning" starts again — they did, inverted, for any
// stale_warning_pct other than 50 (#1841). The heatmap keeps three levels:
// every stale multiple collapses to "high".
function heatLevel(avg: number, threshold: number, warningPct: number): HeatLevel {
  const stage = agingStage(avg / Math.max(1, threshold), warningPct);
  if (stage === "none") return "ok";
  if (stage === "warning") return "warning";
  return "high";
}

function HeatmapLegend() {
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-fg-muted" aria-label="Heatmap legend">
      {(Object.keys(HEAT_LEVELS) as HeatLevel[]).map(level => (
        <li key={level} className="flex items-center gap-1.5">
          <span
            aria-hidden="true"
            className={`inline-flex items-center justify-center w-5 h-5 rounded text-[10px] ${HEAT_LEVELS[level].cls}`}
          >
            {HEAT_LEVELS[level].glyph}
          </span>
          <span>{HEAT_LEVELS[level].label}: {HEAT_LEVELS[level].legend}</span>
        </li>
      ))}
    </ul>
  );
}

function loadViewMode(boardId: number): ViewMode {
  try {
    const v = localStorage.getItem(`board:${boardId}:analytics-view-mode`);
    if (v === "age" || v === "throughput") return v;
  } catch { /* localStorage unavailable — fall back to default */ }
  return "age";
}

function saveViewMode(boardId: number, mode: ViewMode) {
  try {
    localStorage.setItem(`board:${boardId}:analytics-view-mode`, mode);
  } catch { /* localStorage unavailable — silently skip */ }
}

function exportCsv(data: AnalyticsData, mode: ViewMode) {
  const doneCols = new Set(data.done_columns ?? []);
  const cols = data.columns.filter(c => !doneCols.has(c));
  const modeLabel = mode === "age" ? "Current age" : `Throughput last ${data.days}d`;
  const header = ["Swimlane", ...cols.map(c => `${modeLabel} (${c}, days)`), "Velocity (days)", "Stalled cards"];
  const rows = data.swimlanes.map(sw => {
    const avgMap = mode === "age"
      ? (sw.age_avg_days_per_column ?? sw.avg_days_per_column)
      : (sw.throughput_avg_days_per_column ?? sw.avg_days_per_column);
    return [
      sw.name,
      ...cols.map(c => avgMap[c] ?? ""),
      sw.deal_velocity_days ?? "",
      sw.stalled_cards.length,
    ];
  });
  const csv = [header, ...rows].map(r => r.map(String).join(",")).join("\n");
  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `analytics-${mode}-${data.days}d.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

// ── Sub-components ────────────────────────────────────────────────────────────

function ViewModeToggle({ mode, onChange }: { mode: ViewMode; onChange: (m: ViewMode) => void }) {
  return (
    <div
      className="flex rounded overflow-hidden border border-line-strong"
      role="group"
      aria-label="Analytics view mode"
    >
      {(["age", "throughput"] as ViewMode[]).map((m, i) => (
        <button
          key={m}
          onClick={() => onChange(m)}
          aria-pressed={mode === m}
          className={`inline-flex items-center gap-1 px-3 py-1 text-xs capitalize transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis focus:ring-inset ${
            i === 0 ? "border-r border-line-strong" : ""
          } ${
            mode === m
              ? "bg-primary text-on-primary"
              : "text-fg-tertiary hover:text-fg-secondary hover:bg-surface-hover"
          }`}
        >
          <ActiveMark active={mode === m} />
          {m === "age" ? "Age" : "Throughput"}
        </button>
      ))}
    </div>
  );
}

const STALLED_PAGE_SIZE = 25;

// ── Sections ──────────────────────────────────────────────────────────────────

interface HeatmapSectionProps {
  data: AnalyticsData;
  days: DaysOption;
  onDaysChange: (days: DaysOption) => void;
  mode: ViewMode;
  onModeChange: (mode: ViewMode) => void;
  currentUserRole: string | null;
}

function HeatmapSection({ data, days, onDaysChange, mode, onModeChange, currentUserRole }: HeatmapSectionProps) {
  const { staleness_threshold_days: threshold, stale_warning_pct: warningPct } = data;

  const doneCols = new Set(data.done_columns ?? []);
  const activeCols = data.columns.filter(c => !doneCols.has(c));

  const getAvg = (sw: SwimlaneStat, col: string): number | null => {
    if (mode === "age") return sw.age_avg_days_per_column?.[col] ?? null;
    return sw.throughput_avg_days_per_column?.[col] ?? null;
  };

  const getTooltip = (sw: SwimlaneStat, col: string): string => {
    if (mode === "age") {
      const avg = getAvg(sw, col);
      return avg !== null
        ? `Average time cards have been in ${col} in this swimlane`
        : `No active cards in ${col} for this swimlane`;
    }
    const count = sw.throughput_card_count_per_column?.[col] ?? 0;
    const avg = getAvg(sw, col);
    return count > 0 && avg !== null
      ? `Avg ${avg}d — ${count} stay${count !== 1 ? "s" : ""} in ${col} ended in the last ${days} days`
      : `No stay in ${col} ended in the last ${days} days`;
  };

  return (
      <div className="shrink-0 flex flex-col gap-4 px-4 pt-4">
        {/* Toolbar */}
        <div className="flex items-center gap-3 flex-wrap">
          <ViewModeToggle mode={mode} onChange={onModeChange} />
          {mode === "throughput" && (
            <>
              {(([7, 30, 90] as DaysOption[]).map(d => (
                <button
                  key={d}
                  onClick={() => onDaysChange(d)}
                  aria-pressed={days === d}
                  className={`inline-flex items-center gap-1 text-xs px-3 py-1 rounded-full border transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis ${
                    days === d
                      ? "bg-primary text-on-primary border-primary"
                      : "border-line-strong text-fg-tertiary hover:border-line-emphasis"
                  }`}
                >
                  <ActiveMark active={days === d} />
                  {d}d
                </button>
              )))}
            </>
          )}
          {(currentUserRole === "admin" || currentUserRole === "site_admin") && (
            <button
              onClick={() => data && exportCsv(data, mode)}
              className="ml-auto text-xs px-3 py-1 rounded border border-line-strong text-fg-tertiary hover:bg-surface-hover hover:text-fg-secondary transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
            >
              Export CSV
            </button>
          )}
        </div>
        {/* Description line — reserved height so toolbar doesn't jump */}
        <p className="text-xs h-4 -mt-2 text-fg-muted">
          {mode === "throughput" && (
            <span>Avg time in each stage for cards that exited in the last {days} days</span>
          )}
        </p>

        {/* Heatmap — capped vertically so it never consumes the full panel */}
        <div className="overflow-x-auto overflow-y-auto max-h-[40vh]">
          {/* Empty state: no swimlanes yet — show a muted placeholder instead of a blank table */}
          {(!data.swimlanes || data.swimlanes.length === 0) && (
            <div className="flex flex-col items-center justify-center gap-2 py-8">
              <svg className="w-10 h-10 text-fg-faint" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5} aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" d="M3 3h18v18H3V3zm0 4.5h18M7.5 3v18" />
              </svg>
              <p className="text-fg-tertiary text-sm font-medium">No analytics data yet</p>
              <p className="text-fg-muted text-xs">Move cards between columns to start generating heatmap data.</p>
            </div>
          )}
          <table className="text-sm border-collapse" aria-label="Dwell time heatmap">
            <thead>
              <tr className="text-left text-xs text-fg-muted uppercase tracking-wider">
                <th className="pb-2 pr-4 font-medium sticky left-0 bg-sunken">Swimlane</th>
                {activeCols.map(col => (
                  <th key={col} className="pb-2 px-3 font-medium text-center min-w-[90px]">
                    {col}
                  </th>
                ))}
                <th className="pb-2 px-3 font-medium text-center">Velocity</th>
              </tr>
            </thead>
            <tbody>
              {data.swimlanes.map(sw => (
                <tr key={sw.id} className="border-t border-line">
                  <td className="py-1.5 pr-4 font-medium text-fg sticky left-0 bg-sunken max-w-[12rem] truncate" title={sw.name}>
                    {sw.name}
                  </td>
                  {activeCols.map(col => {
                    const avg = getAvg(sw, col);
                    const tooltip = getTooltip(sw, col);
                    const level = avg !== null ? HEAT_LEVELS[heatLevel(avg, threshold, warningPct)] : null;
                    return (
                      <td
                        key={col}
                        className={`py-1.5 px-3 text-center rounded text-xs ${level ? level.cls : "bg-surface text-fg-muted"}`}
                        title={tooltip}
                      >
                        {level && <span aria-hidden="true" className="mr-1 text-[10px] leading-none align-middle">{level.glyph}</span>}
                        {avg !== null ? `${avg}d` : "—"}
                        {level && <span className="sr-only"> {level.label}</span>}
                      </td>
                    );
                  })}
                  <td className="py-1.5 px-3 text-center text-xs text-fg-tertiary">
                    {sw.deal_velocity_days !== null ? `${sw.deal_velocity_days}d` : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <HeatmapLegend />
        {doneCols.size > 0 && (
          <p className="text-xs text-fg-muted">
            {doneCols.size} done {doneCols.size === 1 ? "column" : "columns"} not shown
          </p>
        )}
        {data.blocked && <BlockedTimeSection blocked={data.blocked} columns={data.columns} days={data.days} />}
      </div>
  );
}

function StalledCardsSection({ data, page: requestedPage, onPageChange, onOpenCard }: {
  data: AnalyticsData;
  page: number;
  onPageChange: (update: (page: number) => number) => void;
  onOpenCard?: (cardId: number) => void;
}) {
  const allStalled = data.swimlanes.flatMap(sw =>
    sw.stalled_cards.map(c => ({ ...c, swimlane: sw.name }))
  );
  if (allStalled.length === 0) return null;

        const sorted = [...allStalled].sort((a, b) => b.days_since_move - a.days_since_move);
        const totalPages = Math.ceil(sorted.length / STALLED_PAGE_SIZE);
        const page = Math.min(requestedPage, totalPages);
        const pageRows = sorted.slice((page - 1) * STALLED_PAGE_SIZE, page * STALLED_PAGE_SIZE);
        return (
          <>
            <SectionSeparator />
            <div className="px-4 pt-3 pb-4 flex flex-col gap-2">
              <div className="flex items-center gap-2">
                <h3 className="text-sm font-semibold text-fg-secondary">
                  Stalled cards (&gt;{data.stalled_threshold_days} days without movement)
                </h3>
                <span className="text-xs text-fg-muted">
                  {allStalled.length} {allStalled.length === 1 ? "card" : "cards"} stalled
                </span>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm border-collapse" aria-label="Stalled cards">
                  <thead>
                    <tr className="text-left text-xs text-fg-muted uppercase tracking-wider border-b border-line">
                      <th className="pb-2 pr-4 font-medium sticky left-0 bg-sunken w-32">Swimlane</th>
                      <th className="pb-2 px-3 font-medium">Card</th>
                      <th className="pb-2 px-3 font-medium text-right w-28">Days stalled</th>
                      {onOpenCard && <th className="pb-2 pl-3 font-medium w-8" />}
                    </tr>
                  </thead>
                  <tbody>
                    {pageRows.map(c => (
                      <tr
                        key={c.id}
                        className={`border-b border-line transition ${onOpenCard ? "hover:bg-surface cursor-pointer focus:outline-none focus:ring-2 focus:ring-inset focus:ring-primary-emphasis" : ""}`}
                        onClick={() => onOpenCard?.(c.id)}
                        // Keyboard parity for the row click (#1376): a tab stop only when the row is actionable.
                        tabIndex={onOpenCard ? 0 : undefined}
                        onKeyDown={onOpenCard ? (e) => {
                          if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpenCard(c.id); }
                        } : undefined}
                      >
                        <td className="py-1.5 pr-4 text-xs text-fg-tertiary sticky left-0 bg-sunken max-w-[8rem] truncate" title={c.swimlane}>
                          {c.swimlane}
                        </td>
                        <td className="py-1.5 px-3 text-fg-secondary max-w-[24rem] truncate" title={c.title}>
                          {c.title}
                        </td>
                        <td className="py-1.5 px-3 text-right font-mono text-warning font-medium text-xs">
                          {c.days_since_move}d
                        </td>
                        {onOpenCard && (
                          <td className="py-1.5 pl-3 text-fg-muted text-xs text-center">↗</td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {totalPages > 1 && (
                <div className="flex items-center justify-between pt-2">
                  <span className="text-xs text-fg-muted">
                    {(page - 1) * STALLED_PAGE_SIZE + 1}–{Math.min(page * STALLED_PAGE_SIZE, sorted.length)} of {sorted.length}
                  </span>
                  <div className="flex items-center gap-1">
                    <button
                      onClick={() => onPageChange(p => Math.max(1, p - 1))}
                      disabled={page === 1}
                      className="px-2 py-1 text-xs rounded border border-line-strong text-fg-tertiary hover:bg-surface-hover hover:text-fg-secondary disabled:opacity-40 disabled:cursor-not-allowed transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
                    >
                      ← Prev
                    </button>
                    <span className="text-xs text-fg-muted px-2">{page} / {totalPages}</span>
                    <button
                      onClick={() => onPageChange(p => Math.min(totalPages, p + 1))}
                      disabled={page === totalPages}
                      className="px-2 py-1 text-xs rounded border border-line-strong text-fg-tertiary hover:bg-surface-hover hover:text-fg-secondary disabled:opacity-40 disabled:cursor-not-allowed transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
                    >
                      Next →
                    </button>
                  </div>
                </div>
              )}
            </div>
          </>
        );
}

// ── Main component ────────────────────────────────────────────────────────────

export default function AnalyticsView({
  boardId, currentUserRole, onOpenCard, swimlanes = [], labels = [], onGoToBoard,
}: Props) {
  const [data, setData] = useState<AnalyticsData | null>(null);
  const [days, setDays] = useState<DaysOption>(30);
  const [mode, setModeState] = useState<ViewMode>(() => loadViewMode(boardId));
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [stalledPage, setStalledPage] = useState(1);

  const setMode = (m: ViewMode) => {
    saveViewMode(boardId, m);
    setModeState(m);
  };

  useEffect(() => {
    setLoading(true);
    getBoardAnalytics(boardId, days)
      .then((d: AnalyticsData) => { setData(d); setLoading(false); })
      .catch(() => { setError("Failed to load analytics."); setLoading(false); });
  }, [boardId, days]);

  const ready = !loading && !error && data?.swimlanes ? data : null;

  // One tree whatever the heatmap's state: FlowMetricsDashboard keeps its position
  // in it, so a change of heatmap period neither remounts it (four full history
  // replays) nor resets its filters.
  return (
    <div className="flex-1 overflow-y-auto flex flex-col bg-sunken">
      {/* Beta notice — remove when analytics is declared stable */}
      <div className="shrink-0 flex items-center gap-2 px-4 py-2 border-b border-line bg-surface">
        <span className="text-xs text-warning font-medium">Beta</span>
        <span className="text-fg-faint select-none" aria-hidden="true">·</span>
        <span className="text-xs text-fg-tertiary">
          Analytics data may be incomplete in some configurations. Results are best used as directional guidance.
        </span>
      </div>
      {ready ? (
        <HeatmapSection
          data={ready}
          days={days}
          onDaysChange={setDays}
          mode={mode}
          onModeChange={setMode}
          currentUserRole={currentUserRole}
        />
      ) : loading ? (
        <div className="flex items-center justify-center py-12 gap-2">
          <div className="w-8 h-8 border-2 border-primary border-t-transparent rounded-full animate-spin" />
          <span className="text-sm text-fg-tertiary">Loading analytics…</span>
        </div>
      ) : error ? (
        <div className="flex items-center justify-center py-12 text-danger">{error}</div>
      ) : (
        <div className="flex flex-col items-center justify-center gap-2 py-12">
          <svg className="w-10 h-10 text-fg-faint" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5} aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" d="M3 3h18v18H3V3zm0 4.5h18M7.5 3v18" />
          </svg>
          <p className="text-fg-tertiary text-sm font-medium">No analytics data</p>
          <p className="text-fg-muted text-xs">Move cards between columns to start generating heatmap data.</p>
        </div>
      )}
      <div className="mt-4"><SectionSeparator /></div>
      <FlowMetricsDashboard
        boardId={boardId}
        swimlanes={swimlanes}
        labels={labels}
        onOpenCard={onOpenCard}
        onGoToBoard={onGoToBoard}
      />
      {ready && (
        <StalledCardsSection data={ready} page={stalledPage} onPageChange={setStalledPage} onOpenCard={onOpenCard} />
      )}
    </div>
  );
}
