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
