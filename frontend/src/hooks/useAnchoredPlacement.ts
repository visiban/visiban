import { useEffect, useLayoutEffect, useState, type RefObject } from "react";

/** Gap kept between a fixed popover and the viewport edge (#1455). */
export const POPOVER_VIEWPORT_MARGIN = 8;

/**
 * Where a `fixed` popover's top edge goes, from its *measured* height (#1455).
 *
 * `below` (the default): under the anchor if it fits, else above it, else
 * pinned to the viewport's bottom edge. `side`: a flyout whose top aligns with
 * the anchor's top; it only slides up as far as needed to stay on screen.
 * Never estimate `height` from an item count — a popover sized to its content
 * is the whole point.
 */
export function computeAnchoredTop({
  anchorTop, anchorBottom, height, viewportHeight, mode = "below",
  margin = POPOVER_VIEWPORT_MARGIN, gap = 4,
}: {
  anchorTop: number;
  anchorBottom: number;
  height: number;
  viewportHeight: number;
  mode?: "below" | "side";
  margin?: number;
  gap?: number;
}): number {
  const pinned = Math.max(margin, viewportHeight - margin - height);
  if (mode === "side") {
    return anchorTop + height <= viewportHeight - margin ? Math.max(margin, anchorTop) : pinned;
  }
  const below = anchorBottom + gap;
  const above = anchorTop - gap - height;
  if (below + height <= viewportHeight - margin) return below;
  if (above >= margin) return above;
  return pinned;
}

interface Options {
  /** Viewport coordinates of the trigger; `null` while the popover is closed. */
  anchor: { top: number; bottom: number } | null;
  mode?: "below" | "side";
  /** Re-measure when content that changes the panel's height changes. */
  deps?: readonly unknown[];
  /** Called on window `resize`: the trigger moved and the height was fitted to the old viewport. */
  onResize?: () => void;
}

/**
 * Measure-then-place for anchored `fixed` popovers (#1455). Returns `top`, or
 * `null` until the panel has been measured. Keep the panel `visibility:
 * hidden` while `top === null` (the layout effect re-renders before paint, so
 * it never flashes) and move focus only once `top !== null`: browsers ignore
 * `focus()` on a hidden element.
 */
export function useAnchoredPlacement(
  panelRef: RefObject<HTMLElement | null>,
  { anchor, mode = "below", deps = [], onResize }: Options,
): number | null {
  const [top, setTop] = useState<number | null>(null);
  const anchorTop = anchor?.top;
  const anchorBottom = anchor?.bottom;

  useLayoutEffect(() => {
    if (anchorTop === undefined || anchorBottom === undefined) {
      setTop(null);
      return;
    }
    setTop(computeAnchoredTop({
      anchorTop, anchorBottom, mode,
      height: panelRef.current?.offsetHeight ?? 0,
      viewportHeight: window.innerHeight,
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `deps` is the caller's list of height-affecting inputs
  }, [anchorTop, anchorBottom, mode, panelRef, ...deps]);

  useEffect(() => {
    if (!onResize || anchorTop === undefined) return;
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [onResize, anchorTop]);

  return top;
}
