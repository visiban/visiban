import type { ReactNode } from "react";

/**
 * Row-2 toolbar icons shared by the native board (`BoardView`) and the lens
 * (`LensToolbar`).
 *
 * These live in one module rather than being copied into each toolbar because
 * board↔lens parity is a stated design requirement (#1064) — two inline copies
 * read identically today and drift silently the first time one gets a
 * stroke-width or viewBox tweak.
 *
 * Defined as module-level constants (not components) so the nodes are stable
 * across renders and an `OverflowMenu` items `useMemo` is not invalidated by a
 * fresh icon reference every render.
 */
export const LayoutCompactIcon: ReactNode = (
  <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" aria-hidden="true">
    <rect x="3" y="3" width="18" height="5" rx="1" />
    <rect x="3" y="10" width="18" height="5" rx="1" />
    <rect x="3" y="17" width="18" height="4" rx="1" />
  </svg>
);

export const LayoutExpandedIcon: ReactNode = (
  <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" aria-hidden="true">
    <rect x="3" y="3" width="7" height="7" rx="1" />
    <rect x="14" y="3" width="7" height="7" rx="1" />
    <rect x="3" y="14" width="7" height="7" rx="1" />
    <rect x="14" y="14" width="7" height="7" rx="1" />
  </svg>
);

/**
 * Grid overlay picker (#1147) — a grid with one shaded cell. Row 2 icons live here and
 * are imported, never re-inlined at a call site.
 */
export const OverlayIcon: ReactNode = (
  <svg className="w-3.5 h-3.5" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
    <rect x="2" y="2" width="12" height="12" rx="1" />
    <line x1="6" y1="2" x2="6" y2="14" />
    <line x1="10" y1="2" x2="10" y2="14" />
    <line x1="2" y1="6" x2="14" y2="6" />
    <line x1="2" y1="10" x2="14" y2="10" />
    <rect x="10" y="10" width="4" height="4" fill="currentColor" stroke="none" opacity="0.4" />
  </svg>
);
