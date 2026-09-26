import type { GridOverlay } from "./types";
import { noneOverlay } from "./builtin/none";
import { cardCountOverlay } from "./builtin/cardCount";

/**
 * The overlay registry.
 *
 * Id-keyed and insertion-ordered on purpose: board presets (#1146) select "which
 * overlay" by id, so ids are a persisted contract while labels are free to be
 * reworded, and the picker's option order is the registration order with `none`
 * pinned first.
 */
const overlays = new Map<string, GridOverlay>();

/** The default overlay id — "no overlay", current board behavior. */
export const NONE_OVERLAY_ID = noneOverlay.id;

export function registerGridOverlay(overlay: GridOverlay): void {
  if (overlays.has(overlay.id)) {
    // A duplicate id would make persisted preferences and presets ambiguous — which
    // registration a stored id resolves to would depend on module import order.
    // Loud in development, survivable in production: registration happens at module
    // load, so throwing in a shipped bundle would white-screen the whole app over a
    // cosmetic board layer. First registration wins.
    const message = `Grid overlay id "${overlay.id}" is already registered`;
    if (import.meta.env.DEV) throw new Error(message);
    console.warn(message);
    return;
  }
  overlays.set(overlay.id, overlay);
}

/** Registered overlay, or `null` when the id is unknown to this build. */
export function getGridOverlay(id: string): GridOverlay | null {
  return overlays.get(id) ?? null;
}

/** All overlays in registration order — `none` is always first. */
export function listGridOverlays(): GridOverlay[] {
  return [...overlays.values()];
}

/**
 * Resolves a stored or preset-supplied id to one this build can actually render.
 *
 * Unknown ids degrade to `none` rather than throwing: a board preset (#1146) or
 * a stale localStorage value may name an overlay that a newer release added or
 * an older release never had, and a board that renders un-overlaid is a strictly
 * better failure than a board that does not render.
 */
export function resolveGridOverlayId(id: string | null | undefined): string {
  if (!id) return NONE_OVERLAY_ID;
  return overlays.has(id) ? id : NONE_OVERLAY_ID;
}

/**
 * Built-ins register at module load. Only two overlays ship in 1.2 (#1147):
 * `none` and the `card-count` reference overlay that proves the seam.
 *
 * `registerGridOverlay` is deliberately **not** an enterprise extension point yet
 * (see CLAUDE.md § Open core vs. enterprise boundary): nothing outside this directory
 * calls it in 1.2, so its shape is still free to change. Declaring it stable is a
 * decision for whoever first wants to register an overlay from outside OSS.
 */
registerGridOverlay(noneOverlay);
registerGridOverlay(cardCountOverlay);
