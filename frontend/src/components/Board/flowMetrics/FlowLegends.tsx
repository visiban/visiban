import { useId } from "react";
import { CHART_COLORS } from "../../../utils/chartScale";
import type { ChartColor } from "../../../utils/chartScale";
import { HATCH_SVG } from "./hatch";

const LIST = "flex flex-wrap gap-x-4 gap-y-1 text-xs text-fg-secondary";

/**
 * Key for the cumulative flow chart's hatched band (#2284). The swatch is drawn from `HATCH_SVG`, the one hatch definition
 * (#2285), so it cannot drift from the band it names. Rendered only when a bottleneck band is on screen.
 */
export function CumulativeFlowLegend() {
  const id = `cfd-legend-hatch-${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
  return (
    <ul className={LIST} aria-label="Legend" data-testid="cfd-legend">
      <li className="flex items-center gap-1.5">
        <svg width={16} height={12} aria-hidden="true" data-testid="cfd-legend-hatch">
          <defs>
            <pattern id={id} {...HATCH_SVG.pattern}>
              <rect {...HATCH_SVG.ground} />
              <line {...HATCH_SVG.stripe} />
            </pattern>
          </defs>
          <rect x={0.5} y={0.5} width={15} height={11} fill={`url(#${id})`} stroke={CHART_COLORS.warning} strokeWidth={1} />
        </svg>
        Bottleneck column
      </li>
    </ul>
  );
}

export type AgeTier = Exclude<ChartColor, "hue">;

const TIER_LABELS: Record<AgeTier, string> = {
  neutral: "Under the 50th percentile",
  warning: "Past the 50th percentile",
  danger: "Past the 85th percentile",
};

/**
 * Key for the WIP aging tiers (#2284), in the shapes the chart draws: a dot, and for past P85 a dot inside a ring (the ring
 * is the non-hue cue). Only tiers with a mark on screen are listed; under a breakdown the marks take group colors, so the
 * panel passes no tiers and renders no tier key.
 */
export function WipAgeLegend({ tiers }: { tiers: AgeTier[] }) {
  if (tiers.length === 0) return null;
  return (
    <ul className={LIST} aria-label="Legend" data-testid="wip-age-legend">
      {tiers.map((tier) => (
        <li key={tier} className="flex items-center gap-1.5" data-legend-tier={tier}>
          <svg width={18} height={18} aria-hidden="true">
            {tier === "danger" && <circle cx={9} cy={9} r={8} fill="none" stroke={CHART_COLORS.danger} strokeWidth={1.5} />}
            <circle cx={9} cy={9} r={4} fill={CHART_COLORS[tier]} />
          </svg>
          {TIER_LABELS[tier]}
        </li>
      ))}
    </ul>
  );
}
