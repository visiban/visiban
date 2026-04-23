import { useEffect, useState } from "react";

// Matches Tailwind's `md` breakpoint. Used alongside useIsLargeViewport to
// decide which toolbar controls fold into the overflow menu at sub-`lg`
// viewports. Keep the two hooks as parallel clones for now; a future follow-up
// may consolidate them into a single useBreakpoint() hook once a third
// breakpoint is needed.
const MEDIUM_VIEWPORT_QUERY = "(min-width: 768px)";

function readInitial(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    // SSR or a non-browser test harness — assume medium so server-rendered
    // markup matches the tablet/desktop layout. The client-side effect
    // corrects this on first paint if the assumption is wrong.
    return true;
  }
  return window.matchMedia(MEDIUM_VIEWPORT_QUERY).matches;
}

/**
 * Returns true when the viewport is at least 768px wide. Used in combination
 * with useIsLargeViewport to branch the board toolbar between its `lg`, `md`,
 * and `sm` layouts. A viewport is `sm` when this hook returns false.
 */
export function useIsMediumViewport(): boolean {
  const [isMedium, setIsMedium] = useState<boolean>(readInitial);

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return;
    }
    const mq = window.matchMedia(MEDIUM_VIEWPORT_QUERY);
    const update = () => setIsMedium(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);

  return isMedium;
}
