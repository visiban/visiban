import type { GridOverlayLevelSummary, GridOverlayState } from "../../../gridOverlays/slot";

interface Props {
  state: GridOverlayState;
  /** Faded out while a card or column is being dragged so it never fights the drag. */
  isDragging?: boolean;
  /** Compact single-row form below `lg`, where the full panel eats too much grid. */
  isLargeViewport?: boolean;
}

/** A ramp swatch: tint (color) plus the bottom bar (geometry), on a cell-like chip. */
function Swatch({ level, dimmed = false }: { level: GridOverlayLevelSummary; dimmed?: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={`relative w-6 h-4 rounded bg-canvas border border-line-subtle overflow-hidden shrink-0 ${dimmed ? "opacity-40" : ""}`}
    >
      <span className={`absolute inset-0 ${level.encoding.tintClass}`} />
      <span className={`absolute bottom-0 left-0 right-0 ${level.encoding.barHeightClass} ${level.encoding.barToneClass}`} />
    </span>
  );
}

/** Observed range for a level, or an em dash when no cell landed in it. */
function RangeLabel({ level, format }: { level: GridOverlayLevelSummary; format: (value: number) => string }) {
  // Many screen readers skip a bare em dash, which would leave a step name with no value.
  if (level.count === 0) {
    return (
      <>
        <span aria-hidden="true">—</span>
        <span className="sr-only">no cells</span>
      </>
    );
  }
  if (level.min === level.max) return <>{format(level.min)}</>;
  return <>{`${format(level.min)}–${format(level.max)}`}</>;
}

/**
 * The overlay legend (#1147).
 *
 * Floats over the board scroll container instead of sitting in a strip above it: every
 * above-grid strip in the app is in-flow and `shrink-0`, so it would shrink the
 * `flex-1 min-h-0` scroll container — and "renders above the grid *without displacing
 * it*" is the one hard constraint on this slot. Floating also keeps the legend next to
 * the data it decodes rather than 600px above it.
 *
 * `pointer-events-none` is load-bearing twice over: the panel has nothing interactive
 * in it, and it sits near the horizontal scrollbar, so a graze must never swallow a
 * scrollbar drag or a click on the corner cell. `z-30` is deliberately below
 * `BulkActionToolbar` (`z-40`) and the shared toast region (`z-[55]`) — a transient message
 * always wins over a passive key.
 *
 * `role="group"`, never `role="region"`: the board is capped at four landmarks.
 */
export default function GridOverlayLegend({ state, isDragging = false, isLargeViewport = true }: Props) {
  const opacity = isDragging ? "opacity-0" : "opacity-100";
  // "nothing on this board" is false when the board is full of cards and the filter bar
  // is what left the overlay with nothing to scale.
  const emptyCopy = state.isFiltered
    ? "No values match the active filters."
    : "No values on this board yet.";
  // Lightest first. Only an absolute scale has a step below level 1.
  const steps = state.belowScale ? [state.belowScale, ...state.levels] : state.levels;
  const frame = `absolute bottom-4 right-4 z-30 pointer-events-none select-none bg-surface border border-line rounded-lg shadow-xl transition-opacity duration-150 ${opacity}`;

  if (!isLargeViewport) {
    // Compact form: the ramp reads left-to-right like a colorbar, no per-level ranges.
    return (
      <div role="group" aria-label={`${state.label} overlay scale`} className={`${frame} max-w-[calc(100%-2rem)] px-2.5 py-1.5 flex flex-wrap items-center gap-2`}>
        <span className="text-xs font-medium text-fg">{state.label}</span>
        {state.isEmpty ? (
          <span className="text-xs text-fg-muted italic">{emptyCopy}</span>
        ) : (
          <>
            {steps[0].stepLabel && <span className="text-xs text-fg-secondary">{steps[0].stepLabel}</span>}
            <span className="flex items-center gap-1">
              {steps.map((level) => (
                <Swatch key={level.level} level={level} dimmed={level.count === 0} />
              ))}
            </span>
            {steps[steps.length - 1].stepLabel && (
              <span className="text-xs text-fg-secondary">{steps[steps.length - 1].stepLabel}</span>
            )}
            {state.note && <span className="text-xs text-fg-secondary">{state.note}</span>}
            <span className="sr-only">
              {state.belowScale ? "Five steps" : "Four levels"}, lightest to darkest. Highest value {state.formatValue(state.max)}.
            </span>
          </>
        )}
      </div>
    );
  }

  return (
    <div role="group" aria-label={`${state.label} overlay scale`} className={`${frame} w-52 px-3 py-2 flex flex-col gap-1.5`}>
      <div>
        <p className="text-xs font-medium text-fg">{state.label}</p>
        <p className="text-xs text-fg-muted leading-snug">{state.description}</p>
      </div>
      {state.isEmpty ? (
        // One-line empty state — the centered-icon pattern is for a surface with
        // nothing in it, and the board is full of cards. `text-fg-muted`, not
        // `text-fg-faint`: faint is a decorative tone, too low-contrast for the only
        // sentence the panel is showing.
        <p className="text-xs text-fg-muted italic">{emptyCopy}</p>
      ) : (
        // Descending, so the tallest bar is at the top and the eye lands on the
        // busiest step first. The ranges can include values from cells that are
        // *collapsed* to count stubs rather than shaded — that is deliberate: folding a
        // lane must not silently re-scale the rest of the board. Hidden columns and
        // swimlanes are excluded upstream, in `buildGridOverlayState`.
        [...steps].reverse().map((level) => (
          <div key={level.level} className="flex items-center gap-2">
            <span className="sr-only">{level.encoding.levelLabel}: </span>
            <Swatch level={level} dimmed={level.count === 0} />
            {/* An absolute scale names its step, and the range is what landed in it. */}
            {level.stepLabel && <span className="w-14 shrink-0 text-xs text-fg-secondary">{level.stepLabel}</span>}
            <span className={`text-xs tabular-nums flex-1 ${level.count === 0 ? "text-fg-muted" : "text-fg-secondary"}`}>
              <RangeLabel level={level} format={state.formatValue} />
            </span>
          </div>
        ))
      )}
      {!state.isEmpty && state.note && <p className="text-xs text-fg-secondary leading-snug">{state.note}</p>}
    </div>
  );
}
