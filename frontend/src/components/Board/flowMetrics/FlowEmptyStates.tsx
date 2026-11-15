import type { FlowFilters } from "../../../api/flowMetrics";
import { DEFAULT_DAYS, RANGES } from "./useAnalyticsFilters";

const PRIMARY_BUTTON = "px-3 py-1.5 text-sm font-medium rounded bg-button-primary hover:bg-button-primary-hover text-on-primary focus:outline-none focus:ring-2 focus:ring-primary-emphasis";
const SECONDARY_BUTTON = "px-3 py-1.5 text-sm rounded border border-line-strong text-fg-secondary hover:bg-surface-hover hover:text-fg focus:outline-none focus:ring-2 focus:ring-primary-emphasis";

const EXAMPLE_BAR = [
  { name: "Doing", width: "w-1/4" },
  { name: "Review", width: "w-2/5" },
  { name: "Test", width: "w-1/5" },
];

/**
 * "No history yet" (#2264, `states.png`): no card has moved, so there is
 * nothing to chart. A dimmed example bar shows what the page will draw; it is
 * labeled as an example and hidden from assistive technology.
 */
export function NoHistoryState({ onGoToBoard }: { onGoToBoard?: () => void }) {
  return (
    <div
      className="bg-surface border border-line rounded-lg p-8 flex flex-col items-center gap-3 text-center min-w-0"
      data-testid="flow-empty"
    >
      <h2 className="text-xl font-semibold text-fg">Nothing has moved yet</h2>
      <p className="max-w-md text-sm text-fg-secondary">
        Analytics are built from cards moving between columns. Once a few cards reach Done, this page shows where they spent their time.
      </p>
      <div className="w-full max-w-md flex flex-col gap-1" data-testid="flow-empty-example">
        <div aria-hidden="true" className="flex h-6 w-full overflow-hidden rounded bg-surface-hover opacity-50">
          {EXAMPLE_BAR.map((segment, index) => (
            <div
              key={segment.name}
              className={`${segment.width} h-full border-r border-surface`}
              style={{ background: `rgb(var(--primary-emphasis) / ${0.6 - index * 0.2})` }}
            />
          ))}
        </div>
        <p className="text-xs text-fg-tertiary">Example of what you will see.</p>
      </div>
      {onGoToBoard && (
        <button type="button" onClick={onGoToBoard} className={PRIMARY_BUTTON}>Go to board</button>
      )}
    </div>
  );
}

interface NoMatchProps {
  filters: FlowFilters;
  swimlanes: { id: number; name: string }[];
  labels: { id: number; name: string }[];
  onFiltersChange: (filters: FlowFilters) => void;
  /** Runs before a change that unmounts the pressed button, so focus can move to a stable target. */
  onBeforeChange?: () => void;
}

/** True when the page is empty under a swimlane or label filter, or a period shorter than the default. */
export const isNarrowed = (filters: FlowFilters) =>
  filters.swimlaneId !== null || filters.labelId !== null || filters.days < DEFAULT_DAYS;

/**
 * "Filters match nothing" (#2264): a sentence naming the active filters, a
 * removable chip per filter, "Show last 90 days" when the period is shorter,
 * and "Clear all filters". No "would match N cards" count (spec decision).
 */
export function NoMatchState({ filters, swimlanes, labels, onFiltersChange: change, onBeforeChange }: NoMatchProps) {
  const onFiltersChange = (next: FlowFilters) => {
    onBeforeChange?.();
    change(next);
  };
  const swimlane = filters.swimlaneId === null ? null : swimlanes.find((s) => s.id === filters.swimlaneId)?.name ?? "this swimlane";
  const label = filters.labelId === null ? null : labels.find((l) => l.id === filters.labelId)?.name ?? "this label";
  const shortPeriod = filters.days < DEFAULT_DAYS;
  const periodLabel = RANGES.find((r) => r.value === filters.days)?.label ?? `Last ${filters.days} days`;
  const subject = [
    swimlane !== null ? `in the ${swimlane} swimlane` : null,
    label !== null ? `with the label ${label}` : null,
  ].filter((part): part is string => part !== null).join(" ");
  const chips: { key: string; text: string; remove: () => void }[] = [];
  if (swimlane !== null) chips.push({ key: "swimlane", text: swimlane, remove: () => onFiltersChange({ ...filters, swimlaneId: null }) });
  if (label !== null) chips.push({ key: "label", text: label, remove: () => onFiltersChange({ ...filters, labelId: null }) });
  if (shortPeriod) chips.push({ key: "period", text: periodLabel, remove: () => onFiltersChange({ ...filters, days: DEFAULT_DAYS }) });
  return (
    <div
      className="bg-surface border border-line rounded-lg p-8 flex flex-col items-center gap-3 text-center min-w-0"
      data-testid="flow-no-match"
    >
      <h2 className="text-xl font-semibold text-fg">No cards match these filters</h2>
      <p className="max-w-md text-sm text-fg-secondary">
        {`No card ${subject ? `${subject} ` : ""}moved in the ${periodLabel.toLowerCase()}.`}
      </p>
      {chips.length > 0 && (
        <ul className="flex flex-wrap justify-center gap-2" aria-label="Active filters">
          {chips.map((chip) => (
            <li key={chip.key}>
              <button
                type="button"
                onClick={chip.remove}
                aria-label={`Remove filter: ${chip.text}`}
                className="inline-flex items-center gap-1.5 min-h-6 max-w-full px-2.5 py-1 text-xs rounded-full border border-line-strong bg-sunken text-fg-secondary hover:text-fg hover:bg-surface-hover focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
              >
                <span className="min-w-0 max-w-[16rem] truncate">{chip.text}</span>
                <span aria-hidden="true">×</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap justify-center gap-2">
        {shortPeriod && (
          <button type="button" onClick={() => onFiltersChange({ ...filters, days: DEFAULT_DAYS })} className={SECONDARY_BUTTON}>
            {`Show last ${DEFAULT_DAYS} days`}
          </button>
        )}
        <button
          type="button"
          onClick={() => onFiltersChange({ days: DEFAULT_DAYS, swimlaneId: null, labelId: null })}
          className={PRIMARY_BUTTON}
        >
          Clear all filters
        </button>
      </div>
    </div>
  );
}
