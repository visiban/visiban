import { ChartFrame, ChartPointHit, ChartReferenceLines, REFERENCE_LABEL_MARGIN } from "../../Common/Chart";
import { CHART_HUE, LINE_DASH, axisTicks, linearScale, niceCeil } from "../../../utils/chartScale";
import type { FlowThroughput, FlowThroughputSample } from "../../../types";
import { formatDate } from "./flowFormat";

interface Props {
  data: FlowThroughput;
  labelledBy: string;
  onSelect: (sample: FlowThroughputSample) => void;
}

/** The weekly run chart: values printed on the points, the median dashed and labelled. */
export default function ThroughputChart({ data, labelledBy, onSelect }: Props) {
  const { samples } = data;
  const top = niceCeil(Math.max(1, ...samples.map((s) => s.count), data.median ?? 0));
  const xScale = (x0: number, x1: number) => linearScale([0, Math.max(1, samples.length - 1)], [x0 + 8, x1 - 8]);
  return (
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
  );
}
