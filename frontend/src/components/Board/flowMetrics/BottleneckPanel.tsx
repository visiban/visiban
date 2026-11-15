import type { Column, FlowCumulativeFlow, FlowCycleTime, FlowDwell, FlowWipAge } from "../../../types";
import { bottleneckSentence, formatDate, pluralize } from "./flowFormat";

interface Props {
  cumulative: FlowCumulativeFlow | undefined;
  dwell: FlowDwell | undefined;
  cycle: FlowCycleTime | undefined;
  wipAge: FlowWipAge | undefined;
  columns: Pick<Column, "uid" | "wip_limit">[];
  /** A swimlane or label filter is on: the sentence leaves out the board-wide WIP limit. */
  filtered?: boolean;
  /** Set when a request this panel needs failed: say so instead of a skeleton. */
  failed?: boolean;
  onOpenColumn: (uid: string) => void;
  onGoToBoard?: () => void;
}

function noBottleneck(cumulative: FlowCumulativeFlow, cycle: FlowCycleTime | undefined) {
  if (cycle && cycle.percentiles.p85 === null) {
    return {
      heading: "Too early to say",
      reason: `${pluralize(cycle.sample_size, "card")} ${cycle.sample_size === 1 ? "has" : "have"} finished and no column's queue has grown yet. A bottleneck is named when one does.`,
    };
  }
  const { days } = cumulative;
  return {
    heading: "No bottleneck",
    reason: days.length > 0
      ? `No column's queue grew between ${formatDate(days[0].date)} and ${formatDate(days[days.length - 1].date)}.`
      : "No column's queue grew in this period.",
  };
}

const PRIMARY_BUTTON = "px-3 py-1.5 text-sm font-medium rounded bg-button-primary hover:bg-button-primary-hover text-on-primary focus:outline-none focus:ring-2 focus:ring-primary-emphasis";
const SECONDARY_BUTTON = "px-3 py-1.5 text-sm rounded border border-line-strong text-fg-secondary hover:bg-surface-hover hover:text-fg focus:outline-none focus:ring-2 focus:ring-primary-emphasis";

/**
 * Region 5, left (#2261): the column the server names as the bottleneck
 * (`cumulative.bottleneck_column_uid`), one sentence of its numbers, and the
 * way to its cards. The warning border is the bottleneck's system signal.
 */
export default function BottleneckPanel({
  cumulative, dwell, cycle, wipAge, columns, filtered = false, failed = false, onOpenColumn, onGoToBoard,
}: Props) {
  const uid = cumulative?.bottleneck_column_uid ?? null;
  const name = uid !== null ? cumulative?.columns.find((c) => c.column_uid === uid)?.column_name ?? null : null;
  const count = uid !== null ? (wipAge?.samples.filter((s) => s.column_uid === uid).length ?? 0) : 0;
  const empty = cumulative && uid === null ? noBottleneck(cumulative, cycle) : null;
  return (
    <section
      aria-labelledby="analytics-bottleneck-eyebrow analytics-bottleneck-heading"
      data-testid="analytics-bottleneck"
      className={`bg-surface border rounded-lg p-4 flex flex-col gap-3 min-w-0 h-full ${uid !== null ? "border-warning" : "border-line"}`}
    >
      <p className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-fg-tertiary">
        {uid !== null && (
          <svg className="w-3.5 h-3.5 text-warning" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" d="M3 4h18l-7 8v6l-4 2v-8L3 4z" />
          </svg>
        )}
        <span id="analytics-bottleneck-eyebrow" className={uid !== null ? "text-warning" : undefined}>Bottleneck</span>
      </p>
      {cumulative && uid !== null ? (
        <>
          <h2 id="analytics-bottleneck-heading" className="text-xl font-semibold text-fg break-words">{name ?? "Deleted column"}</h2>
          <p className="text-sm text-fg-secondary">{bottleneckSentence(uid, { cumulative, dwell, cycle, columns, filtered })}</p>
          <div className="flex flex-wrap items-center gap-2">
            {count > 0 && (
              <button type="button" onClick={() => onOpenColumn(uid)} className={PRIMARY_BUTTON}>
                See the {pluralize(count, "card")}
              </button>
            )}
            {onGoToBoard && (
              <button type="button" onClick={onGoToBoard} className={SECONDARY_BUTTON}>Open on board</button>
            )}
          </div>
        </>
      ) : empty ? (
        <>
          <h2 id="analytics-bottleneck-heading" className="text-xl font-semibold text-fg">{empty.heading}</h2>
          <p className="text-sm text-fg-secondary">{empty.reason}</p>
        </>
      ) : failed ? (
        <p id="analytics-bottleneck-heading" className="text-sm text-fg-tertiary">Could not load the bottleneck.</p>
      ) : (
        <div aria-hidden="true" className="flex flex-col gap-3">
          <div className="h-6 w-32 rounded bg-surface-hover animate-pulse motion-reduce:animate-none" />
          <div className="h-12 rounded bg-surface-hover animate-pulse motion-reduce:animate-none" />
        </div>
      )}
    </section>
  );
}
