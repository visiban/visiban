import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";

/** Gap kept between a fixed popover and the viewport edge (#1455). */
export const POPOVER_VIEWPORT_MARGIN = 8;

/** Which side of the anchor a `below`-mode popover was placed on. */
export type AnchoredSide = "below" | "above" | "pinned";

interface PlacementInput {
  anchorTop: number;
  anchorBottom: number;
  height: number;
  viewportHeight: number;
  mode?: "below" | "side";
  margin?: number;
  gap?: number;
  /**
   * The side chosen earlier; kept while the popover still fits there (#1457).
   * A re-measure while it is open (a filter shrinking the list) must not flip
   * it across the trigger: an upward menu keeps its bottom edge at the
   * trigger, a downward one its top edge, a pinned one stays pinned. A list
   * that only shrinks therefore never changes side. When it has *grown* past
   * the edge on its locked side, the side is chosen again from scratch (below,
   * else above, else pinned) rather than sliding the panel over the trigger,
   * which would cover the field being typed in.
   */
  lockedSide?: AnchoredSide;
}

/**
 * Where a `fixed` popover's top edge goes, from its *measured* height (#1455),
 * plus the side that produced it.
 *
 * `below` (the default): under the anchor if it fits, else above it, else
 * pinned to the viewport's bottom edge. `side`: a flyout whose top aligns with
 * the anchor's top; it only slides up as far as needed to stay on screen.
 * Never estimate `height` from an item count — a popover sized to its content
 * is the whole point.
 */
export function computeAnchoredPlacement({
  anchorTop, anchorBottom, height, viewportHeight, mode = "below",
  margin = POPOVER_VIEWPORT_MARGIN, gap = 4, lockedSide,
}: PlacementInput): { top: number; side: AnchoredSide } {
  const pinned = Math.max(margin, viewportHeight - margin - height);
  if (mode === "side") {
    return anchorTop + height <= viewportHeight - margin
      ? { top: Math.max(margin, anchorTop), side: "below" }
      : { top: pinned, side: "pinned" };
  }
  const below = anchorBottom + gap;
  const above = anchorTop - gap - height;
  const fitsBelow = below + height <= viewportHeight - margin;
  const fitsAbove = above >= margin;
  if (lockedSide === "below" && fitsBelow) return { top: below, side: "below" };
  if (lockedSide === "above" && fitsAbove) return { top: above, side: "above" };
  if (lockedSide === "pinned") return { top: pinned, side: "pinned" };
  // Unlocked, or grown past the edge on its locked side: choose again.
  if (fitsBelow) return { top: below, side: "below" };
  if (fitsAbove) return { top: above, side: "above" };
  return { top: pinned, side: "pinned" };
}

/** `computeAnchoredPlacement`'s `top` alone. */
export function computeAnchoredTop(input: PlacementInput): number {
  return computeAnchoredPlacement(input).top;
}

/**
 * Imperative counterpart of `useAnchoredPlacement` for a popup that is not a
 * React child, such as the Tiptap mention suggestion popup (#1457). Sets the
 * element's `left` and, from its measured height, its `top`; pass back the
 * returned side on later calls so it never flips across the anchor while the
 * list narrows. Start the element `visibility: hidden`; the first call that
 * measures a height places it and shows it. A call that measures no height
 * (not rendered yet, nothing to show, or a transient empty render between two
 * lists) returns `undefined` and leaves its placement and visibility as they
 * were, so a list that empties and refills within one frame is never left
 * hidden.
 */
export function placeFixedElement(
  el: HTMLElement,
  anchor: { top: number; bottom: number; left: number },
  lockedSide?: AnchoredSide,
): AnchoredSide | undefined {
  const height = el.offsetHeight;
  if (height === 0) return undefined;
  el.style.left = `${anchor.left}px`;
  const placement = computeAnchoredPlacement({
    anchorTop: anchor.top, anchorBottom: anchor.bottom, height,
    viewportHeight: window.innerHeight, lockedSide,
  });
  el.style.top = `${placement.top}px`;
  el.style.visibility = "";
  return placement.side;
}

interface Options {
  /** Viewport coordinates of the trigger; `null` while the popover is closed. */
  anchor: { top: number; bottom: number } | null;
  mode?: "below" | "side";
  /** Re-measure when content that changes the panel's height changes. */
  deps?: readonly unknown[];
  /** Called on window `resize`: the trigger moved and the height was fitted to the old viewport. */
  onResize?: () => void;
  /**
   * Called on a scroll anywhere outside the panel (capture phase, so an inner
   * scroll container counts, not just the window): the trigger moved out from
   * under the `fixed` panel. A scroll whose target is inside the panel, such
   * as its own list, is ignored (#1455 rule (c)).
   */
  onOutsideScroll?: () => void;
}

/**
 * Measure-then-place for anchored `fixed` popovers (#1455). Returns `top`, or
 * `null` until the panel has been measured. Keep the panel `visibility:
 * hidden` while `top === null` (the layout effect re-renders before paint, so
 * it never flashes) and move focus only once `top !== null`: browsers ignore
 * `focus()` on a hidden element.
 *
 * The side (below / above / pinned) is chosen on the first measurement for a
 * given anchor and kept on later re-measures while the panel still fits there
 * (#1457), so a list that shrinks as the user types stays adjacent to its
 * trigger instead of jumping across it; a list that grows past that edge has
 * its side chosen again rather than sliding over the trigger.
 */
export function useAnchoredPlacement(
  panelRef: RefObject<HTMLElement | null>,
  { anchor, mode = "below", deps = [], onResize, onOutsideScroll }: Options,
): number | null {
  const [top, setTop] = useState<number | null>(null);
  const anchorTop = anchor?.top;
  const anchorBottom = anchor?.bottom;
  // The side picked for the current anchor; cleared when the anchor changes.
  const lockRef = useRef<{ anchorTop: number; anchorBottom: number; side: AnchoredSide } | null>(null);

  useLayoutEffect(() => {
    if (anchorTop === undefined || anchorBottom === undefined) {
      lockRef.current = null;
      setTop(null);
      return;
    }
    const lock = lockRef.current;
    const lockedSide = lock && lock.anchorTop === anchorTop && lock.anchorBottom === anchorBottom
      ? lock.side
      : undefined;
    const placement = computeAnchoredPlacement({
      anchorTop, anchorBottom, mode, lockedSide,
      height: panelRef.current?.offsetHeight ?? 0,
      viewportHeight: window.innerHeight,
    });
    lockRef.current = { anchorTop, anchorBottom, side: placement.side };
    setTop(placement.top);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `deps` is the caller's list of height-affecting inputs
  }, [anchorTop, anchorBottom, mode, panelRef, ...deps]);

  useEffect(() => {
    if (!onResize || anchorTop === undefined) return;
    // Called with no arguments: a caller's dismiss callback may take its own.
    const handler = () => onResize();
    window.addEventListener("resize", handler);
    return () => window.removeEventListener("resize", handler);
  }, [onResize, anchorTop]);

  useEffect(() => {
    if (!onOutsideScroll || anchorTop === undefined) return;
    const onScroll = (e: Event) => {
      if (e.target instanceof Node && panelRef.current?.contains(e.target)) return;
      onOutsideScroll();
    };
    window.addEventListener("scroll", onScroll, true);
    return () => window.removeEventListener("scroll", onScroll, true);
  }, [onOutsideScroll, anchorTop, panelRef]);

  return top;
}
