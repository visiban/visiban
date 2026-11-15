import { chartTint } from "../../../utils/chartScale";
import { formatDays } from "./flowFormat";
import type { FlowRowColumn } from "./flowRowData";
import { columnAlpha, HATCH } from "./flowRowData";


/** "Where the time goes": one segmented bar, "All cards" (#2262). Width is median days. */
export default function TimeBar({ columns }: { columns: FlowRowColumn[] }) {
  const segments = columns
    .map((column, index) => ({ column, index }))
    .filter((s): s is { column: FlowRowColumn & { medianWait: number }; index: number } => s.column.medianWait !== null && s.column.medianWait > 0);
  const total = segments.reduce((sum, s) => sum + s.column.medianWait, 0);
  if (segments.length === 0) {
    return <p className="text-sm text-fg-tertiary" data-testid="time-bar-empty">Too few finished cards to show where the time goes.</p>;
  }
  return (
    <div className="flex flex-col gap-2" data-testid="time-bar">
      <div className="flex flex-col sm:flex-row sm:items-center gap-1 sm:gap-3">
        <span className="text-sm text-fg-secondary w-20 shrink-0">All cards</span>
        <div className="flex-1 min-w-0 overflow-x-auto"><div className="flex h-8 rounded gap-px bg-line bg-clip-padding min-w-full w-max" role="img"
          aria-label={`Median days in each column: ${segments.map((s) => `${s.column.name} ${formatDays(s.column.medianWait)}`).join(", ")}. Total ${formatDays(total)}.`}>
          {segments.map(({ column, index }) => (
            <div
              key={column.uid}
              data-testid="time-segment"
              data-bottleneck={column.bottleneck ? "true" : "false"}
              className={`flex items-center justify-center min-w-[2.25rem] ${column.bottleneck ? "bg-warning" : "bg-surface"}`}
              style={{
                flexGrow: column.medianWait,
                flexBasis: 0,
                ...(column.bottleneck ? { backgroundImage: HATCH } : { backgroundImage: `linear-gradient(${chartTint(columnAlpha(index, columns.length))}, ${chartTint(columnAlpha(index, columns.length))})` }),
              }}
            >
              <span className="text-xs font-semibold bg-surface text-fg rounded px-1">{formatNumberShort(column.medianWait)}</span>
            </div>
          ))}
        </div></div>
        <span className="text-sm font-semibold text-fg font-mono shrink-0" data-testid="time-total">{formatDays(total)}</span>
      </div>
      <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-fg-tertiary" aria-label="Time bar legend">
        {segments.map(({ column, index }) => (
          <li key={column.uid} className="flex items-center gap-1.5">
            <span
              aria-hidden="true"
              className={`w-3 h-3 rounded-sm ${column.bottleneck ? "bg-warning" : ""}`}
              style={column.bottleneck ? { backgroundImage: HATCH } : { backgroundImage: `linear-gradient(${chartTint(columnAlpha(index, columns.length))}, ${chartTint(columnAlpha(index, columns.length))})` }}
            />
            {column.name}{column.bottleneck ? " (bottleneck, hatched)" : ""}
          </li>
        ))}
      </ul>
      <p className="text-xs text-fg-tertiary">Bar length is the sum of each column's median days.</p>
    </div>
  );
}

const formatNumberShort = (days: number) => days.toFixed(1);
