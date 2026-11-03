import { useId } from "react";
import { ChartBandHit, ChartFrame } from "../../Common/Chart";
import { CHART_HUE, axisTicks, chartTint, linearScale, niceCeil, spreadLabels } from "../../../utils/chartScale";
import type { FlowCumulativeFlow } from "../../../types";
import { bandKey, bandName, formatDate } from "./flowFormat";

const LABEL_CHARS = 16;

function shorten(name: string) {
  return name.length > LABEL_CHARS ? `${name.slice(0, LABEL_CHARS - 1)}…` : name;
}

interface Props {
  data: FlowCumulativeFlow;
  labelledBy: string;
  onSelectDay: (date: string) => void;
}

/**
 * One-hue alpha bands, 1px separators and direct labels; the bottleneck band is
 * hatched. Finished work sits at the bottom, so the top edge is arrivals and the
 * done band's top edge is departures: the gap between them is work in progress.
 */
export default function CumulativeFlowChart({ data, labelledBy, onSelectDay }: Props) {
  const hatchId = `cfd-hatch-${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
  const { days } = data;
  // Bottom of the stack first. The deleted band is shown only when it holds cards.
  const bands = [...data.columns]
    .reverse()
    .filter((column) => column.column_uid !== null || days.some((day) => (day.counts[bandKey(column)] ?? 0) > 0));
  const totals = days.map((day) => bands.reduce((sum, band) => sum + (day.counts[bandKey(band)] ?? 0), 0));
  const top = niceCeil(Math.max(1, ...totals));
  const xScale = (x0: number, x1: number) => linearScale([0, Math.max(1, days.length - 1)], [x0, x1]);
  return (
    <ChartFrame
      labelledBy={labelledBy}
      margin={{ right: 112 }}
      xTicks={({ x0, x1 }) => {
        const x = xScale(x0, x1);
        const stride = Math.max(1, Math.ceil(days.length / 4));
        return days.flatMap((day, index) =>
          index % stride === 0 ? [{ at: x(index), label: formatDate(day.date) }] : [],
        );
      }}
      yTicks={({ y0, y1 }) => {
        const y = linearScale([0, top], [y1, y0]);
        return axisTicks(top).map((tick) => ({ at: y(tick), label: String(tick) }));
      }}
      marks={(geometry) => {
        const x = xScale(geometry.x0, geometry.x1);
        const y = linearScale([0, top], [geometry.y1, geometry.y0]);
        const running = days.map(() => 0);
        const labels: { key: string; text: string; y: number }[] = [];
        const paths = bands.map((band, bandIndex) => {
          const key = bandKey(band);
          const lower = running.map((value, i) => `${x(i)},${y(value)}`);
          const lastLower = running[running.length - 1] ?? 0;
          days.forEach((day, i) => { running[i] += day.counts[key] ?? 0; });
          const upper = running.map((value, i) => `${x(i)},${y(value)}`);
          const lastUpper = running[running.length - 1] ?? 0;
          const isBottleneck = band.column_uid !== null && band.column_uid === data.bottleneck_column_uid;
          if (lastUpper > lastLower) {
            labels.push({ key, text: shorten(bandName(band)), y: y((lastLower + lastUpper) / 2) });
          }
          const alpha = 0.6 - (0.45 * bandIndex) / Math.max(1, bands.length - 1);
          return (
            <g key={key} data-band={key}>
              <polygon
                points={[...upper, ...[...lower].reverse()].join(" ")}
                fill={isBottleneck ? `url(#${hatchId})` : chartTint(Number(alpha.toFixed(2)))}
              />
              <polyline points={upper.join(" ")} fill="none" stroke={CHART_HUE} strokeWidth={1} />
            </g>
          );
        });
        const spread = spreadLabels(labels.map((label) => label.y), 14);
        return (
          <>
            <defs>
              <pattern id={hatchId} patternUnits="userSpaceOnUse" width={6} height={6} patternTransform="rotate(45)">
                <rect width={6} height={6} fill={chartTint(0.2)} />
                <line x1={0} y1={0} x2={0} y2={6} stroke={CHART_HUE} strokeWidth={2} />
              </pattern>
            </defs>
            {paths}
            {labels.map((label, index) => (
              <text key={label.key} x={geometry.x1 + 6} y={spread[index]} dy="0.32em" className="fill-fg-secondary text-xs">
                {label.text}
              </text>
            ))}
          </>
        );
      }}
      hits={(geometry) => {
        const x = xScale(geometry.x0, geometry.x1);
        const width = (geometry.x1 - geometry.x0) / Math.max(1, days.length);
        return days.map((day, index) => (
          <ChartBandHit
            key={day.date}
            x={x(index) - width / 2}
            width={width}
            geometry={geometry}
            label={`${formatDate(day.date)}: ${totals[index]} ${totals[index] === 1 ? "card" : "cards"}`}
            onSelect={() => onSelectDay(day.date)}
          />
        ));
      }}
    />
  );
}
