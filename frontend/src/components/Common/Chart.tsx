import { useEffect, useId, useRef, useState } from "react";
import type { KeyboardEvent, ReactNode, RefObject } from "react";
import { CHART_HUE, spreadLabels } from "../../utils/chartScale";

/**
 * The shared chart primitive (#2028): one hand-rolled SVG frame, its direct
 * labels, hit targets and data-table fallback. The flow-metrics dashboard (#448)
 * supplies only its marks, and the `series` extension panel (#1774) renders
 * through this too, so nothing here may know about flow metrics.
 *
 * The drawing rules live in frontend/CLAUDE.md § Charts.
 */

const DEFAULT_CHART_WIDTH = 480;

/**
 * The frame's real width, so the viewBox is 1:1 with pixels and the 12px text
 * floor in frontend/CLAUDE.md § Typography holds at every panel width. A scaled
 * viewBox would shrink axis text below it in a narrow panel.
 */
function useChartWidth(ref: RefObject<HTMLElement | null>): number {
  const [width, setWidth] = useState(DEFAULT_CHART_WIDTH);
  useEffect(() => {
    const element = ref.current;
    if (!element || typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(([entry]) => {
      const measured = Math.round(entry.contentRect.width);
      if (measured > 0) setWidth(measured);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return width;
}

export interface ChartMargin {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface ChartGeometry {
  width: number;
  height: number;
  margin: ChartMargin;
  /** Left and right edges of the plot area. */
  x0: number;
  x1: number;
  /** Top and bottom edges of the plot area. */
  y0: number;
  y1: number;
}

export interface ChartTick {
  at: number;
  label: string;
}

interface ChartFrameProps {
  /** Ids of the heading and summary that name this chart. */
  labelledBy?: string;
  /** Used only when no heading names it. */
  label?: string;
  height?: number;
  margin?: Partial<ChartMargin>;
  /** Draw from the measured geometry. Each returns pixels. */
  xTicks: (geometry: ChartGeometry) => ChartTick[];
  yTicks: (geometry: ChartGeometry) => ChartTick[];
  /** The image layer: read-only marks and labels. */
  marks: (geometry: ChartGeometry) => ReactNode;
  /**
   * The interactive layer. It is a sibling of the image, never inside it: `img`
   * has presentational children, so assistive technology may not reach a button
   * nested in it (#2028).
   */
  hits?: (geometry: ChartGeometry) => ReactNode;
}

/** Scales, axes and the two stacked layers. Marks come from the caller. */
export function ChartFrame({ labelledBy, label, height = 260, margin, xTicks, yTicks, marks, hits }: ChartFrameProps) {
  const ref = useRef<HTMLDivElement>(null);
  const width = useChartWidth(ref);
  const m: ChartMargin = { top: 16, right: 16, bottom: 28, left: 40, ...margin };
  const geometry: ChartGeometry = {
    width, height, margin: m, x0: m.left, x1: Math.max(m.left + 1, width - m.right), y0: m.top, y1: height - m.bottom,
  };
  const viewBox = `0 0 ${width} ${height}`;
  return (
    <div ref={ref} className="relative w-full max-w-[760px]">
      <svg
        role="img"
        aria-labelledby={labelledBy}
        aria-label={labelledBy ? undefined : label}
        viewBox={viewBox}
        width={width}
        height={height}
        className="block"
      >
        {yTicks(geometry).map((tick) => (
          <g key={tick.label}>
            <line
              x1={geometry.x0} x2={geometry.x1} y1={tick.at} y2={tick.at}
              className="stroke-line-subtle" strokeWidth={1}
            />
            <text x={geometry.x0 - 6} y={tick.at} dy="0.32em" textAnchor="end" className="fill-fg-tertiary text-xs">
              {tick.label}
            </text>
          </g>
        ))}
        {xTicks(geometry).map((tick) => (
          <text key={tick.label} x={tick.at} y={geometry.y1 + 18} textAnchor="middle" className="fill-fg-tertiary text-xs">
            {tick.label}
          </text>
        ))}
        {marks(geometry)}
        <line
          x1={geometry.x0} x2={geometry.x1} y1={geometry.y1} y2={geometry.y1}
          className="stroke-line-strong" strokeWidth={1}
        />
      </svg>
      {hits && (
        <svg
          role="group"
          aria-label="Chart marks"
          viewBox={viewBox}
          width={width}
          height={height}
          className="absolute inset-0"
        >
          {hits(geometry)}
        </svg>
      )}
    </div>
  );
}

export interface ReferenceLine {
  /** Pixel position on the y axis. */
  y: number;
  label: string;
  dash?: string;
  strokeWidth?: number;
}

/** The right margin a chart reserves for reference-line labels ("85th · 12.6d"). */
export const REFERENCE_LABEL_MARGIN = 84;

/**
 * Horizontal reference lines, directly labelled in the right margin: outside the
 * plot, so a label never overprints a mark. Labels of nearly equal lines spread.
 */
export function ChartReferenceLines({ lines, geometry }: { lines: ReferenceLine[]; geometry: ChartGeometry }) {
  const labelY = spreadLabels(lines.map((line) => line.y), 14);
  return (
    <g>
      {lines.map((line, index) => (
        <g key={line.label}>
          <line
            x1={geometry.x0} x2={geometry.x1} y1={line.y} y2={line.y}
            stroke={CHART_HUE} strokeWidth={line.strokeWidth ?? 1.5} strokeDasharray={line.dash}
          />
          <text x={geometry.x1 + 6} y={labelY[index]} dy="0.32em" className="fill-fg-secondary text-xs">
            {line.label}
          </text>
        </g>
      ))}
    </g>
  );
}

function activateOnKey(event: KeyboardEvent, onSelect: () => void) {
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    onSelect();
  }
}

interface ChartHitProps {
  /** The accessible name, also the hover tooltip. */
  label: string;
  onSelect: () => void;
  /**
   * In the tab order. Off by default: a chart can hold hundreds of marks, so the
   * complete keyboard path is its table, and only marks a design names as tab
   * stops take one.
   */
  tabbable?: boolean;
}

/** A point's interactive target: 24px whatever the mark's size, ringed on hover and focus. */
export function ChartPointHit({ x, y, label, onSelect, tabbable = false }: ChartHitProps & { x: number; y: number }) {
  return (
    <g
      role="button"
      aria-label={label}
      tabIndex={tabbable ? 0 : -1}
      onClick={onSelect}
      onKeyDown={(event) => activateOnKey(event, onSelect)}
      className="group cursor-pointer outline-none"
    >
      <title>{label}</title>
      <circle cx={x} cy={y} r={12} fill="transparent" />
      <circle
        cx={x} cy={y} r={8} fill="none" stroke={CHART_HUE} strokeWidth={2}
        className="opacity-0 group-hover:opacity-100 group-focus:opacity-100 transition-opacity motion-reduce:transition-none"
      />
    </g>
  );
}

/** A vertical slice's interactive target (one day of an area chart). */
export function ChartBandHit({
  x, width, geometry, label, onSelect,
}: ChartHitProps & { x: number; width: number; geometry: ChartGeometry }) {
  return (
    <g
      role="button"
      aria-label={label}
      tabIndex={-1}
      onClick={onSelect}
      onKeyDown={(event) => activateOnKey(event, onSelect)}
      className="group cursor-pointer outline-none"
    >
      <title>{label}</title>
      <rect x={x} y={geometry.y0} width={width} height={geometry.y1 - geometry.y0} fill="transparent" />
      <line
        x1={x + width / 2} x2={x + width / 2} y1={geometry.y0} y2={geometry.y1}
        stroke={CHART_HUE} strokeWidth={1}
        className="opacity-0 group-hover:opacity-100 group-focus:opacity-100"
      />
    </g>
  );
}

/** A missing value in a chart table: never `0`, never blank (§ Summary and analytics table layout). */
export function ChartNullValue() {
  return <span className="text-fg-muted">—</span>;
}

export interface ChartTableColumn<Row> {
  key: string;
  header: string;
  numeric?: boolean;
  render: (row: Row) => ReactNode;
}

interface ChartTableProps<Row> {
  label: string;
  columns: ChartTableColumn<Row>[];
  rows: Row[];
  rowKey: (row: Row) => string;
  emptyText?: string;
}

/**
 * The data-table fallback, and the chart's complete keyboard path. It scrolls in
 * a focusable region, so a keyboard user can reach every row of a long table.
 */
export function ChartTable<Row>({ label, columns, rows, rowKey, emptyText = "No data in this range." }: ChartTableProps<Row>) {
  if (rows.length === 0) return <p className="text-sm text-fg-tertiary py-6 text-center">{emptyText}</p>;
  return (
    // tabIndex: a scrollable region must be keyboard-focusable (WCAG 2.1.1).
    <div role="region" aria-label={label} tabIndex={0} className="overflow-auto max-h-72 focus:outline-none focus:ring-2 focus:ring-primary-emphasis rounded">
      <table className="w-full text-sm border-collapse">
        <thead>
          <tr className="text-left text-xs text-fg-tertiary uppercase tracking-wide">
            {columns.map((column, index) => (
              <th
                key={column.key}
                scope="col"
                className={`sticky top-0 bg-surface pb-2 pr-3 font-medium whitespace-nowrap ${
                  column.numeric ? "text-right" : ""
                } ${index === 0 ? "left-0 z-20" : "z-10"}`}
              >
                {column.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={rowKey(row)} className="border-t border-line">
              {columns.map((column, index) => (
                <td
                  key={column.key}
                  className={`py-1.5 pr-3 ${column.numeric ? "text-right font-mono text-fg-secondary" : "text-fg-secondary"} ${
                    index === 0 ? "sticky left-0 z-10 bg-surface max-w-[14rem] truncate" : "whitespace-nowrap"
                  }`}
                >
                  {column.render(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export type ChartPanelView = "chart" | "table";

interface ChartPanelProps {
  title: string;
  /** One sentence stating what the data says. */
  summary: string;
  /** Short facts below the chart: a sparse-data note, what a mark shape means. */
  notes?: string[];
  /** A definition quoted below the chart. */
  definition?: string;
  table: ReactNode;
  children: (labelledBy: string) => ReactNode;
  testId?: string;
}

/** One chart with its heading, Chart | Table toggle and finding sentence. */
export function ChartPanel({ title, summary, notes = [], definition, table, children, testId }: ChartPanelProps) {
  const [view, setView] = useState<ChartPanelView>("chart");
  const id = useId();
  const headingId = `${id}-heading`;
  const summaryId = `${id}-summary`;
  return (
    <section
      aria-labelledby={headingId}
      data-testid={testId}
      className="bg-surface border border-line rounded-lg p-4 flex flex-col gap-2 min-w-0"
    >
      <div className="flex items-center justify-between gap-3">
        <h2 id={headingId} className="text-sm font-semibold text-fg">{title}</h2>
        <div className="flex rounded overflow-hidden border border-line-strong shrink-0" role="group" aria-label={`${title} view`}>
          {(["chart", "table"] as ChartPanelView[]).map((option, index) => (
            <button
              key={option}
              type="button"
              onClick={() => setView(option)}
              aria-pressed={view === option}
              className={`px-3 py-1 text-xs capitalize transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis focus:ring-inset ${
                index === 0 ? "border-r border-line-strong" : ""
              } ${
                view === option
                  ? "bg-primary text-on-primary"
                  : "text-fg-tertiary hover:text-fg-secondary hover:bg-surface-hover"
              }`}
            >
              {option}
            </button>
          ))}
        </div>
      </div>
      <p id={summaryId} className="text-sm text-fg-secondary">{summary}</p>
      {view === "chart" ? children(`${headingId} ${summaryId}`) : table}
      {notes.map((note) => (
        <p key={note} className="text-xs text-fg-tertiary">{note}</p>
      ))}
      {definition && <p className="text-xs text-fg-tertiary">{definition}</p>}
    </section>
  );
}
