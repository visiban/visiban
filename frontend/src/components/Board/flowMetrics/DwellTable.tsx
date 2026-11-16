import { agingStage, warningFraction } from "../../../utils/agingTint";
import ActiveMark from "../../Common/ActiveMark";
import type { AnalyticsData, SwimlaneStat, ViewMode } from "./heatmap";

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
    <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-fg-tertiary" aria-label="Heatmap legend">
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

// ── Sub-components ────────────────────────────────────────────────────────────

export function ViewModeToggle({ mode, onChange }: { mode: ViewMode; onChange: (m: ViewMode) => void }) {
  return (
    <div
      className="flex rounded overflow-hidden border border-line-strong"
      role="group"
      aria-label="Table mode"
    >
      {(["age", "throughput"] as ViewMode[]).map((m, i) => (
        <button
          key={m}
          onClick={() => onChange(m)}
          aria-pressed={mode === m}
          className={`inline-flex items-center gap-1 px-3 py-1 text-xs transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis focus:ring-inset ${
            i === 0 ? "border-r border-line-strong" : ""
          } ${
            mode === m
              ? "bg-primary text-on-primary"
              : "text-fg-tertiary hover:text-fg-secondary hover:bg-surface-hover"
          }`}
        >
          <ActiveMark active={mode === m} />
          {m === "age" ? "Current" : "In period"}
        </button>
      ))}
    </div>
  );
}

export default function DwellTable({ data, mode, days }: { data: AnalyticsData; mode: ViewMode; days: number }) {
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
      <div className="flex flex-col gap-4 min-w-0">
        {/* Description line — reserved height so toolbar doesn't jump */}
        <p className="text-xs min-h-4 -mt-2 text-fg-tertiary">
          {mode === "throughput"
            ? <span>Average time in each stage for cards that exited in the last {days} days</span>
            : <span>Average time cards in each stage have been there so far</span>}
        </p>

        {/* Heatmap — capped vertically so it never consumes the full panel */}
        <div className="overflow-x-auto overflow-y-auto max-h-[40vh] min-w-0 rounded focus:outline-none focus:ring-2 focus:ring-primary-emphasis focus:ring-inset" role="region" aria-label="Dwell time by swimlane and column" tabIndex={0} data-testid="dwell-scroller">
          {/* Empty state: no swimlanes yet — show a muted placeholder instead of a blank table */}
          {(!data.swimlanes || data.swimlanes.length === 0) && (
            <div className="flex flex-col items-center justify-center gap-2 py-8">
              <svg className="w-10 h-10 text-fg-faint" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5} aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" d="M3 3h18v18H3V3zm0 4.5h18M7.5 3v18" />
              </svg>
              <p className="text-fg-tertiary text-sm font-medium">No analytics data yet</p>
              <p className="text-fg-tertiary text-xs">Move cards between columns to start generating heatmap data.</p>
            </div>
          )}
          <table className="text-sm border-collapse" aria-label="Dwell time heatmap">
            <thead>
              <tr className="text-left text-xs text-fg-tertiary uppercase tracking-wider">
                <th className="pb-2 pr-4 font-medium sticky left-0 bg-surface">Swimlane</th>
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
                  <td className="py-1.5 pr-4 font-medium text-fg sticky left-0 bg-surface max-w-[12rem] truncate" title={sw.name}>
                    {sw.name}
                  </td>
                  {activeCols.map(col => {
                    const avg = getAvg(sw, col);
                    const tooltip = getTooltip(sw, col);
                    let tier = avg !== null ? heatLevel(avg, threshold, warningPct) : null;
                    // The served average is rounded (6.96 reads 7.0); the server's flags
                    // compare the unrounded one, so they decide the tier (#2297, #2306).
                    // The server mirrors agingStage's warning rule, so the two agree.
                    const outlier = (mode === "age" ? sw.age_is_outlier : sw.throughput_is_outlier)?.[col];
                    const warning = (mode === "age" ? sw.age_is_warning : sw.throughput_is_warning)?.[col];
                    if (tier !== null && outlier !== undefined && warning !== undefined) {
                      tier = outlier ? "high" : warning ? "warning" : "ok";
                    } else if (tier === "high" && outlier === false) {
                      // A server older than the warning flag (#2306): only the top tier is exact.
                      // Under the threshold by the unrounded value: yellow only if a yellow band
                      // exists below it (off at 0, empty at 100), else green.
                      const warn = warningFraction(warningPct);
                      tier = warn !== null && warn < 1 ? "warning" : "ok";
                    }
                    const level = tier !== null ? HEAT_LEVELS[tier] : null;
                    return (
                      <td
                        key={col}
                        className={`py-1.5 px-3 text-center rounded text-xs ${level ? level.cls : "bg-surface text-fg-tertiary"}`}
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
          <p className="text-xs text-fg-tertiary">
            {doneCols.size} done {doneCols.size === 1 ? "column" : "columns"} not shown
          </p>
        )}
      </div>
  );
}
