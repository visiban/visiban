import { ChartFrame, ChartPointHit, ChartReferenceLines, REFERENCE_LABEL_MARGIN } from "../../Common/Chart";
import { CHART_COLORS, CHART_HUE, ISOLATED_OPACITY, LINE_DASH, axisTicks, linearScale, niceCeil } from "../../../utils/chartScale";
import type { FlowThroughput, FlowThroughputSample } from "../../../types";
import { colorOfGroup } from "./breakdown";
import { formatDate } from "./flowFormat";

interface Props {
  data: FlowThroughput;
  labelledBy: string;
  onSelect: (sample: FlowThroughputSample) => void;
  /** The isolated group's index under a breakdown (#2268); the rest drop to 20%. */
  isolated?: number | null;
}

const STARTED_OFFSET = 10;
const DIAMOND_RADIUS = 4.5;
// The plot's right inset keeps the last diamond (offset right of its week) inside the plot, clear of the
// reference-label column that starts 6px past x1.
const PLOT_INSET_RIGHT = STARTED_OFFSET + DIAMOND_RADIUS + 3;

/** A stacked week's drawn height: by_group can sum above `count` (a card counts once per label) or below it (cards with no value are left out). */
const stackTotal = (s: FlowThroughputSample) => (s.by_group ?? []).reduce((sum, part) => sum + part.count, 0);

/** A hollow diamond centered on (x, y): the "started" marker, a shape distinct from the finished dot. */
const diamond = (x: number, y: number, r = DIAMOND_RADIUS) => `${x},${y - r} ${x + r},${y} ${x},${y + r} ${x - r},${y}`;

/** What the two marks mean, in the shapes the chart draws (color is never the only carrier). */
function ThroughputLegend({ stacked }: { stacked: boolean }) {
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-fg-secondary" aria-label="Legend" data-testid="throughput-legend">
      <li className="flex items-center gap-1.5">
        <svg width={12} height={12} aria-hidden="true">
          {stacked
            ? <><rect x={1} y={6} width={10} height={5} fill={colorOfGroup([], 0)} /><rect x={1} y={1} width={10} height={5} fill={colorOfGroup([], 1)} /></>
            : <circle cx={6} cy={6} r={4} fill={CHART_HUE} />}
        </svg>
        {stacked ? "Finished, stacked by group" : "Finished"}
      </li>
      <li className="flex items-center gap-1.5">
        <svg width={12} height={12} aria-hidden="true">
          <polygon points={diamond(6, 6)} fill="none" stroke={CHART_COLORS.neutral} strokeWidth={1.5} />
        </svg>
        Started
      </li>
    </ul>
  );
}

/**
 * The weekly run chart: values printed on the points, the median dashed and
 * labeled, and a hollow diamond per week for cards started (#2260, #2264).
 */
export default function ThroughputChart({ data, labelledBy, onSelect, isolated = null }: Props) {
  const { samples } = data;
  const groups = data.grouping?.groups ?? [];
  const stacked = groups.length > 0;
  const top = niceCeil(Math.max(1, ...samples.map((s) => Math.max(s.count, s.started, stackTotal(s))), data.median ?? 0));
  const xScale = (x0: number, x1: number) => linearScale([0, Math.max(1, samples.length - 1)], [x0 + 8, x1 - PLOT_INSET_RIGHT]);
  return (
    <>
    <ChartFrame
      labelledBy={labelledBy}
      margin={{ right: REFERENCE_LABEL_MARGIN }}
      xTicks={({ x0, x1 }) => {
        const x = xScale(x0, x1);
        const stride = Math.max(1, Math.ceil(samples.length / 4));
        return samples.flatMap((sample, index) =>
          index % stride === 0 ? [{ at: x(index), label: formatDate(sample.start) }] : [],
        );
      }}
      yTicks={({ y0, y1 }) => {
        const y = linearScale([0, top], [y1, y0]);
        return axisTicks(top).map((tick) => ({ at: y(tick), label: String(tick) }));
      }}
      marks={(geometry) => {
        const x = xScale(geometry.x0, geometry.x1);
        const y = linearScale([0, top], [geometry.y1, geometry.y0]);
        const barWidth = Math.max(4, Math.min(12, ((x(Math.max(1, samples.length - 1)) - x(0)) / Math.max(1, samples.length - 1)) * 0.6));
        const points = samples.map((sample, index) => `${x(index)},${y(sample.count)}`).join(" ");
        return (
          <>
            {data.median !== null && (
              <ChartReferenceLines
                lines={[{ y: y(data.median), label: `Median · ${data.median}`, dash: LINE_DASH.dashed }]}
                geometry={geometry}
              />
            )}
            {stacked ? samples.map((sample, index) => {
              // One segment per group, bottom to top in group order; Other is last and neutral.
              let base = 0;
              return (
                <g key={sample.start} data-stacked-week={sample.start}>
                  {(sample.by_group ?? []).map((part, gi) => {
                    const from = base;
                    base += part.count;
                    if (part.count === 0) return null;
                    return (
                      <rect
                        key={part.key ?? "other"}
                        data-group-index={gi}
                        x={x(index) - barWidth / 2}
                        width={barWidth}
                        y={y(base)}
                        height={y(from) - y(base)}
                        fill={colorOfGroup(groups, gi)}
                        stroke="rgb(var(--surface))"
                        strokeWidth={1}
                        opacity={isolated === null || isolated === gi ? 1 : ISOLATED_OPACITY}
                      />
                    );
                  })}
                  <text x={x(index)} y={y(Math.max(sample.count, stackTotal(sample))) - 6} textAnchor="middle" className="fill-fg text-xs">
                    {sample.count}
                  </text>
                </g>
              );
            }) : (
              <>
                <polyline points={points} fill="none" stroke={CHART_HUE} strokeWidth={2} />
                {samples.map((sample, index) => (
                  <g key={sample.start}>
                    <circle cx={x(index)} cy={y(sample.count)} r={4} fill={CHART_HUE} />
                    <text x={x(index)} y={y(sample.count) - 9} textAnchor="middle" className="fill-fg text-xs">
                      {sample.count}
                    </text>
                  </g>
                ))}
              </>
            )}
            {samples.map((sample, index) => (
              <polygon
                key={`started-${sample.start}`}
                data-started={sample.started}
                points={diamond(x(index) + STARTED_OFFSET, y(sample.started))}
                fill="none"
                stroke={CHART_COLORS.neutral}
                strokeWidth={1.5}
              />
            ))}
          </>
        );
      }}
      hits={(geometry) => {
        const x = xScale(geometry.x0, geometry.x1);
        const y = linearScale([0, top], [geometry.y1, geometry.y0]);
        return samples
          .filter((sample) => sample.count > 0)
          .map((sample) => (
            <ChartPointHit
              key={sample.start}
              x={x(samples.indexOf(sample))}
              y={y(sample.count)}
              label={`Week of ${formatDate(sample.start)}: ${sample.count} ${sample.count === 1 ? "card" : "cards"}`}
              onSelect={() => onSelect(sample)}
            />
          ));
      }}
    />
    {samples.length > 0 && <ThroughputLegend stacked={stacked} />}
    </>
  );
}
