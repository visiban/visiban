import { useEffect, useState } from "react";
import { getBoardAnalytics } from "../../api/boards";

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

interface AnalyticsData {
  days: number;
  columns: string[];
  done_columns?: string[];
  swimlanes: SwimlaneStat[];
  stalled_threshold_days: number;
  staleness_threshold_days: number;
  stale_warning_pct: number;
}

type DaysOption = 7 | 30 | 90;
type ViewMode = "age" | "throughput";

interface Props {
  boardId: number;
  currentUserRole: string | null;
  /** Called with a card ID when the user clicks a stalled card row. */
  onOpenCard?: (cardId: number) => void;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function cellColor(avg: number | null, threshold: number, warningPct: number): string {
  if (avg === null) return "bg-slate-800 text-slate-500";
  if (avg >= threshold) return "bg-red-900/40 text-red-400 font-semibold";
  if (avg >= threshold * (1 - warningPct / 100)) return "bg-yellow-900/30 text-yellow-400";
  return "bg-green-900/30 text-green-400";
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
      className="flex rounded overflow-hidden border border-slate-600"
      role="group"
      aria-label="Analytics view mode"
    >
      {(["age", "throughput"] as ViewMode[]).map((m, i) => (
        <button
          key={m}
          onClick={() => onChange(m)}
          aria-pressed={mode === m}
          className={`px-3 py-1 text-xs capitalize transition ${
            i === 0 ? "border-r border-slate-600" : ""
          } ${
            mode === m
              ? "bg-blue-600 text-white"
              : "text-slate-400 hover:text-slate-300 hover:bg-slate-700"
          }`}
        >
          {m === "age" ? "Age" : "Throughput"}
        </button>
      ))}
    </div>
  );
}

const STALLED_PAGE_SIZE = 25;

// ── Main component ────────────────────────────────────────────────────────────

