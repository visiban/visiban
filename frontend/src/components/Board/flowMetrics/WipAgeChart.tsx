import { ChartFrame, ChartPointHit, ChartReferenceLines, REFERENCE_LABEL_MARGIN } from "../../Common/Chart";
import { CHART_HUE, axisTicks, chartTint, linearScale, niceCeil } from "../../../utils/chartScale";
import type { FlowAgeSample, FlowCard, FlowWipAge } from "../../../types";
import { ageMarkLabel, percentileLines } from "./flowFormat";

const COLUMN_LABEL_CHARS = 12;
const RING_LABEL_CHARS = 10;
const RING_LABEL_WIDTH = 80;
// Oldest first. A wall of ring labels would overprint; the table lists every card.
const MAX_RING_LABELS = 8;

const shorten = (text: string, limit: number) => (text.length > limit ? `${text.slice(0, limit - 1)}…` : text);

interface Placed {
  sample: FlowAgeSample;
  x: number;
  y: number;
  pastP85: boolean;
}

interface Props {
  data: FlowWipAge;
  cards: Map<string, FlowCard>;
  labelledBy: string;
  onSelect: (sample: FlowAgeSample) => void;
}

/**
 * Each in-progress card over its column, by age. The zones are cycle-time
 * percentiles: a dot in them is already older than most finished cards ever got.
 * Blocked cards are squares; cards past P85 are ringed and named.
 */
export default function WipAgeChart({ data, cards, labelledBy, onSelect }: Props) {
  const zones = data.cycle_time_percentiles;
  const top = niceCeil(Math.max(1, ...data.samples.map((s) => s.value_days), zones.p95 ?? zones.p85 ?? 0));
  const columnIndex = new Map(data.columns.map((column, index) => [column.column_uid, index]));
  const bandwidth = (x0: number, x1: number) => (x1 - x0) / Math.max(1, data.columns.length);

  const place = (x0: number, x1: number, y0: number, y1: number): Placed[] => {
    const width = bandwidth(x0, x1);
    const y = linearScale([0, top], [y1, y0]);
    const seen = new Map<string, number>();
    return data.samples.map((sample) => {
      const nth = seen.get(sample.column_uid) ?? 0;
      seen.set(sample.column_uid, nth + 1);
      // Deterministic spread, so a reload keeps every dot where it was.
      const step = Math.min(12, width / 6);
      const offset = ((nth % 5) - 2) * step;
      return {
        sample,
        x: x0 + width * ((columnIndex.get(sample.column_uid) ?? 0) + 0.5) + offset,
        y: y(sample.value_days),
        pastP85: zones.p85 !== null && sample.value_days > zones.p85,
      };
    });
  };

  return (
    <ChartFrame
      labelledBy={labelledBy}
      margin={{ right: REFERENCE_LABEL_MARGIN }}
      xTicks={({ x0, x1 }) => {
        const width = bandwidth(x0, x1);
        return data.columns.map((column, index) => ({
          at: x0 + width * (index + 0.5),
          label: shorten(column.column_name, COLUMN_LABEL_CHARS),
        }));
      }}
      yTicks={({ y0, y1 }) => {
        const y = linearScale([0, top], [y1, y0]);
        return axisTicks(top).map((tick) => ({ at: y(tick), label: `${tick}d` }));
      }}
      marks={(geometry) => {
        const y = linearScale([0, top], [geometry.y1, geometry.y0]);
        const placed = place(geometry.x0, geometry.x1, geometry.y0, geometry.y1);
        const named = new Set(
          placed.filter((p) => p.pastP85).sort((a, b) => a.y - b.y).slice(0, MAX_RING_LABELS).map((p) => p.sample.card_uid),
        );
        const width = geometry.x1 - geometry.x0;
        return (
          <>
            {zones.p85 !== null && (
              <rect
                x={geometry.x0} width={width} y={zones.p95 !== null ? y(zones.p95) : geometry.y0}
                height={y(zones.p85) - (zones.p95 !== null ? y(zones.p95) : geometry.y0)}
                fill={chartTint(0.08)}
              />
            )}
            {zones.p95 !== null && (
              <rect x={geometry.x0} width={width} y={geometry.y0} height={y(zones.p95) - geometry.y0} fill={chartTint(0.16)} />
            )}
            <ChartReferenceLines lines={percentileLines(zones, y)} geometry={geometry} />
            {placed.map(({ sample, x, y: cy, pastP85 }) => (
              <g key={sample.card_uid} data-blocked={sample.is_blocked || undefined}>
                {pastP85 && <circle cx={x} cy={cy} r={8} fill="none" stroke={CHART_HUE} strokeWidth={1.5} />}
                {sample.is_blocked ? (
                  <rect x={x - 4} y={cy - 4} width={8} height={8} fill={CHART_HUE} />
                ) : (
                  <circle cx={x} cy={cy} r={4} fill={CHART_HUE} />
                )}
                {named.has(sample.card_uid) && (
                  // On the side with room, so a name in the last column stays in the plot.
                  <text
                    x={x > geometry.x1 - RING_LABEL_WIDTH ? x - 11 : x + 11}
                    y={cy}
                    dy="0.32em"
                    textAnchor={x > geometry.x1 - RING_LABEL_WIDTH ? "end" : "start"}
                    className="fill-fg text-xs"
                  >
                    {shorten(cards.get(sample.card_uid)?.title ?? sample.card_uid, RING_LABEL_CHARS)}
                  </text>
                )}
              </g>
            ))}
          </>
        );
      }}
      hits={(geometry) =>
        place(geometry.x0, geometry.x1, geometry.y0, geometry.y1).map(({ sample, x, y }) => (
          <ChartPointHit
            key={sample.card_uid}
            x={x}
            y={y}
            tabbable
            label={ageMarkLabel(sample, cards.get(sample.card_uid)?.title ?? sample.card_uid, zones)}
            onSelect={() => onSelect(sample)}
          />
        ))
      }
    />
  );
}

