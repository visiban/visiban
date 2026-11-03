/** Tokens and pure geometry for the shared SVG chart primitive (#448, #2028). */

/** The one hue every chart draws with, as a raw token so SVG attributes can use it. */
export const CHART_HUE = "rgb(var(--primary-emphasis))";

/** A step of the chart hue. Alpha steps, never a categorical palette. */
export const chartTint = (alpha: number) => `rgb(var(--primary-emphasis) / ${alpha})`;

/** Second encodings for overlapping lines, so they read without color. */
export const LINE_DASH = { dashed: "6 4", dotted: "1.5 3.5" } as const;

export type Scale = (value: number) => number;

/** A linear map from a data domain to pixels. A flat domain maps to the range start. */
export function linearScale(domain: [number, number], range: [number, number]): Scale {
  const [d0, d1] = domain;
  const [r0, r1] = range;
  const span = d1 - d0;
  if (span === 0) return () => r0;
  return (value) => r0 + ((value - d0) / span) * (r1 - r0);
}

/** The smallest 1, 2 or 5 × 10ⁿ at or above `value`, so an axis ends on a readable number. */
export function niceCeil(value: number): number {
  if (value <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const step = [1, 2, 5, 10].find((m) => m * magnitude >= value) ?? 10;
  return step * magnitude;
}

/** Evenly spaced ticks from 0 to `max`, with at most `count` steps of a readable size. */
export function axisTicks(max: number, count = 4): number[] {
  const step = niceCeil(max / count);
  const ticks: number[] = [];
  for (let tick = 0; tick <= max + step / 1000; tick += step) ticks.push(tick);
  return ticks;
}

/**
 * Push label positions apart so none are closer than `gap`, keeping their order.
 * Two percentile lines can sit a pixel apart; their direct labels must not overprint.
 */
export function spreadLabels(positions: number[], gap: number): number[] {
  const order = positions.map((y, index) => ({ y, index })).sort((a, b) => a.y - b.y);
  for (let i = 1; i < order.length; i += 1) {
    if (order[i].y - order[i - 1].y < gap) order[i].y = order[i - 1].y + gap;
  }
  const result = [...positions];
  for (const { y, index } of order) result[index] = y;
  return result;
}
