import { useLayoutEffect } from "react";
import type { RefObject } from "react";

/**
 * Publish an element's rendered height as a CSS custom property on the root
 * element while it is mounted, and remove it on unmount.
 *
 * `BulkActionToolbar` publishes `--bulk-toolbar-h` so the shared toast region
 * floats above it instead of covering its controls or its result slot
 * (frontend/CLAUDE.md § Toasts). A `ResizeObserver`, where available, follows
 * the toolbar as its two-line result message wraps.
 */
export function usePublishedHeight(ref: RefObject<HTMLElement | null>, cssVar: string): void {
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const root = document.documentElement;
    const publish = () => root.style.setProperty(cssVar, `${el.offsetHeight}px`);
    publish();
    let observer: ResizeObserver | null = null;
    if (typeof ResizeObserver !== "undefined") {
      observer = new ResizeObserver(publish);
      observer.observe(el);
    }
    return () => {
      observer?.disconnect();
      root.style.removeProperty(cssVar);
    };
  }, [ref, cssVar]);
}
