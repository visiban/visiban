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
 * the per-column resize clamp's minimum (`COLUMN_WIDTH_MIN`); it does not scale with a
 * column's weight, so resizing never moves the scroll threshold.
 */
export const BOARD_TRACK_FLOOR = 160;
/** Hidden and collapsed columns keep their 40px stub. */
export const BOARD_NARROW_TRACK = 40;

/** The default column width in px. A saved width is a track weight relative to it. */
export const DEFAULT_COLUMN_WIDTH = 220;
/** Clamp for a saved column width, the same bounds `setColumnWidth` (useViewPrefs) applies. */
export const COLUMN_WIDTH_MIN = 160;
export const COLUMN_WIDTH_MAX = 600;

/**
 * - `column`: a normal stage, `minmax(0, 1fr)`.
 * - `split`: a stage split into two sub-columns, `minmax(0, 2fr)` (#2278).
 * - `narrow`: a hidden or collapsed column stub, fixed 40px.
 * - `{ kind, width }`: a column (or split stage) the user resized. The saved px
 *   width becomes the track's weight, `width / 220` fr, so a column dragged to
 *   440 is twice as wide as a default one at any board width. A width of 220
 *   renders exactly like the plain `column` / `split` track.
 */
export type BoardTrack = "column" | "split" | "narrow" | { kind: "column" | "split"; width: number };

/** Clamp a saved column width (or the default when unset) to the resize bounds. */
export function clampColumnWidth(width: number | undefined | null): number {
  const w = typeof width === "number" && Number.isFinite(width) ? width : DEFAULT_COLUMN_WIDTH;
  return Math.max(COLUMN_WIDTH_MIN, Math.min(COLUMN_WIDTH_MAX, w));
}

/** A column's track: plain `column` at the default width, a weighted one otherwise. */
export function columnTrack(width: number | undefined | null, split = false): BoardTrack {
  const w = clampColumnWidth(width);
  const kind = split ? "split" : "column";
  return w === DEFAULT_COLUMN_WIDTH ? kind : { kind, width: w };
}

function frTrack(fr: number): string {
  // Rounded so a weight like 230/220 does not print 16 digits into the template.
  return `minmax(0, ${Number(fr.toFixed(4))}fr)`;
}

function trackSize(track: BoardTrack): string {
  if (track === "narrow") return `${BOARD_NARROW_TRACK}px`;
  if (track === "split") return frTrack(2);
  if (track === "column") return frTrack(1);
  return frTrack((track.kind === "split" ? 2 : 1) * (track.width / DEFAULT_COLUMN_WIDTH));
}

function trackFloor(track: BoardTrack): number {
  if (track === "narrow") return BOARD_NARROW_TRACK;
  const kind = typeof track === "string" ? track : track.kind;
  if (kind === "split") return BOARD_TRACK_FLOOR * 2 + BOARD_GRID_GAP;
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

const INSERT_DRAG_THRESHOLD = 4; // px: movement beyond this is a drag, not a click

/**
 * The column separators' gesture, shared by the header's ColumnSeparator and the
 * lane cells' separators so both behave alike. A release without more than 4px of
 * movement is a click: it inserts a column. Past 4px it is a drag: `onDrag` (when
 * given) gets the pointer's x offset from the press on every move, and nothing is
 * inserted on release.
 */
export function startInsertGesture(
  e: { clientX: number; preventDefault(): void },
  onInsert: () => void,
  onDrag?: (deltaPx: number) => void,
): void {
  e.preventDefault();
  const startX = e.clientX;
  let dragged = false;
  const onMove = (ev: MouseEvent) => {
    const delta = ev.clientX - startX;
    if (!dragged && Math.abs(delta) > INSERT_DRAG_THRESHOLD) dragged = true;
    if (dragged && onDrag) onDrag(delta);
  };
  const onUp = () => {
    window.removeEventListener("mousemove", onMove);
    window.removeEventListener("mouseup", onUp);
    if (!dragged) onInsert();
  };
  window.addEventListener("mousemove", onMove);
  window.addEventListener("mouseup", onUp);
}

/**
 * Rendered px width of the column track to the left of separator `sepIndex`, read
 * from the resolved `grid-template-columns` of the grid row `el` sits in. Returns
 * 0 when it cannot be measured (no layout, as in jsdom).
 */
export function renderedTrackLeftOf(el: HTMLElement | null, sepIndex: number): number {
  if (!el || sepIndex < 1) return 0;
  let grid = el.parentElement;
  while (grid && getComputedStyle(grid).display !== "grid") grid = grid.parentElement;
  if (!grid) return 0;
  // Resolved value: one px size per track, e.g. "16px 204.5px 8px ...".
  const tracks = getComputedStyle(grid).gridTemplateColumns.trim().split(/\s+/);
  const m = /^([\d.]+)px$/.exec(tracks[columnTrackLine(sepIndex - 1) - 1] ?? "");
  return m ? Number(m[1]) : 0;
}

/**
 * The saved width a separator drag asks for. Columns are fr tracks, so the saved
 * width is a weight, not the rendered width: the drag scales the weight by how much
 * it grows the rendered track (`startWidth * (rendered + delta) / rendered`). When
 * the track was not measured, the drag adds the delta to the saved width as before
 * the shared template. `setColumnWidth` clamps the result to 160..600.
 */
export function resizedColumnWidth(startWidth: number, renderedPx: number, deltaPx: number): number {
  if (renderedPx > 0) return Math.round((startWidth * Math.max(1, renderedPx + deltaPx)) / renderedPx);
  return startWidth + deltaPx;
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
