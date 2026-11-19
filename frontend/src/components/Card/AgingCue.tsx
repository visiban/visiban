import { staleBadgeToneClass, type AgingStage } from "../../utils/agingTint";

/**
 * Non-color stage cue for an aging-tinted card (#1843, #1863, WCAG 1.4.1).
 *
 * A non-compact card says "Stale Nd" in its status line (every density: the
 * short `Nd` at dense), unless an overdue or due-soon status takes that line.
 * Everywhere else — every compact card, and a card whose status line is
 * overdue or due-soon — the aging tint was the only at-a-glance signal, so the
 * stages differed by hue alone. The yellow `warning` stage never gets the
 * stale status at all, so before #1863 it was told apart from a fresh card by
 * hue and opacity only. CardItem renders this glyph exactly when the card has
 * an aging tint and the stale status line is not on the card; it is hidden
 * whenever that status is stale, at every density.
 *
 * Shape, not text: a compact card is ~77px of content wide (two-column grid
 * in a 220px cell), so `41d` would eat half the title. Three ascending bars
 * with the solid count equal to the stage multiple (1×, 2×, 3×) tell the
 * stages apart by shape; the bars above the stage are ghosted. The warning
 * stage has no solid bar: its shortest bar is drawn hollow (outline only), so
 * it reads as "not yet one bar" — a hint, not an alarm. The hollow outline is
 * at full opacity because it is the only stage-bearing mark; an all-ghost
 * meter would fall below the 3:1 a non-text graphic needs. The day count
 * lives in the accessible name and in the card's own aging tooltip.
 *
 * It sits inline at the start of the title `<p>` so it shares the title's
 * line box and never changes card height. Do not wrap it in `inline-flex`:
 * that moves the line's baseline onto the SVG and shifts the title.
 *
 * The aria-label states age and multiple, never "Stale": the stage is
 * client-computed and the server's `is_stale` can disagree by a day at the
 * edge (see formatAgingTooltip). No `title` attribute — the card's tooltip
 * already opens on hover and keyboard focus with the same information.
 * Because it leads the title, the card button's content-derived name starts
 * with "Idle N days, …" — accepted: the leading position is a hard visual
 * constraint (the bulk-select checkbox covers the trailing edge).
 */

// Solid bar count per stage; `warning` has none and draws its shortest bar hollow.
const SOLID_BARS: Partial<Record<AgingStage, number>> = { warning: 0, stale: 1, stale2x: 2, stale3x: 3 };

// x / y / height of each bar in a 12×12 viewBox, shortest first.
const BARS = [
  { x: 0, y: 7, h: 5 },
  { x: 4.5, y: 3.5, h: 8.5 },
  { x: 9, y: 0, h: 12 },
] as const;

function cueLabel(stage: AgingStage, idleDays: number): string {
  const days = idleDays === 1 ? "1 day" : `${idleDays} days`;
  // "times", not "×": screen readers read "×" as "multiplication sign".
  if (stage === "stale3x") return `Idle ${days}, at least 3 times the stale threshold`;
  if (stage === "stale2x") return `Idle ${days}, at least 2 times the stale threshold`;
  if (stage === "warning") return `Idle ${days}, approaching the stale threshold`;
  return `Idle ${days}, past the stale threshold`;
}

interface AgingCueProps {
  stage: AgingStage;
  idleDays: number;
}

export default function AgingCue({ stage, idleDays }: AgingCueProps) {
  const solid = SOLID_BARS[stage];
  if (solid === undefined) return null;
  return (
    <svg
      role="img"
      aria-label={cueLabel(stage, idleDays)}
      data-aging-cue={stage}
      viewBox="0 0 12 12"
      // Same on-tint tone as the badge (#1550): measured >= 4.55:1 on every
      // stale stage and 6.25 / 5.53:1 (dark / light) on the warning stage,
      // above the 3:1 a non-text graphic needs.
      // -0.125em, not align-baseline: a 12px glyph standing on the baseline
      // leaves under 1px of headroom in a text-xs leading-snug line, so a
      // different font stack could grow the line box. Dropping the feet
      // 0.125em keeps ~1.5px of headroom at text-xs and more at text-sm.
      className={`inline-block w-3 h-3 mr-1 align-[-0.125em] ${staleBadgeToneClass(stage)}`}
    >
      {BARS.map((bar, i) =>
        i === 0 && stage === "warning" ? (
          // Hollow shortest bar: the rect is inset by half the 1-unit stroke so
          // the outline's outer edge matches the filled bar's footprint
          // (x 0–3, y 7–12) and stays inside the viewBox.
          <rect
            key={bar.x}
            x={bar.x + 0.5}
            y={bar.y + 0.5}
            width={2}
            height={bar.h - 1}
            rx={0.5}
            fill="none"
            stroke="currentColor"
            strokeWidth={1}
          />
        ) : (
          <rect
            key={bar.x}
            x={bar.x}
            y={bar.y}
            width={3}
            height={bar.h}
            rx={0.5}
            fill="currentColor"
            // Ghost bars are decorative; the solid bars (or the warning stage's
            // hollow bar) carry the stage.
            opacity={i < solid ? undefined : 0.3}
          />
        ),
      )}
    </svg>
  );
}
