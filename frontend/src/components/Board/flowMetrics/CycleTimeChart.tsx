import { ChartFrame, ChartPointHit, ChartReferenceLines, REFERENCE_LABEL_MARGIN } from "../../Common/Chart";
import { CHART_HUE, axisTicks, chartTint, linearScale, niceCeil } from "../../../utils/chartScale";
import type { FlowCard, FlowCycleTime, FlowCycleTimeSample } from "../../../types";
import { formatDate, formatDays, percentileLines } from "./flowFormat";

const DAY_MS = 86_400_000;

interface Props {
  data: FlowCycleTime;
  cards: Map<string, FlowCard>;
  days: number;
  labelledBy: string;
  onSelect: (sample: FlowCycleTimeSample) => void;
}

/** One point per completed card, x its completion, y its cycle time. */
export default function CycleTimeChart({ data, cards, days, labelledBy, onSelect }: Props) {
  const now = Date.now();
  const domain: [number, number] = [now - days * DAY_MS, now];
  const top = niceCeil(
    Math.max(1, ...data.samples.map((s) => s.value_days), data.percentiles.p95 ?? 0),
  );
  return (
    <ChartFrame
      labelledBy={labelledBy}
      margin={{ right: REFERENCE_LABEL_MARGIN }}
      xTicks={({ x0, x1 }) => {
        const x = linearScale(domain, [x0, x1]);
        return [0.1, 0.5, 0.9].map((share) => {
          const at = domain[0] + (domain[1] - domain[0]) * share;
          return { at: x(at), label: formatDate(at) };
        });
      }}
      yTicks={({ y0, y1 }) => {
        const y = linearScale([0, top], [y1, y0]);
        return axisTicks(top).map((tick) => ({ at: y(tick), label: `${tick}d` }));
      }}
      marks={(geometry) => {
        const x = linearScale(domain, [geometry.x0, geometry.x1]);
        const y = linearScale([0, top], [geometry.y1, geometry.y0]);
        return (
          <>
            {data.samples.map((sample) => (
              <circle
                key={sample.card_uid}
                cx={x(new Date(sample.end).getTime())}
                cy={y(sample.value_days)}
                r={4}
                // Hollow marks a card reopened later: rework stays visible
                // without changing its number (ADR "Reopened cards").
                fill={sample.reopened ? "none" : chartTint(0.55)}
                stroke={CHART_HUE}
                strokeWidth={1.5}
              />
            ))}
            <ChartReferenceLines lines={percentileLines(data.percentiles, y)} geometry={geometry} />
          </>
        );
      }}
      hits={(geometry) => {
        const x = linearScale(domain, [geometry.x0, geometry.x1]);
        const y = linearScale([0, top], [geometry.y1, geometry.y0]);
        return data.samples.map((sample) => (
          <ChartPointHit
            key={sample.card_uid}
            x={x(new Date(sample.end).getTime())}
            y={y(sample.value_days)}
            label={`${cards.get(sample.card_uid)?.title ?? sample.card_uid}, ${formatDays(sample.value_days)} cycle time`}
            onSelect={() => onSelect(sample)}
          />
        ));
      }}
    />
  );
}
