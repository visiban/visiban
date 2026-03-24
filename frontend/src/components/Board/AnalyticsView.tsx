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
  const cols = data.columns;
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

  const allStalled = data.swimlanes.flatMap((sw) =>
    sw.stalled_cards.map((c) => ({ ...c, swimlane: sw.name }))
  );

  const hasHeatmapData = data.swimlanes.some((sw) =>
    data.columns.some((col) => sw.avg_days_per_column[col] !== null)
  );

  return (
    <div className="flex-1 overflow-auto p-4 flex flex-col gap-6 bg-slate-900">
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

      {/* Heatmap */}
      <div className="overflow-x-auto">
        {!hasHeatmapData && (
          <p className="text-sm text-slate-400 mb-4">
            No card movements recorded in the last {days} days. Try a longer period to see dwell time data.
          </p>
        )}
        <table className="text-sm border-collapse">
          <thead>
            <tr className="text-left text-xs text-slate-500 uppercase tracking-wider">
              <th className="pb-2 pr-4 font-medium sticky left-0 bg-slate-900">Swimlane</th>
              {data.columns.map((col) => (
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
                {data.columns.map((col) => {
                  const avg = sw.avg_days_per_column[col];
                  const capped = avg !== null && avg >= data.days;
                  return (
                    <td
                      key={col}
                      className={`py-1.5 px-3 text-center rounded text-xs ${cellColor(avg, threshold, warningPct)}`}
                    >
                      {avg !== null ? `${capped ? "≥" : ""}${avg}d` : "—"}
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

      {/* Stalled cards */}
      {allStalled.length > 0 && (
        <div>
          <h3 className="text-sm font-semibold text-slate-300 mb-2">
            Stalled cards (&gt;{data.stalled_threshold_days} days without movement)
          </h3>
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
      )}
    </div>
  );
}
