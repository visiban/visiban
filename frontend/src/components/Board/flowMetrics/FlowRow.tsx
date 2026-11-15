import { chartTint } from "../../../utils/chartScale";
import type { FlowCumulativeFlow, FlowThroughput } from "../../../types";
import { formatDate, formatDays, formatNumber } from "./flowFormat";
import type { FlowRowColumn } from "./flowRowData";
import { columnAlpha, doneRate, HATCH } from "./flowRowData";

function Connector({ rate, note, maxRate, warn }: { rate: number | null; note: string; maxRate: number; warn: boolean }) {
  // Thickness is proportional to the rate; a null rate keeps the thinnest bar.
  const thickness = rate === null || maxRate === 0 ? 2 : Math.max(2, Math.round((rate / maxRate) * 10));
  return (
    <div className="flex flex-col items-center justify-center gap-1 w-24 shrink-0" data-testid="flow-connector">
      <span className="text-xs font-semibold text-fg whitespace-nowrap">{rate === null ? "—" : `${formatNumber(rate)} / wk`}</span>
      <span aria-hidden="true" className={`w-full rounded-full ${warn ? "bg-warning" : "bg-line-strong"}`} style={{ height: thickness }} />
      <span className="text-xs text-fg-tertiary whitespace-nowrap truncate max-w-full" title={note}>{note}</span>
    </div>
  );
}

function Squares({ column, alpha }: { column: FlowRowColumn; alpha: number }) {
  const filled = column.limit === null ? column.count : Math.min(column.count, column.limit);
  return (
    <div className="flex flex-wrap gap-1" aria-hidden="true">
      {Array.from({ length: column.count }, (_, i) => (
        i < filled ? (
          <span
            key={i}
            data-testid="flow-square"
            className={`w-3 h-3 rounded-sm ${column.bottleneck ? "bg-warning" : ""}`}
            style={column.bottleneck ? { backgroundImage: HATCH } : { background: chartTint(alpha) }}
          />
        ) : (
          <span key={i} data-testid="flow-square-over" className="w-3 h-3 rounded-sm border-2 border-danger" />
        )
      ))}
    </div>
  );
}

interface Props {
  columns: FlowRowColumn[];
  cumulative: FlowCumulativeFlow;
  throughput: FlowThroughput | undefined;
  days: number;
  onOpenColumn: (uid: string) => void;
}

/**
 * "How work flows" (#2262): connector, column box, connector, ... Done box.
 * Scrolls sideways inside its own box below 980px, so the page never does.
 */
export default function FlowRow({ columns, cumulative, throughput, days, onOpenColumn }: Props) {
  const rates = [...columns.map((c) => c.enteredPerWeek), doneRate(cumulative)].filter((r): r is number => r !== null);
  const maxRate = Math.max(0, ...rates);
  const since = cumulative.days[0]?.date;
  const bottleneckIndex = columns.findIndex((c) => c.bottleneck);
  const rate = doneRate(cumulative);
  return (
    <div className="overflow-x-auto min-w-0 rounded focus:outline-none focus:ring-2 focus:ring-primary-emphasis focus:ring-inset" data-testid="flow-row" role="region" aria-label="How work flows" tabIndex={0}>
      <div className="flex items-stretch min-w-[980px] py-1">
        {columns.map((column, index) => {
          const over = column.limit !== null ? Math.max(0, column.count - column.limit) : 0;
          return (
            <div key={column.uid} className="contents">
              <Connector
                rate={column.enteredPerWeek}
                note={column.note}
                maxRate={maxRate}
                warn={bottleneckIndex !== -1 && index > bottleneckIndex}
              />
              <button
                type="button"
                onClick={() => onOpenColumn(column.uid)}
                aria-describedby={`${column.uid}-flow-stats`}
                aria-label={`${column.name}${column.bottleneck ? ", bottleneck" : ""}. Show its cards`}
                data-testid="flow-column-box"
                className={`flex-1 min-w-[150px] text-left bg-sunken border rounded-lg p-3 flex flex-col gap-2 hover:bg-surface-hover focus:outline-none focus:ring-2 focus:ring-primary-emphasis ${column.bottleneck ? "border-warning" : "border-line"}`}
              >
                <span className="text-sm font-semibold text-fg truncate">{column.name}</span>
                {column.bottleneck && <span className="text-xs font-semibold text-warning uppercase tracking-wide">Bottleneck</span>}
                <Squares column={column} alpha={columnAlpha(index, columns.length)} />
                {/* The aria-label replaces the box's content, so the description carries every stat. */}
                <span id={`${column.uid}-flow-stats`} className="flex flex-col gap-2">
                  <span className="text-xs text-fg-secondary">
                    {column.limit !== null ? `${column.count} of ${column.limit}` : `${column.count} now`}
                    {over > 0 && <span className="text-danger font-semibold">{`, ${over} over limit`}</span>}
                  </span>
                  <span className="text-xs text-fg-secondary">
                    {column.medianWait !== null ? `${formatDays(column.medianWait)} median wait` : "Median wait not available"}
                  </span>
                  {column.queueDelta !== null && (
                    <span className={`text-xs ${column.queueDelta > 0 ? "text-warning font-semibold" : "text-fg-tertiary"}`}>
                      {column.queueDelta > 0 && since
                        ? `Queue +${column.queueDelta} since ${formatDate(since)}`
                        : column.queueDelta < 0 && since ? `Queue ${column.queueDelta} since ${formatDate(since)}` : "Queue steady"}
                    </span>
                  )}
                </span>
              </button>
            </div>
          );
        })}
        <Connector rate={rate} note="finished" maxRate={maxRate} warn={bottleneckIndex !== -1} />
        <div className="min-w-[110px] bg-sunken border border-line rounded-lg p-3 flex flex-col gap-1 justify-center" data-testid="flow-done-box">
          <span className="text-sm font-semibold text-fg">Done</span>
          <span className="text-xl font-semibold text-fg font-mono">{throughput ? throughput.total : "—"}</span>
          <span className="text-xs text-fg-tertiary">in {days} days</span>
        </div>
      </div>
    </div>
  );
}