export default function AnalyticsView({ boardId, currentUserRole, onOpenCard }: Props) {
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

  if (loading) return <div className="flex-1 flex items-center justify-center bg-slate-900 text-slate-400">Loading analytics…</div>;
  if (error) return <div className="flex-1 flex items-center justify-center bg-slate-900 text-red-500">{error}</div>;
  if (!data) return null;

  const { staleness_threshold_days: threshold, stale_warning_pct: warningPct } = data;

  const doneCols = new Set(data.done_columns ?? []);
  const activeCols = data.columns.filter(c => !doneCols.has(c));

  const allStalled = data.swimlanes.flatMap(sw =>
    sw.stalled_cards.map(c => ({ ...c, swimlane: sw.name }))
  );

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
      ? `Avg ${avg}d — ${count} card${count !== 1 ? "s" : ""} exited ${col} in the last ${days} days`
      : `No cards exited ${col} in the last ${days} days`;
  };

  return (
    <div className="flex-1 overflow-hidden flex flex-col bg-slate-900">
      {/* Beta notice — remove when analytics is declared stable */}
      <div className="shrink-0 flex items-center gap-2 px-4 py-2 border-b border-slate-700 bg-slate-800">
        <span className="text-xs text-amber-400 font-medium">Beta</span>
        <span className="text-slate-600 select-none">·</span>
        <span className="text-xs text-slate-400">
          Analytics data may be incomplete in some configurations. Results are best used as directional guidance.
        </span>
      </div>
      {/* Pinned top: toolbar + heatmap — always visible */}
      <div className="shrink-0 flex flex-col gap-4 px-4 pt-4">
        {/* Toolbar */}
        <div className="flex items-center gap-3 flex-wrap">
          <ViewModeToggle mode={mode} onChange={setMode} />
          {mode === "throughput" && (
            <>
              {(([7, 30, 90] as DaysOption[]).map(d => (
                <button
                  key={d}
                  onClick={() => setDays(d)}
                  aria-pressed={days === d}
                  className={`text-xs px-3 py-1 rounded-full border transition ${
                    days === d
                      ? "bg-blue-600 text-white border-blue-600"
                      : "border-slate-600 text-slate-400 hover:border-blue-400"
                  }`}
                >
                  {d}d
                </button>
              )))}
            </>
          )}
          {(currentUserRole === "admin" || currentUserRole === "site_admin") && (
            <button
              onClick={() => data && exportCsv(data, mode)}
              className="ml-auto text-xs px-3 py-1 rounded border border-slate-600 text-slate-400 hover:bg-slate-700 transition"
            >
              Export CSV
            </button>
          )}
        </div>
        {/* Description line — reserved height so toolbar doesn't jump */}
        <p className="text-xs h-4 -mt-2 text-slate-500">
          {mode === "throughput" && (
            <span>Avg time in each stage for cards that exited in the last {days} days</span>
          )}
        </p>

        {/* Heatmap — capped vertically so it never consumes the full panel */}
        <div className="overflow-x-auto overflow-y-auto max-h-[40vh]">
          <table className="text-sm border-collapse" aria-label="Dwell time heatmap">
            <thead>
              <tr className="text-left text-xs text-slate-500 uppercase tracking-wider">
                <th className="pb-2 pr-4 font-medium sticky left-0 bg-slate-900">Swimlane</th>
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
                <tr key={sw.id} className="border-t border-slate-700">
                  <td className="py-1.5 pr-4 font-medium text-slate-200 sticky left-0 bg-slate-900 max-w-[12rem] truncate" title={sw.name}>
                    {sw.name}
                  </td>
                  {activeCols.map(col => {
                    const avg = getAvg(sw, col);
                    const tooltip = getTooltip(sw, col);
                    return (
                      <td
                        key={col}
                        className={`py-1.5 px-3 text-center rounded text-xs ${cellColor(avg, threshold, warningPct)}`}
                        title={tooltip}
                      >
                        {avg !== null ? `${avg}d` : "—"}
                      </td>
                    );
                  })}
                  <td className="py-1.5 px-3 text-center text-xs text-slate-400">
                    {sw.deal_velocity_days !== null ? `${sw.deal_velocity_days}d` : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {doneCols.size > 0 && (
          <p className="text-xs text-slate-500">
            {doneCols.size} done {doneCols.size === 1 ? "column" : "columns"} not shown
          </p>
        )}
      </div>

      {/* Stalled cards — independently scrollable below the pinned heatmap */}
      {allStalled.length > 0 && (() => {
        const sorted = [...allStalled].sort((a, b) => b.days_since_move - a.days_since_move);
        const totalPages = Math.ceil(sorted.length / STALLED_PAGE_SIZE);
        const page = Math.min(stalledPage, totalPages);
        const pageRows = sorted.slice((page - 1) * STALLED_PAGE_SIZE, page * STALLED_PAGE_SIZE);
        return (
          <>
            <div className="mx-4 mt-4">
              <div className="h-px bg-slate-900" />
              <div className="h-px bg-slate-600/50" />
            </div>
            <div className="flex-1 overflow-y-auto min-h-0 px-4 pt-3 pb-4 flex flex-col gap-2" style={{ minHeight: "8rem" }}>
              <div className="flex items-center gap-2">
                <h3 className="text-sm font-semibold text-slate-300">
                  Stalled cards (&gt;{data.stalled_threshold_days} days without movement)
                </h3>
                <span className="text-xs text-slate-500">
                  {allStalled.length} {allStalled.length === 1 ? "card" : "cards"} stalled
                </span>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm border-collapse" aria-label="Stalled cards">
                  <thead>
                    <tr className="text-left text-xs text-slate-500 uppercase tracking-wider border-b border-slate-700">
                      <th className="pb-2 pr-4 font-medium sticky left-0 bg-slate-900 w-32">Swimlane</th>
                      <th className="pb-2 px-3 font-medium">Card</th>
                      <th className="pb-2 px-3 font-medium text-right w-28">Days stalled</th>
                      {onOpenCard && <th className="pb-2 pl-3 font-medium w-8" />}
                    </tr>
                  </thead>
                  <tbody>
                    {pageRows.map(c => (
                      <tr
                        key={c.id}
                        className={`border-b border-slate-700 transition ${onOpenCard ? "hover:bg-slate-800 cursor-pointer" : ""}`}
                        onClick={() => onOpenCard?.(c.id)}
                      >
                        <td className="py-1.5 pr-4 text-xs text-slate-400 sticky left-0 bg-slate-900 max-w-[8rem] truncate" title={c.swimlane}>
                          {c.swimlane}
                        </td>
                        <td className="py-1.5 px-3 text-slate-300 max-w-[24rem] truncate" title={c.title}>
                          {c.title}
                        </td>
                        <td className="py-1.5 px-3 text-right font-mono text-amber-400 font-medium text-xs">
                          {c.days_since_move}d
                        </td>
                        {onOpenCard && (
                          <td className="py-1.5 pl-3 text-slate-600 text-xs text-center">↗</td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {totalPages > 1 && (
                <div className="flex items-center justify-between pt-2">
                  <span className="text-xs text-slate-500">
                    {(page - 1) * STALLED_PAGE_SIZE + 1}–{Math.min(page * STALLED_PAGE_SIZE, sorted.length)} of {sorted.length}
                  </span>
                  <div className="flex items-center gap-1">
                    <button
                      onClick={() => setStalledPage(p => Math.max(1, p - 1))}
                      disabled={page === 1}
                      className="px-2 py-1 text-xs rounded border border-slate-600 text-slate-400 hover:bg-slate-700 disabled:opacity-40 disabled:cursor-not-allowed transition"
                    >
                      ← Prev
                    </button>
                    <span className="text-xs text-slate-500 px-2">{page} / {totalPages}</span>
                    <button
                      onClick={() => setStalledPage(p => Math.min(totalPages, p + 1))}
                      disabled={page === totalPages}
                      className="px-2 py-1 text-xs rounded border border-slate-600 text-slate-400 hover:bg-slate-700 disabled:opacity-40 disabled:cursor-not-allowed transition"
                    >
                      Next →
                    </button>
                  </div>
                </div>
              )}
            </div>
          </>
        );
      })()}
    </div>
  );
}
