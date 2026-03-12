import { useEffect, useState } from "react";
import { getBoardSummary } from "../../api/boards";

interface SwimlaneRow {
  id: number;
  name: string;
  color: string;
  total_cards: number;
  stage_distribution: Record<string, number>;
  velocity_7d: number;
  velocity_30d: number;
}

interface SummaryData {
  swimlanes: SwimlaneRow[];
}

interface Props {
  boardId: number;
  columns: string[];
}

export default function SummaryView({ boardId, columns }: Props) {
  const [data, setData] = useState<SummaryData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    getBoardSummary(boardId)
      .then((d) => { setData(d); setLoading(false); })
      .catch(() => { setError("Failed to load summary."); setLoading(false); });
  }, [boardId]);

  if (loading) return <div className="flex-1 flex items-center justify-center bg-slate-900 text-slate-400">Loading summary…</div>;
  if (error) return <div className="flex-1 flex items-center justify-center bg-slate-900 text-red-500">{error}</div>;
  if (!data) return null;

  return (
    <div className="flex-1 overflow-auto p-4 bg-slate-900">
      <table className="w-full text-sm border-collapse">
        <thead>
          <tr className="border-b border-slate-700 text-left text-xs text-slate-500 uppercase tracking-wider">
            <th className="pb-2 pr-4 font-medium">Swimlane</th>
            <th className="pb-2 pr-4 font-medium text-right">Cards</th>
            <th className="pb-2 pr-6 font-medium">Stage Distribution</th>
            <th className="pb-2 pr-4 font-medium text-right">7d Velocity</th>
            <th className="pb-2 font-medium text-right">30d Velocity</th>
          </tr>
        </thead>
        <tbody>
          {data.swimlanes.map((row) => {
            const total = row.total_cards || 1;
            return (
              <tr key={row.id} className="border-b border-slate-700 hover:bg-slate-800/50">
                <td className="py-2 pr-4">
                  <div className="flex items-center gap-2">
                    <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: row.color }} />
                    <span className="font-medium text-slate-200">{row.name}</span>
                  </div>
                </td>
                <td className="py-2 pr-4 text-right font-mono text-slate-300">{row.total_cards}</td>
                <td className="py-2 pr-6">
                  <div className="flex h-5 rounded overflow-hidden gap-px min-w-[120px]" style={{ width: 200 }}>
                    {columns.map((col, idx) => {
                      const count = row.stage_distribution[col] ?? 0;
                      const pct = (count / total) * 100;
                      const initials = col.slice(0, 2).toUpperCase();
                      return (
                        <div
                          key={col}
                          title={`${col}: ${count}`}
                          className="bg-blue-400 first:rounded-l last:rounded-r overflow-hidden flex items-center justify-center text-[8px] font-bold text-white/80 leading-none"
                          style={{
                            width: `${pct}%`,
                            opacity: 0.4 + (idx / columns.length) * 0.6,
                          }}
                        >
                          {pct >= 8 ? initials : ""}
                        </div>
                      );
                    })}
                  </div>
                </td>
                <td className="py-2 pr-4 text-right font-mono">
                  <span className={row.velocity_7d > 0 ? "text-green-600 font-semibold" : "text-gray-400"}>
                    {row.velocity_7d}
                  </span>
                </td>
                <td className="py-2 text-right font-mono">
                  <span className={row.velocity_30d > 0 ? "text-green-600 font-semibold" : "text-gray-400"}>
                    {row.velocity_30d}
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
