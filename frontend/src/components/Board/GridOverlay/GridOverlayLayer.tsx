import type { GridOverlayCellState } from "../../../gridOverlays/slot";
import { formatOverlayValue } from "../../../gridOverlays/scale";

interface Props {
  /** The active overlay's label, e.g. `"Card count"` — read by screen readers. */
  overlayLabel: string;
  cell: GridOverlayCellState;
  /**
   * When the cell's own `aria-label` already carries the overlay reading (empty
   * addable cells, where `role="button"` + `aria-label` on the root discards every
   * descendant's text), the badge must not announce it a second time.
   */
  valueAnnouncedByCell?: boolean;
}

/**
 * One cell's overlay shading (#1147).
 *
 * Rendered as the FIRST child of `BoardCell` and absolutely positioned, which buys two
 * things at once: the grid never reflows when an overlay turns on (the layer is out of
 * flow), and cards, the count badge and the "+ Add card" affordances — all later in DOM
 * order, and `relative` where they were not already positioned — keep painting *above*
 * the tint, so shading a cell never costs legibility of what is in it.
 *
 * Severity arrives pre-encoded from `scale.ts`, which is what keeps #969 satisfied for
 * every overlay at once: tint (color), the bottom bar's height (geometry), and the
 * numeral itself always ship together.
 */
export default function GridOverlayLayer({ overlayLabel, cell, valueAnnouncedByCell = false }: Props) {
  const { encoding, label } = cell;
  const reading = `${overlayLabel}: ${label}, ${encoding.levelLabel}`;
  return (
    <>
      <span aria-hidden="true" className="absolute inset-0 z-0 pointer-events-none">
        <span className={`absolute inset-0 ${encoding.tintClass}`} />
        {/* Non-color channel: a div, so its height is exact on every platform. */}
        <span className={`absolute bottom-0 left-0 right-0 ${encoding.barHeightClass} ${encoding.barToneClass}`} />
      </span>
      {/* Third channel: the value, in the cell's top-right slot. The built-in
          `cards.length` badge stands down while an overlay owns that slot — one scalar
          per corner. No `title`: the badge is pointer-events-none (so a title would
          never fire) and making it hoverable would create a dead zone over the first
          card's corner where a drag cannot start.

          `z-[5]` is exact, not decorative. `CardItem`'s root is `relative z-0`, so a
          z-auto badge earlier in DOM order paints *underneath* the first card and the
          value would be invisible on every populated cell. 5 clears the cards while
          staying below the sticky swimlane label panel (`z-10`) and the sticky header
          row (`z-20`), which a badge must never cover when the grid is scrolled
          horizontally. A hovered card (`hover:z-20`) still lifts above it, which is
          what keeps the card's own selection checkbox usable in the same corner. */}
      <span
        role={valueAnnouncedByCell ? undefined : "img"}
        aria-label={valueAnnouncedByCell ? undefined : reading}
        aria-hidden={valueAnnouncedByCell ? true : undefined}
        className="absolute top-1.5 right-2 z-[5] text-xs font-medium tabular-nums text-fg-secondary select-none pointer-events-none"
      >
        {formatOverlayValue(cell.value)}
      </span>
    </>
  );
}
