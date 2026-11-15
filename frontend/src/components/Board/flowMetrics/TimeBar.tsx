import { ISOLATED_OPACITY, chartTint } from "../../../utils/chartScale";
import { formatDays } from "./flowFormat";
import type { FlowRowColumn } from "./flowRowData";
import { columnAlpha, HATCH } from "./flowRowData";


/** "3 columns without enough data left out"; empty when none were. */
export function omittedNote(count: number) {
  if (count <= 0) return "";
  return `${count} ${count === 1 ? "column" : "columns"} without enough data left out`;
}

/** Share of the bar below which a segment's number would not fit; its hover title and the bar's aria-label carry it (the single bar's legend too). */
const MIN_LABEL_SHARE = 0.07;

/** One group's bar under a breakdown (#2268): its name and color dot, and its median wait per column. */
export interface TimeBarGroup {
  name: string;
  color: string;
  /** Median days per column uid; missing or null when withheld. */
  medians: Map<string, number | null>;
}

/** The "Where the time goes" bar for each group, lengths on one shared scale so the longest is the slowest group. */
function GroupedTimeBars({ columns, groups, isolated }: { columns: FlowRowColumn[]; groups: TimeBarGroup[]; isolated: number | null }) {
  const rows = groups.map((group, gi) => {
    const segments = columns
      .map((column, index) => ({ column, index, wait: group.medians.get(column.uid) ?? null }))
      .filter((s): s is { column: FlowRowColumn; index: number; wait: number } => s.wait !== null && s.wait > 0);
    return { group, gi, segments, omitted: columns.filter((c) => group.medians.get(c.uid) == null).length, total: segments.reduce((sum, s) => sum + s.wait, 0) };
  });
  const longest = Math.max(0, ...rows.map((r) => r.total));
  return (
    <div className="flex flex-col gap-2" data-testid="time-bar-groups">
      {rows.map(({ group, gi, segments, omitted, total }) => (
        <div
          key={gi}
          data-testid="time-bar-group"
          className="flex flex-col sm:flex-row sm:items-center gap-1 sm:gap-3"
        >
          <span className="flex items-center gap-2 text-sm font-semibold text-fg sm:w-28 shrink-0 min-w-0">
            <span aria-hidden="true" className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: group.color, opacity: isolated === null || isolated === gi ? 1 : ISOLATED_OPACITY }} />
            <span className="truncate" title={group.name}>{group.name}</span>
          </span>
          <div className="flex-1 min-w-0">
            {segments.length === 0 ? (
              <span className="text-sm text-fg-tertiary">Too few finished cards.</span>
            ) : (
              <div className={`overflow-x-auto rounded focus:outline-none focus:ring-2 focus:ring-primary-emphasis focus:ring-inset`} style={isolated === null || isolated === gi ? undefined : { opacity: ISOLATED_OPACITY }} role="region" aria-label={`Where the time goes for ${group.name}, scrolls sideways`} tabIndex={0}>
                <div
                  className="flex h-8 rounded gap-px bg-line bg-clip-padding min-w-[8rem]"
                  style={{ width: `${(total / longest) * 100}%` }}
                  role="img"
                  aria-label={`${group.name}, median days in each column: ${segments.map((s) => `${s.column.name} ${formatDays(s.wait)}`).join(", ")}. Sum of medians ${formatDays(total)}${omitted > 0 ? `, ${omittedNote(omitted)}` : ""}.`}
                >
                  {segments.map(({ column, index, wait }) => (
                    <div
                      key={column.uid}
                      data-testid="time-segment"
                      data-bottleneck={column.bottleneck ? "true" : "false"}
                      title={`${column.name} ${formatDays(wait)}`}
                      className="flex items-center justify-center min-w-0 overflow-hidden bg-surface"
                      style={{
                        flexGrow: wait,
                        flexBasis: 0,
                        backgroundImage: column.bottleneck ? HATCH : `linear-gradient(${chartTint(columnAlpha(index, columns.length))}, ${chartTint(columnAlpha(index, columns.length))})`,
                      }}
                    >
                      {wait / total >= MIN_LABEL_SHARE && <span className="text-xs font-semibold bg-surface text-fg rounded px-1">{wait.toFixed(1)}</span>}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
          <span className="flex flex-col shrink-0 sm:w-28">
            <span className="text-sm font-semibold text-fg font-mono" data-testid="time-group-total" title="Sum of the columns' median days">{total > 0 ? formatDays(total) : ""}</span>
            {omitted > 0 && <span className="text-xs text-fg-tertiary" data-testid="time-group-omitted">{omittedNote(omitted)}</span>}
          </span>
        </div>
      ))}
    </div>
  );
}

/** "Where the time goes": one segmented bar, "All cards" (#2262), or one per group under a breakdown (#2268). Width is median days. */
export default function TimeBar({ columns, groups, isolated = null }: { columns: FlowRowColumn[]; groups?: TimeBarGroup[]; isolated?: number | null }) {
  const segments = columns
    .map((column, index) => ({ column, index }))
    .filter((s): s is { column: FlowRowColumn & { medianWait: number }; index: number } => s.column.medianWait !== null && s.column.medianWait > 0);
  const total = segments.reduce((sum, s) => sum + s.column.medianWait, 0);
  // Under a breakdown the bars are per group, so the all-cards medians would contradict them.
  const grouped = !!(groups && groups.length > 0);
  // Only withheld medians count as left out; a 0-day median had enough data (no segment, but not omitted).
  const omitted = columns.filter((c) => c.medianWait === null).length;
  if (segments.length === 0 && !(groups && groups.length > 0)) {
    return <p className="text-sm text-fg-tertiary" data-testid="time-bar-empty">Too few finished cards to show where the time goes.</p>;
  }
  return (
    <div className="flex flex-col gap-2" data-testid="time-bar">
      {groups && groups.length > 0 ? <GroupedTimeBars columns={columns} groups={groups} isolated={isolated} /> : (
      <div className="flex flex-col sm:flex-row sm:items-center gap-1 sm:gap-3">
        <span className="text-sm text-fg-secondary w-20 shrink-0">All cards</span>
        <div className="flex-1 min-w-0 overflow-x-auto rounded focus:outline-none focus:ring-2 focus:ring-primary-emphasis focus:ring-inset" role="region" aria-label="Where the time goes, scrolls sideways" tabIndex={0}><div className="flex h-8 rounded gap-px bg-line bg-clip-padding min-w-full w-max" role="img"
          aria-label={`Median days in each column: ${segments.map((s) => `${s.column.name} ${formatDays(s.column.medianWait)}`).join(", ")}. Sum of medians ${formatDays(total)}${omitted > 0 ? `, ${omittedNote(omitted)}` : ""}.`}>
          {segments.map(({ column, index }) => (
            <div
              key={column.uid}
              data-testid="time-segment"
              data-bottleneck={column.bottleneck ? "true" : "false"}
              title={`${column.name} ${formatDays(column.medianWait)}`}
              className="flex items-center justify-center min-w-0 overflow-hidden bg-surface"
              style={{
                flexGrow: column.medianWait,
                flexBasis: 0,
                ...(column.bottleneck ? { backgroundImage: HATCH } : { backgroundImage: `linear-gradient(${chartTint(columnAlpha(index, columns.length))}, ${chartTint(columnAlpha(index, columns.length))})` }),
              }}
            >
              {column.medianWait / total >= MIN_LABEL_SHARE && <span className="text-xs font-semibold bg-surface text-fg rounded px-1">{formatNumberShort(column.medianWait)}</span>}
            </div>
          ))}
        </div></div>
        <span className="text-sm font-semibold text-fg font-mono shrink-0" data-testid="time-total" title="Sum of the columns' median days">{formatDays(total)}</span>
      </div>
      )}
      <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-fg-tertiary" aria-label="Time bar legend">
        {segments.map(({ column, index }) => (
          <li key={column.uid} className="flex items-center gap-1.5">
            <span
              aria-hidden="true"
              className="w-3 h-3 rounded-sm bg-surface"
              style={column.bottleneck ? { backgroundImage: HATCH } : { backgroundImage: `linear-gradient(${chartTint(columnAlpha(index, columns.length))}, ${chartTint(columnAlpha(index, columns.length))})` }}
            />
            {column.name}{grouped ? "" : ` ${formatDays(column.medianWait)}`}{column.bottleneck ? " (bottleneck, hatched)" : ""}
          </li>
        ))}
      </ul>
      <p className="text-xs text-fg-tertiary" data-testid="time-footnote">
        {groups && groups.length > 0 ? "Bar length is the sum of each column's median days, on one scale across groups." : "Bar length is the sum of each column's median days."}
        {" "}It is not the cycle time, and columns with too few finished cards are left out of it.
        {!(groups && groups.length > 0) && omitted > 0 && <> <strong className="font-semibold text-fg-secondary" data-testid="time-omitted">{omittedNote(omitted)}.</strong></>}
      </p>
    </div>
  );
}

const formatNumberShort = (days: number) => days.toFixed(1);
