import { ChartFrame, ChartPointHit, ChartReferenceLines, REFERENCE_LABEL_MARGIN } from "../../Common/Chart";
import { CHART_COLORS, CHART_HUE, LINE_DASH, axisTicks, linearScale, niceCeil } from "../../../utils/chartScale";
import type { FlowThroughput, FlowThroughputSample } from "../../../types";
import { formatDate } from "./flowFormat";

interface Props {
  data: FlowThroughput;
  labelledBy: string;
  onSelect: (sample: FlowThroughputSample) => void;
}

const STARTED_OFFSET = 10;
const DIAMOND_RADIUS = 4.5;
// The plot's right inset keeps the last diamond (offset right of its week) inside the plot, clear of the
// reference-label column that starts 6px past x1.
const PLOT_INSET_RIGHT = STARTED_OFFSET + DIAMOND_RADIUS + 3;

/** A hollow diamond centered on (x, y): the "started" marker, a shape distinct from the finished dot. */
const diamond = (x: number, y: number, r = DIAMOND_RADIUS) => `${x},${y - r} ${x + r},${y} ${x},${y + r} ${x - r},${y}`;

/** What the two marks mean, in the shapes the chart draws (color is never the only carrier). */
function ThroughputLegend() {
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-fg-secondary" aria-label="Legend" data-testid="throughput-legend">
      <li className="flex items-center gap-1.5">
        <svg width={12} height={12} aria-hidden="true"><circle cx={6} cy={6} r={4} fill={CHART_HUE} /></svg>
        Finished
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
 * labelled, and a hollow diamond per week for cards started (#2260, #2264).
 */
export default function ThroughputChart({ data, labelledBy, onSelect }: Props) {
  const { samples } = data;
  const top = niceCeil(Math.max(1, ...samples.map((s) => Math.max(s.count, s.started)), data.median ?? 0));
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
        const points = samples.map((sample, index) => `${x(index)},${y(sample.count)}`).join(" ");
        return (
          <>
            {data.median !== null && (
              <ChartReferenceLines
                lines={[{ y: y(data.median), label: `Median · ${data.median}`, dash: LINE_DASH.dashed }]}
                geometry={geometry}
              />
            )}
            <polyline points={points} fill="none" stroke={CHART_HUE} strokeWidth={2} />
            {samples.map((sample, index) => (
              <g key={sample.start}>
                <circle cx={x(index)} cy={y(sample.count)} r={4} fill={CHART_HUE} />
                <text x={x(index)} y={y(sample.count) - 9} textAnchor="middle" className="fill-fg text-xs">
                  {sample.count}
                </text>
              </g>
            ))}
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
    {samples.length > 0 && <ThroughputLegend />}
    </>
  );
}
