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
  board_medians: Record<string, number | null>;
  swimlanes: SwimlaneStat[];
  stalled_threshold_days: number;
}

type DaysOption = 7 | 30 | 90;

interface Props {
  boardId: number;
}

function cellColor(avg: number | null, median: number | null, isOutlier: boolean): string {
  if (avg === null) return "bg-gray-50 text-gray-400";
  if (isOutlier) return "bg-red-100 text-red-700 font-semibold";
  if (median !== null && avg > median) return "bg-yellow-50 text-yellow-700";
  return "bg-green-50 text-green-700";
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

export default function AnalyticsView({ boardId }: Props) {
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

  if (loading) return <div className="flex-1 flex items-center justify-center text-gray-400">Loading analytics…</div>;
  if (error) return <div className="flex-1 flex items-center justify-center text-red-500">{error}</div>;
  if (!data) return null;

  const allStalled = data.swimlanes.flatMap((sw) =>
    sw.stalled_cards.map((c) => ({ ...c, swimlane: sw.name }))
  );

  return (
    <div className="flex-1 overflow-auto p-4 flex flex-col gap-6">
      {/* Toolbar */}
      <div className="flex items-center gap-3">
        <span className="text-sm text-gray-600 font-medium">Period:</span>
        {([7, 30, 90] as DaysOption[]).map((d) => (
          <button
            key={d}
            onClick={() => setDays(d)}
            className={`text-xs px-3 py-1 rounded-full border transition ${
              days === d
                ? "bg-blue-600 text-white border-blue-600"
                : "border-gray-300 text-gray-600 hover:border-blue-400"
            }`}
          >
            {d}d
          </button>
        ))}
        <button
          onClick={() => data && exportCsv(data)}
          className="ml-auto text-xs px-3 py-1 rounded border border-gray-300 text-gray-600 hover:bg-gray-50 transition"
        >
          Export CSV
        </button>
      </div>

      {/* Heatmap */}
      <div className="overflow-x-auto">
        <table className="text-sm border-collapse">
          <thead>
            <tr className="text-left text-xs text-gray-500 uppercase tracking-wider">
              <th className="pb-2 pr-4 font-medium sticky left-0 bg-white">Swimlane</th>
              {data.columns.map((col) => (
                <th key={col} className="pb-2 px-3 font-medium text-center min-w-[90px]">
                  {col}
                  {data.board_medians[col] !== null && (
                    <div className="text-gray-400 font-normal normal-case tracking-normal mt-0.5">
                      med {data.board_medians[col]}d
                    </div>
                  )}
                </th>
              ))}
              <th className="pb-2 px-3 font-medium text-center">Velocity</th>
            </tr>
          </thead>
          <tbody>
            {data.swimlanes.map((sw) => (
              <tr key={sw.id} className="border-t border-gray-100">
                <td className="py-1.5 pr-4 font-medium text-gray-800 sticky left-0 bg-white">{sw.name}</td>
                {data.columns.map((col) => {
                  const avg = sw.avg_days_per_column[col];
                  const isOut = sw.is_outlier[col];
                  return (
                    <td
                      key={col}
                      className={`py-1.5 px-3 text-center rounded text-xs ${cellColor(avg, data.board_medians[col], isOut)}`}
                      title={isOut ? "Outlier: >2× board median" : undefined}
                    >
                      {avg !== null ? `${avg}d` : "—"}
                      {isOut && <span className="ml-1 text-red-500">⚠</span>}
                    </td>
                  );
                })}
                <td className="py-1.5 px-3 text-center text-xs text-gray-600">
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
          <h3 className="text-sm font-semibold text-gray-700 mb-2">
            Stalled cards (&gt;{data.stalled_threshold_days} days without movement)
          </h3>
          <div className="flex flex-col gap-1">
            {allStalled
              .sort((a, b) => b.days_since_move - a.days_since_move)
              .map((c) => (
                <div key={c.id} className="flex items-center gap-3 text-sm py-1 border-b border-gray-100">
                  <span className="text-gray-500 text-xs w-16 shrink-0">{c.swimlane}</span>
                  <span className="text-gray-800 flex-1">{c.title}</span>
                  <span className="text-amber-600 font-medium text-xs shrink-0">{c.days_since_move}d stalled</span>
                </div>
              ))}
          </div>
        </div>
      )}
    </div>
  );
}
