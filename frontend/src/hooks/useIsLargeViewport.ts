import { useEffect, useState } from "react";

// Matches Tailwind's `lg` breakpoint — the same threshold AppSidebar uses to
// toggle between its hidden and visible state. Keeping these in sync means the
// viewport gate triggers exactly where the layout would otherwise break.
const LARGE_VIEWPORT_QUERY = "(min-width: 1024px)";

function readInitial(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    // SSR or a non-browser test harness — assume large so server-rendered
    // markup matches the desktop layout. The client-side effect corrects this
    // on first paint if the assumption is wrong.
    return true;
  }
  return window.matchMedia(LARGE_VIEWPORT_QUERY).matches;
}

/**
 * Returns true when the viewport is at least 1024px wide. Used to render a
 * desktop-only notice on smaller screens because the board grid, swimlane
 * panel, and sidebar all depend on horizontal space that is not available on
 * phones or portrait-mode tablets.
 */
export function useIsLargeViewport(): boolean {
  const [isLarge, setIsLarge] = useState<boolean>(readInitial);

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return;
    }
    const mq = window.matchMedia(LARGE_VIEWPORT_QUERY);
    const update = () => setIsLarge(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);

  return isLarge;
}
