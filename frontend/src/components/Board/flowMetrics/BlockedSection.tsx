import type { FlowBlocked } from "../../../types";
import { formatBlockedDuration } from "../../../utils/blockedState";
import { PanelPlaceholder } from "./FlowChartPanels";
import type { Result } from "./useAnalyticsOverviewData";

/** Blocked time for display: hours under a day, never a misleading "0d". */
const blockedTimeText = (days: number) => formatBlockedDuration(days * 86_400_000, 2);

interface Props {
  /** Undefined until the first answer. */
  blocked: Result<FlowBlocked> | undefined;
  days: number;
}

/**
 * Region 9, right (#2261): blocked time per column and the most common
 * reasons, from `metrics/blocked` so the page's filters apply. Renders nothing
 * when no block overlapped the period, so a board that never blocks sees no
 * empty section and Cycle time keeps its half width. #2265 replaces it with
 * "Why cards get blocked".
 */
export default function BlockedSection({ blocked, days }: Props) {
  const data = blocked?.data;
  const cols = data?.columns.filter((c) => c.blocks > 0) ?? [];
  const nothing = data !== undefined && cols.length === 0 && data.reasons.length === 0;
  return nothing ? null : data ? (
    <section
      aria-labelledby="analytics-blocked-heading"
      className="bg-surface border border-line rounded-lg p-4 flex flex-col gap-2 min-w-0"
      data-testid="analytics-blocked"
    >
      <h2 id="analytics-blocked-heading" className="text-sm font-semibold text-fg">
        Blocked time (last {days} days)
      </h2>
      {cols.length > 0 && (
        <div className="overflow-x-auto">
          <table className="text-sm border-collapse" aria-label="Blocked time per column">
            <thead>
              <tr className="text-left text-xs text-fg-tertiary uppercase tracking-wider">
                <th className="pb-1 pr-4 font-medium">Column</th>
                <th className="pb-1 px-3 font-medium text-right">Time blocked</th>
                <th className="pb-1 px-3 font-medium text-right">Times blocked</th>
              </tr>
            </thead>
            <tbody>
              {cols.map((c) => (
                <tr key={c.column_uid} className="border-t border-line">
                  <td className="py-1 pr-4 text-fg max-w-[12rem] truncate" title={c.column_name}>{c.column_name}</td>
                  <td className="py-1 px-3 text-right font-mono text-fg-secondary">{blockedTimeText(c.days)}</td>
                  <td className="py-1 px-3 text-right font-mono text-fg-tertiary">{c.blocks}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {data.reasons.length > 0 && (
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-fg-tertiary mb-1">Top reasons</p>
          <ol className="flex flex-col gap-0.5 text-sm" aria-label="Top block reasons">
            {data.reasons.map((r) => (
              <li key={r.reason} className="flex items-baseline gap-2 min-w-0">
                <span className="text-fg truncate min-w-0" title={r.reason}>{r.reason}</span>
                <span className="text-xs text-fg-tertiary shrink-0">
                  {r.blocks} {r.blocks === 1 ? "block" : "blocks"} · {blockedTimeText(r.days)}
                </span>
              </li>
            ))}
          </ol>
        </div>
      )}
    </section>
  ) : (
    <PanelPlaceholder title="Blocked time" failed={blocked?.error !== undefined} height="h-24" />
  );
}
