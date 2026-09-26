import type { LensConnection } from "../../types";

/** Tooltip shown on the de-emphasized Board tab so a muted tab never reads as "broken". */
export const LENS_ONLY_BOARD_TOOLTIP = "This board mirrors a repo — no native cards";

/**
 * The Board tab is muted (never disabled or hidden — Jordan's "never hide
 * information" constraint, #1063) exactly when a lens is configured AND the
 * board has zero native swimlanes. One native swimlane means the board holds
 * real content, so the tab returns to full weight. Automatic on purpose: a
 * per-board manual setting is what Alex's persona flagged as pain at scale.
 */
export function isBoardTabDeemphasized(
  lensConnection: LensConnection | null,
  nativeSwimlaneCount: number,
): boolean {
  return lensConnection !== null && nativeSwimlaneCount === 0;
}
