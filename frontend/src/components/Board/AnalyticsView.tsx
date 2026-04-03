import { useEffect, useState } from "react";
import { getBoardAnalytics } from "../../api/boards";

interface StalledCard {
  id: number;
  title: string;
  days_since_move: number;
}

interface SwimlaneStat {
  id: number;
  name: string;
  avg_days_per_column: Record<string, number | null>;
  is_outlier: Record<string, boolean>;
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

interface Props {
  boardId: number;
  currentUserRole: string | null;
  /** Called with a card ID when the user clicks a stalled card row. */
  onOpenCard?: (cardId: number) => void;
}

function cellColor(avg: number | null, threshold: number, warningPct: number): string {
  if (avg === null) return "bg-slate-800 text-slate-500";
  if (avg >= threshold) return "bg-red-900/40 text-red-400 font-semibold";
  if (avg >= threshold * (1 - warningPct / 100)) return "bg-yellow-900/30 text-yellow-400";
  return "bg-green-900/30 text-green-400";
}

function exportCsv(data: AnalyticsData) {
  const doneCols = new Set(data.done_columns ?? []);
  const cols = data.columns.filter(c => !doneCols.has(c));
  const header = ["Swimlane", ...cols.map((c) => `Avg days (${c})`), "Velocity (days)", "Stalled cards"];
  const rows = data.swimlanes.map((sw) => [
    sw.name,
    ...cols.map((c) => sw.avg_days_per_column[c] ?? ""),
    sw.deal_velocity_days ?? "",
    sw.stalled_cards.length,
  ]);
  const csv = [header, ...rows].map((r) => r.map(String).join(",")).join("\n");
  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `analytics-${data.days}d.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

export default function AnalyticsView({ boardId, currentUserRole, onOpenCard }: Props) {
  const [data, setData] = useState<AnalyticsData | null>(null);
  const [days, setDays] = useState<DaysOption>(30);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

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

  const allStalled = data.swimlanes.flatMap((sw) =>
    sw.stalled_cards.map((c) => ({ ...c, swimlane: sw.name }))
  );

  return (
    <div className="flex-1 overflow-hidden flex flex-col bg-slate-900">
      {/* Pinned top: toolbar + heatmap — always visible */}
      <div className="shrink-0 flex flex-col gap-4 px-4 pt-4">
        {/* Toolbar */}
        <div className="flex items-center gap-3">
          <span className="text-sm text-slate-400 font-medium">Period:</span>
          {([7, 30, 90] as DaysOption[]).map((d) => (
            <button
              key={d}
              onClick={() => setDays(d)}
              className={`text-xs px-3 py-1 rounded-full border transition ${
                days === d
                  ? "bg-blue-600 text-white border-blue-600"
                  : "border-slate-600 text-slate-400 hover:border-blue-400"
              }`}
            >
              {d}d
            </button>
          ))}
          {(currentUserRole === "admin" || currentUserRole === "site_admin") && (
            <button
              onClick={() => data && exportCsv(data)}
              className="ml-auto text-xs px-3 py-1 rounded border border-slate-600 text-slate-400 hover:bg-slate-700 transition"
            >
              Export CSV
            </button>
          )}
        </div>

        {/* Heatmap — capped vertically so it never consumes the full panel */}
        <div className="overflow-x-auto overflow-y-auto max-h-[40vh]">
          <table className="text-sm border-collapse">
            <thead>
              <tr className="text-left text-xs text-slate-500 uppercase tracking-wider">
                <th className="pb-2 pr-4 font-medium sticky left-0 bg-slate-900">Swimlane</th>
                {activeCols.map((col) => (
                  <th key={col} className="pb-2 px-3 font-medium text-center min-w-[90px]">
                    {col}
                  </th>
                ))}
                <th className="pb-2 px-3 font-medium text-center">Velocity</th>
              </tr>
            </thead>
            <tbody>
              {data.swimlanes.map((sw) => (
                <tr key={sw.id} className="border-t border-slate-700">
                  <td className="py-1.5 pr-4 font-medium text-slate-200 sticky left-0 bg-slate-900">{sw.name}</td>
                  {activeCols.map((col) => {
                    const avg = sw.avg_days_per_column[col];
                    return (
                      <td
                        key={col}
                        className={`py-1.5 px-3 text-center rounded text-xs ${cellColor(avg, threshold, warningPct)}`}
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
      {allStalled.length > 0 && (
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
            <div className="flex flex-col gap-1">
              {allStalled
                .sort((a, b) => b.days_since_move - a.days_since_move)
                .map((c) => (
                  <button
                    key={c.id}
                    onClick={() => onOpenCard?.(c.id)}
                    disabled={!onOpenCard}
                    className="flex items-center gap-3 text-sm py-1 border-b border-slate-700 w-full text-left transition hover:bg-slate-800 disabled:cursor-default px-1 rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
                  >
                    <span className="text-slate-400 text-xs w-16 shrink-0">{c.swimlane}</span>
                    <span className="text-slate-300 flex-1">{c.title}</span>
                    <span className="text-amber-600 font-medium text-xs shrink-0">{c.days_since_move}d stalled</span>
                    {onOpenCard && <span className="text-slate-600 text-xs shrink-0">↗</span>}
                  </button>
                ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
