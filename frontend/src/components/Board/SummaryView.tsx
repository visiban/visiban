import { useEffect, useMemo, useState } from "react";
import { getBoardSummary } from "../../api/boards";
import { analyticsErrorKind, analyticsErrorMessage, analyticsErrorRetryable, cancelableWait, withAnalyticsBusyRetry } from "../../api/analyticsErrors";
import type { AnalyticsErrorKind } from "../../api/analyticsErrors";
import type { BoardSummary } from "../../types";
import { parseExtensionPanels } from "./parseExtensionPanels";
import ExtensionPanels from "./ExtensionPanels";

interface Props {
  boardId: number;
  columns: string[];
}

export default function SummaryView({ boardId, columns }: Props) {
  const [data, setData] = useState<BoardSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<AnalyticsErrorKind | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let current = true;
    // The summary is admitted through the analytics limits (#2428): a busy server is retried
    // once after Retry-After, and the pending retry is canceled on unmount or a board change.
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    withAnalyticsBusyRetry(() => getBoardSummary(boardId), cancelableWait, controller.signal)
      .then((d) => { if (current) { setData(d); setLoading(false); } })
      .catch((reason: unknown) => { if (current) { setError(analyticsErrorKind(reason)); setLoading(false); } });
    return () => { current = false; controller.abort(); };
  }, [boardId, attempt]);

  // Hook sits above the early returns; the parser tolerates a missing key.
  const panels = useMemo(() => parseExtensionPanels(data?.extension_panels), [data]);

  if (loading) return <div className="flex-1 flex items-center justify-center bg-sunken text-fg-tertiary">Loading summary…</div>;
  if (error) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-2 bg-sunken">
        <p role="alert" className="text-sm text-danger">
          {analyticsErrorMessage(error, { noPeriod: true }) ?? "Failed to load summary."}
        </p>
        {/* Too much history is not retried: the same request would be refused again (#2428). */}
        {analyticsErrorRetryable(error) && (
          <button
            type="button"
            onClick={() => setAttempt((n) => n + 1)}
            className="px-3 py-1.5 text-sm rounded border border-line-strong bg-surface text-fg-secondary hover:text-fg hover:bg-surface-hover focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
          >
            Retry
          </button>
        )}
      </div>
    );
  }
  if (!data) return null;

  return (
    <div className="flex-1 overflow-auto p-4 bg-sunken">
      <table className="w-full text-sm border-collapse">
        <thead>
          <tr className="border-b border-line text-xs text-fg-muted uppercase tracking-wider">
            {/* Row 1: Section headers */}
            <th className="pb-2 pr-4 font-medium text-left" rowSpan={2}>Swimlane</th>
            <th className="pb-2 pr-4 font-medium text-right" rowSpan={2}>Cards</th>
            {/* #1149 — blocked now, manual or relation (the card's is_blocked). */}
            <th className="pb-2 pr-4 font-medium text-right" rowSpan={2}>Blocked</th>
            <th className="pb-2 pr-6 font-medium" rowSpan={2}>Stage Distribution</th>
            <th className="pb-2 pr-4 font-medium text-right" rowSpan={2}>7d Velocity</th>
            <th className="pb-2 pr-4 font-medium text-right" rowSpan={2}>30d Velocity</th>
            <th className="pb-2 font-medium text-center border-l border-line pl-4" colSpan={3}>
              Metrics (30d)
            </th>
          </tr>
          <tr className="border-b border-line text-xs text-fg-muted uppercase tracking-wider">
            <th className="pb-2 font-medium text-right border-l border-line pl-4">Active</th>
            <th className="pb-2 font-medium text-right pl-4">Done 30d</th>
            <th className="pb-2 font-medium text-right pl-4">Avg cycle (days)</th>
          </tr>
        </thead>
        <tbody>
          {data.swimlanes.map((row) => {
            const total = row.total_cards || 1;
            return (
              <tr key={row.id} className="border-b border-line hover:bg-surface/50">
                <td className="py-2 pr-4 sticky left-0 bg-sunken">
                  <div className="flex items-center gap-2">
                    <span className="color-dot w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: row.color }} />
                    <span className="font-medium text-fg">{row.name}</span>
                  </div>
                </td>
                <td className="py-2 pr-4 text-right font-mono text-fg-secondary">{row.total_cards}</td>
                <td className="py-2 pr-4 text-right font-mono" data-testid="summary-blocked-count">
                  {(row.blocked_cards ?? 0) > 0
                    ? <span className="text-danger font-semibold">{row.blocked_cards}</span>
                    : <span className="text-fg-muted">—</span>}
                </td>
                <td className="py-2 pr-6">
                  <div className="flex h-5 rounded overflow-hidden gap-px min-w-[120px]" style={{ width: 200 }}>
                    {columns.map((col, idx) => {
                      const count = row.stage_distribution[col] ?? 0;
                      const pct = (count / total) * 100;
                      const initials = col.slice(0, 2).toUpperCase();
                      // text-xs (12px) needs more horizontal room than the old text-[8px]
                      // did, so the reveal threshold moves up too — below it the segment
                      // stays unlabeled (title still carries the "{column}: {count}" name)
                      // rather than clipping bold initials against the segment edge.
                      const showInitials = pct >= 12;
                      return (
                        <div
                          key={col}
                          title={`${col}: ${count}`}
                          className="bg-primary-soft first:rounded-l last:rounded-r overflow-hidden flex items-center justify-center text-xs font-bold text-on-primary/80 leading-none"
                          style={{
                            width: `${pct}%`,
                            opacity: 0.4 + (idx / columns.length) * 0.6,
                          }}
                        >
                          {showInitials ? initials : ""}
                        </div>
                      );
                    })}
                  </div>
                </td>
                <td className="py-2 pr-4 text-right font-mono">
                  <span className={row.velocity_7d > 0 ? "text-success font-semibold" : "text-fg-tertiary"}>
                    {row.velocity_7d}
                  </span>
                </td>
                <td className="py-2 pr-4 text-right font-mono">
                  <span className={row.velocity_30d > 0 ? "text-success font-semibold" : "text-fg-tertiary"}>
                    {row.velocity_30d}
                  </span>
                </td>
                {/* New #342 metrics columns */}
                <td className="py-2 text-right font-mono text-fg-secondary border-l border-line pl-4">
                  {row.active_cards > 0 ? row.active_cards : <span className="text-fg-muted">—</span>}
                </td>
                <td className="py-2 text-right font-mono text-fg-secondary pl-4">
                  {row.done_30d > 0 ? row.done_30d : <span className="text-fg-muted">—</span>}
                </td>
                <td className="py-2 text-right font-mono text-fg-secondary pl-4">
                  {row.avg_cycle_days != null ? row.avg_cycle_days : <span className="text-fg-muted">—</span>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <ExtensionPanels panels={panels} />
    </div>
  );
}
