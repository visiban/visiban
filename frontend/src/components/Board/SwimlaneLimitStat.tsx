import type { Swimlane } from "../../types";
import type { LaneLimitReading, LaneUsage } from "../../utils/placementLimits";

/**
 * The row's limit state line (#1150), restyled to the board redesign (#2275)
 * so it reads like the column header's count line (#2270): one line, worst
 * offender first (Over WIP > Over weight > At > Under). `WIP n / limit`, and
 * `WIP n / limit over` in warning text when over. The word carries the state;
 * the hue only reinforces it. Shared by the grid band and the phone band
 * (#2329), so both read the same.
 */
export default function SwimlaneLimitStat({ swimlane, usage, reading, hard, showAtLimit }: { swimlane: Swimlane; usage: LaneUsage; reading: LaneLimitReading; hard: boolean; showAtLimit: boolean }) {
  const wip = swimlane.wip_limit;
  const weight = swimlane.weight_limit;
  // "At limit" is the board's opt-in ambient indicator (Board.show_wip_at_limit),
  // (it applies to swimlane rows only; the column header ignores it); off, an at-limit row reads like an under-limit
  // one. The two over-limit states are violations and always show.
  const state = reading.state === "at" && !showAtLimit ? "under" : reading.state;
  // The line names the metric that decided the state (laneLimitState).
  const showWip = reading.metric === "wip";
  const value = showWip ? usage.count : usage.weight;
  const limit = (showWip ? wip : weight) ?? 0;
  const label = showWip ? "WIP" : "Weight";
  const numbers = `${label} ${value} / ${limit}`;
  let text: React.ReactNode;
  let tone: string;
  let title: string;
  if (state === "overWip") {
    // ⛔ only for a hard lane, as on the column header: no override possible.
    text = <>{hard && <span aria-hidden="true">⛔ </span>}{numbers} over</>;
    tone = "text-warning-on-tint";
    title = hard ? "Over the swimlane's hard WIP limit — no override possible" : "Over the swimlane's WIP limit";
  } else if (state === "overWeight") {
    text = <>{numbers} over</>;
    tone = "text-warning-on-tint";
    title = "Over the swimlane's weight limit";
  } else if (state === "at") {
    text = <>{numbers} · at limit</>;
    tone = "text-fg";
    title = `Swimlane is at its ${label === "WIP" ? "WIP" : "weight"} limit (${value} / ${limit})`;
  } else {
    text = numbers;
    tone = "text-fg";
    title = `Swimlane ${label === "WIP" ? "WIP" : "weight"} limit: ${value} / ${limit} in the columns that count`;
  }
  return (
    // One line in the band's stats cluster (#2271); the words carry the state.
    <span className={`whitespace-nowrap ${tone}`} title={title} data-testid="swimlane-limit-stat">
      {text}
    </span>
  );
}
