import { useLayoutEffect } from "react";

/**
 * The board's one column grid (#2300, spec: docs/development/board-redesign.md
 * § Page structure). The sticky header row, every lane's cells, every collapsed
 * strip and the row separators all render with the template built here, so a
 * column track is the same width in every row by construction rather than by
 * keeping per-row pixel widths in step.
 *
 * The template interleaves separator tracks with column tracks:
 *   16px | col | 8px | col | 8px | ... | col | 16px
 * The 8px inner separator tracks are the spec's 8px gap. They are real tracks
 * (not `column-gap`) because the separator under them is interactive: hover
 * highlights the line through every row and a click inserts a column there.
 * The 16px outer tracks are the board's gutters; the swimlane band's `mx-4`
 * spans exactly from the first to the last column because of them.
 */

export const BOARD_GRID_GUTTER = 16;
export const BOARD_GRID_GAP = 8;
/** Below this board width the grid scrolls sideways inside its own box. */
export const BOARD_GRID_MIN_WIDTH = 1240;
/**
 * Narrowest a normal column may get before the grid scrolls instead. The spec's
 * 1240px threshold is sized for the 7-column reference board; without a per-track
 * floor a 15-column board would squeeze every column to ~70px at 1240px. 160px is
 * the floor the old per-column resize clamp used.
 */
export const BOARD_TRACK_FLOOR = 160;
/** Hidden and collapsed columns keep their 40px stub. */
export const BOARD_NARROW_TRACK = 40;

/**
 * - `column`: a normal stage, `minmax(0, 1fr)`.
 * - `split`: a stage split into two sub-columns, `minmax(0, 2fr)` (#2278).
 * - `narrow`: a hidden or collapsed column stub, fixed 40px.
 */
export type BoardTrack = "column" | "split" | "narrow";

function trackSize(track: BoardTrack): string {
  if (track === "split") return "minmax(0, 2fr)";
  if (track === "narrow") return `${BOARD_NARROW_TRACK}px`;
  return "minmax(0, 1fr)";
}

function trackFloor(track: BoardTrack): number {
  if (track === "split") return BOARD_TRACK_FLOOR * 2 + BOARD_GRID_GAP;
  if (track === "narrow") return BOARD_NARROW_TRACK;
  return BOARD_TRACK_FLOOR;
}

/** `grid-template-columns` for the header row, lane rows and row separators. */
export function boardGridTemplate(tracks: readonly BoardTrack[]): string {
  if (tracks.length === 0) return `${BOARD_GRID_GUTTER}px`;
  const parts: string[] = [`${BOARD_GRID_GUTTER}px`];
  tracks.forEach((t, i) => {
    parts.push(trackSize(t));
    parts.push(`${i === tracks.length - 1 ? BOARD_GRID_GUTTER : BOARD_GRID_GAP}px`);
  });
  return parts.join(" ");
}

/**
 * Minimum width of the grid's content box. Below it the board scrolls sideways
 * inside `[data-board-scroll]`; the page never does.
 */
export function boardGridMinWidth(tracks: readonly BoardTrack[]): number {
  if (tracks.length === 0) return BOARD_GRID_MIN_WIDTH;
  const floors = tracks.reduce((sum, t) => sum + trackFloor(t), 0);
  const separators = BOARD_GRID_GUTTER * 2 + BOARD_GRID_GAP * (tracks.length - 1);
  return Math.max(BOARD_GRID_MIN_WIDTH, floors + separators);
}

/** 1-based grid line of the column track at `index` (separators sit between). */
export function columnTrackLine(index: number): number {
  return index * 2 + 2;
}

/** 1-based grid line of the separator track at `sepIndex` (0 = far left). */
export function separatorTrackLine(sepIndex: number): number {
  return sepIndex * 2 + 1;
}

/** CSS variable on the board scroll box: its visible (client) width in px. */
export const BOARD_VIEW_WIDTH_VAR = "--board-view-w";

/**
 * Publishes the scroll box's visible width as `--board-view-w` so a swimlane band
 * can cap itself to the visible part of a wider grid and stay pinned to the left
 * edge while the grid scrolls sideways (#2305). A CSS variable rather than React
 * state: the width changes on every window resize and nothing needs to re-render.
 */
export function useBoardViewWidthVar(el: HTMLElement | null): void {
  useLayoutEffect(() => {
    if (!el) return;
    const publish = () => el.style.setProperty(BOARD_VIEW_WIDTH_VAR, `${el.clientWidth}px`);
    publish();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(publish);
    ro.observe(el);
    return () => ro.disconnect();
  }, [el]);
}

/**
 * Max width of a swimlane band: the visible width less the two 16px gutters.
 * Falls back to 100% (no cap) before the variable is published.
 */
export const BAND_MAX_WIDTH = `calc(var(${BOARD_VIEW_WIDTH_VAR}, 100%) - ${BOARD_GRID_GUTTER * 2}px)`;
