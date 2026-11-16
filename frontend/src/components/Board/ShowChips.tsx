import { useState } from "react";
import { STATUS_SQUARE_CLASS, type CardBoardStatus } from "../../constants/laneStatus";
import { SHOW_CHIP_LABEL, SHOW_CHIP_ORDER, type ShowChipKey } from "../../utils/showChips";

/**
 * Swatches reuse the collapsed-lane square colors (#2271): the chips are the
 * legend for those squares. "Due soon" has no square of its own, so it takes the
 * neutral swatch; "All cards" shows the on-track primary tint.
 */
const SWATCH_STATUS: Record<ShowChipKey, CardBoardStatus | "neutral"> = {
  all: "ok",
  overdue: "overdue",
  stale: "stale",
  due_soon: "neutral",
};

interface Props {
  active: ShowChipKey;
  counts: Record<ShowChipKey, number>;
  onChange: (next: ShowChipKey) => void;
  columnCount: number;
  laneCount: number;
  cardCount: number;
  /** Lane state for the Collapse all lanes button (#2308). Omit `onToggleLanes` to hide it. */
  allLanesCollapsed?: boolean;
  onToggleLanes?: () => void;
}

/**
 * The "Show" row above the column headers (#2272). Exactly one chip is active;
 * the active one is marked by weight and a border as well as fill, so the state
 * never rests on color alone (`aria-pressed` carries it for assistive tech).
 * Counts are for the whole board; the board totals sit at the right, followed
 * by the Collapse all / Expand all lanes button (#2308). The button drives the
 * same state as the View menu items; its label, not a pressed state, carries
 * what a click will do, so it is never announced as a toggle with a stale name.
 */
export default function ShowChips({ active, counts, onChange, columnCount, laneCount, cardCount, allLanesCollapsed = false, onToggleLanes }: Props) {
  // Live-region message for the lane toggle (#2321). Set on click from the state the
  // click is leaving, so the announcement names the action just taken; the region is
  // always mounted so screen readers register it before the text changes.
  const [laneAnnouncement, setLaneAnnouncement] = useState("");
  const toggleLanes = () => {
    setLaneAnnouncement(`${allLanesCollapsed ? "Expanded" : "Collapsed"} all ${laneCount} ${laneCount === 1 ? "lane" : "lanes"}`);
    onToggleLanes?.();
  };
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  return (
    <div
      role="group"
      aria-label="Show"
      data-testid="show-chips"
      className="px-3 py-1.5 bg-sunken shrink-0 flex items-center gap-2 flex-wrap"
    >
      <span className="text-xs text-fg-secondary" aria-hidden="true">Show</span>
      {SHOW_CHIP_ORDER.map((key) => {
        const on = key === active;
        const swatch = SWATCH_STATUS[key];
        return (
          <button
            key={key}
            type="button"
            aria-pressed={on}
            data-show-chip={key}
            onClick={() => onChange(key)}
            className={`inline-flex items-center gap-1.5 rounded-full border transition-colors px-2.5 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-primary-emphasis ${
              on
                ? "border-info bg-primary/20 text-fg font-semibold"
                : "border-line bg-surface-hover text-fg-secondary font-normal hover:text-fg hover:border-line-strong"
            }`}
          >
            <span
              aria-hidden="true"
              className={`inline-block w-2.5 h-2.5 rounded-sm shrink-0 ${swatch === "neutral" ? "bg-fg-tertiary" : STATUS_SQUARE_CLASS[swatch]}`}
            />
            <span>{SHOW_CHIP_LABEL[key]}</span>
            <span className="tabular-nums">{counts[key]}</span>
            <span className="sr-only">{counts[key] === 1 ? "card" : "cards"}</span>
          </button>
        );
      })}
      <div className="flex-1" />
      <span className="sr-only" role="status" data-testid="show-chip-status">
        {active === "all" ? "" : `Showing ${counts[active]} ${SHOW_CHIP_LABEL[active].toLowerCase()} ${counts[active] === 1 ? "card" : "cards"}`}
      </span>
      <span className="sr-only" role="status" aria-live="polite" data-testid="show-chip-lanes-status">{laneAnnouncement}</span>
      <span className="text-xs text-fg-secondary" data-testid="board-totals">
        {plural(laneCount, "swimlane", "swimlanes")} · {plural(columnCount, "column", "columns")} · {plural(cardCount, "card", "cards")}
      </span>
      {onToggleLanes && laneCount > 0 && (
        <button
          type="button"
          data-testid="show-chips-toggle-lanes"
          onClick={toggleLanes}
          className="inline-flex items-center h-8 px-3 text-sm rounded border border-line-strong text-fg hover:bg-surface-hover transition shrink-0 focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
        >
          {allLanesCollapsed ? "Expand all lanes" : "Collapse all lanes"}
        </button>
      )}
    </div>
  );
}
