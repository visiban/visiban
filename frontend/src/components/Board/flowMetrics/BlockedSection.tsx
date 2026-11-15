import type { FlowBlocked } from "../../../types";
import { formatBlockedDuration } from "../../../utils/blockedState";
import { PanelPlaceholder } from "./FlowChartPanels";
import type { Result } from "./useAnalyticsOverviewData";

/** Blocked time for display: hours under a day, never a misleading "0d". */
const blockedTimeText = (days: number) => formatBlockedDuration(days * 86_400_000, 1);

interface Props {
  /** Undefined until the first answer. */
  blocked: Result<FlowBlocked> | undefined;
  days: number;
}

/**
 * Region 9, right (#2263): block reasons ranked by total time blocked, from
 * `metrics/blocked` so the page's filters apply. Renders nothing when no block
 * overlapped the period, so a board that never blocks sees no empty panel and
 * Cycle time keeps its half width.
 */
export default function BlockedSection({ blocked, days }: Props) {
  const data = blocked?.data;
  if (!data) return <PanelPlaceholder title="Why cards get blocked" failed={blocked?.error !== undefined} height="h-24" />;
  if (data.total.blocks === 0 && data.reasons.length === 0) return null;

  const reasons = [...data.reasons].sort((a, b) => b.days - a.days);
  const max = Math.max(...reasons.map((r) => r.days), 0);
  // Where most blocks started: the column with the most blocks (ties keep column order).
  const top = data.columns.reduce<FlowBlocked["columns"][number] | null>(
    (best, c) => (c.blocks > (best?.blocks ?? 0) ? c : best), null,
  );
  const totalBlocks = data.total.blocks;
  return (
    <section
      aria-labelledby="analytics-blocked-heading"
      className="bg-surface border border-line rounded-lg p-4 flex flex-col gap-3 min-w-0"
      data-testid="analytics-blocked"
    >
      <div>
        <h2 id="analytics-blocked-heading" className="text-sm font-semibold text-fg">Why cards get blocked</h2>
        <p className="text-xs text-fg-tertiary">Block reasons over the last {days} days, longest first.</p>
      </div>
      <ol className="flex flex-col gap-3" aria-label="Block reasons">
        {reasons.map((r) => (
          <li key={r.reason} className="min-w-0">
            <div className="flex items-baseline justify-between gap-2 text-sm">
              <span className="text-fg truncate min-w-0" title={r.reason}>{r.reason}</span>
              <span className="font-mono text-fg-secondary shrink-0">{blockedTimeText(r.days)} · {r.blocks}</span>
            </div>
            <div className="mt-1 h-1.5 rounded-full bg-surface-hover" aria-hidden="true">
              <div className="h-full rounded-full bg-danger" style={{ width: `${max > 0 ? Math.max(2, (r.days / max) * 100) : 0}%` }} />
            </div>
          </li>
        ))}
      </ol>
      <p className="text-xs text-fg-tertiary">
        Days blocked · number of blocks.
        {top && totalBlocks > 0 && ` ${top.blocks} of ${totalBlocks} ${totalBlocks === 1 ? "block" : "blocks"} started in ${top.column_name}.`}
      </p>
    </section>
  );
}
