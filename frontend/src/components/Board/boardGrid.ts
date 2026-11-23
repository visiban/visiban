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
 * the per-column resize clamp's minimum (`COLUMN_WIDTH_MIN`). It holds for every
 * column, resized or not: `boardGridMinWidth` sizes the grid so the column with the
 * least width per fr still gets its floor, so widening one column can move the
 * scroll threshold.
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
 * - `split`: a stage split into two sub-columns, `minmax(0, 2fr)` (#2278). A split stage
 *   takes one column's width per sub-column (#2531): `N fr` for N sub-columns, so a
 *   three- or four-way stage carries `subs` on the object form.
 * - `narrow`: a hidden or collapsed column stub, fixed 40px.
 * - `{ kind, width }`: a column (or split stage) the user resized. The saved px
 *   width becomes the track's weight, `width / 220` fr, so a column dragged to
 *   440 is twice as wide as a default one at any board width. A width of 220
 *   renders exactly like the plain `column` / `split` track.
 */
export type BoardTrack = "column" | "split" | "narrow" | { kind: "column" | "split"; width: number; subs?: number };

/** Clamp a saved column width (or the default when unset) to the resize bounds. */
export function clampColumnWidth(width: number | undefined | null): number {
  const w = typeof width === "number" && Number.isFinite(width) ? width : DEFAULT_COLUMN_WIDTH;
  return Math.max(COLUMN_WIDTH_MIN, Math.min(COLUMN_WIDTH_MAX, w));
}

/** A column's track: plain `column` at the default width, a weighted one otherwise. */
export function columnTrack(width: number | undefined | null, split: boolean | number = false): BoardTrack {
  const w = clampColumnWidth(width);
  const subs = typeof split === "number" ? split : split ? 2 : 0;
  const kind = subs >= 2 ? "split" : "column";
  // Two sub-columns keep the plain "split" track (2fr); wider stages carry their count.
  if (kind === "split" && subs > 2) return { kind, width: w, subs };
  return w === DEFAULT_COLUMN_WIDTH ? kind : { kind, width: w };
}

function frTrack(fr: number): string {
  // Rounded so a weight like 230/220 does not print 16 digits into the template.
  return `minmax(0, ${Number(fr.toFixed(4))}fr)`;
}

function trackSize(track: BoardTrack): string {
  if (track === "narrow") return `${BOARD_NARROW_TRACK}px`;
  return frTrack(trackFr(track));
}

/** A track's fr weight in the template; 0 for a fixed-px stub. */
function trackFr(track: BoardTrack): number {
  if (track === "narrow") return 0;
  if (track === "split") return 2;
  if (track === "column") return 1;
  return (track.kind === "split" ? (track.subs ?? 2) : 1) * (track.width / DEFAULT_COLUMN_WIDTH);
}

/**
 * Narrowest px width a track may render at: 160 for a column, N 160px
 * sub-columns plus their 8px gaps for a split stage, 40 for a stub. BoardView
 * publishes these on the grid as `data-track-floors` for `measureTrackLeftOf`.
 */
export function trackFloor(track: BoardTrack): number {
  if (track === "narrow") return BOARD_NARROW_TRACK;
  const kind = typeof track === "string" ? track : track.kind;
  if (kind === "split") {
    const subs = typeof track === "string" ? 2 : (track.subs ?? 2);
    return BOARD_TRACK_FLOOR * subs + BOARD_GRID_GAP * (subs - 1);
  }
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
 *
 * The fr tracks share the fr space in proportion to their weights, so summing
 * their floors is not enough once columns are resized: with one column at 600
 * and six at 220, the six would render at 133px. The fr space is instead sized
 * so the track with the most floor per fr gets its floor:
 * `frSpace = sum(fr) * max(floor / fr)`. Every other track then renders above
 * its floor. For an unresized board of plain columns this is `160 * n`, as before.
 */
export function boardGridMinWidth(tracks: readonly BoardTrack[]): number {
  if (tracks.length === 0) return BOARD_GRID_MIN_WIDTH;
  let fixed = BOARD_GRID_GUTTER * 2 + BOARD_GRID_GAP * (tracks.length - 1);
  let frSum = 0;
  let floorPerFr = 0;
  for (const t of tracks) {
    const fr = trackFr(t);
    if (fr === 0) {
      fixed += trackFloor(t);
    } else {
      frSum += fr;
      floorPerFr = Math.max(floorPerFr, trackFloor(t) / fr);
    }
  }
  // Rounded up so float weights (230 / 220) never leave a column a hair under its floor.
  return Math.max(BOARD_GRID_MIN_WIDTH, Math.ceil(fixed + frSum * floorPerFr - 1e-6));
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

/** What a separator drag needs to know about the layout, measured once at the press. */
export interface TrackResizeMeasure {
  /** Rendered px width of the column being resized (r). */
  rendered: number;
  /** Its fr weight in the specified template. */
  fr: number;
  /** Sum of the other fr tracks' weights (S_o). */
  otherFr: number;
  /**
   * px per fr at which another fr track reaches its floor (k_o, the largest
   * floor / fr among them). When the grid is held open by `boardGridMinWidth`,
   * each fr renders at this many px. 0 when unknown.
   */
  otherFloorPerFr: number;
  /** px the fr tracks share when the grid is not held open by its min width (C). */
  fluidFrSpace: number;
}

const SPECIFIED_TRACK = /minmax\(\s*0(?:px)?\s*,\s*([\d.]+)fr\s*\)|([\d.]+)px/g;

/** The specified template's tracks, each its fr weight or `null` for a px track. */
function specifiedTracks(template: string): (number | null)[] {
  return Array.from(template.matchAll(SPECIFIED_TRACK), (m) => (m[1] !== undefined ? Number(m[1]) : null));
}

/**
 * Measures the column track to the left of separator `sepIndex` in the grid row
 * `el` sits in. The fr weights come from the row's specified `grid-template-columns`
 * (its inline style), the rendered px from the resolved one; px tracks (gutters,
 * separators, 40px stubs) are fixed and take no part. The board grid wrapper
 * (`[data-track-floors]`) supplies the track floors and, through its parent (the
 * scroll box), the width the grid would have without its min width.
 * Returns null when it cannot be measured (no layout, as in jsdom).
 */
export function measureTrackLeftOf(el: HTMLElement | null, sepIndex: number): TrackResizeMeasure | null {
  if (!el || sepIndex < 1) return null;
  let grid = el.parentElement;
  while (grid && getComputedStyle(grid).display !== "grid") grid = grid.parentElement;
  if (!grid) return null;
  const specified = specifiedTracks(grid.style.gridTemplateColumns);
  // Resolved value: one px size per track, e.g. "16px 204.5px 8px ...".
  const resolved = getComputedStyle(grid).gridTemplateColumns.trim().split(/\s+/).map((v) => {
    const m = /^([\d.]+)px$/.exec(v);
    return m ? Number(m[1]) : NaN;
  });
  if (specified.length === 0 || specified.length !== resolved.length || resolved.some(Number.isNaN)) return null;
  const t = columnTrackLine(sepIndex - 1) - 1;
  const fr = specified[t];
  if (!fr) return null;
  let frPx = 0;
  let fixedPx = 0;
  let otherFr = 0;
  specified.forEach((s, i) => {
    if (s === null) {
      fixedPx += resolved[i];
    } else {
      frPx += resolved[i];
      if (i !== t) otherFr += s;
    }
  });
  let fluidFrSpace = frPx;
  let otherFloorPerFr = 0;
  const wrapper = grid.closest<HTMLElement>("[data-track-floors]");
  if (wrapper) {
    const box = wrapper.parentElement;
    const wrapWidth = wrapper.getBoundingClientRect().width;
    if (box && wrapWidth > 0) {
      const cs = getComputedStyle(box);
      const view = box.clientWidth - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0);
      // Anything between the wrapper's edge and this row's tracks (none today).
      const insets = Math.max(0, wrapWidth - (frPx + fixedPx));
      if (view > 0) fluidFrSpace = Math.max(view, BOARD_GRID_MIN_WIDTH) - insets - fixedPx;
    }
    (wrapper.dataset.trackFloors ?? "").split(/\s+/).filter(Boolean).forEach((floor, c) => {
      const i = columnTrackLine(c) - 1;
      const w = specified[i];
      if (i !== t && w) otherFloorPerFr = Math.max(otherFloorPerFr, Number(floor) / w);
    });
  }
  return { rendered: resolved[t], fr, otherFr, otherFloorPerFr, fluidFrSpace };
}

/**
 * The saved width a separator drag asks for, so the column's right edge stays
 * under the pointer. Columns are fr tracks, so the saved width is a weight and
 * raising it also raises the sum every track divides the fr space by. With the
 * target width `T = r + d` and the new weight `f`, the column renders at
 * `max(C * f / (S_o + f), k_o * f)`: the fluid share of the fr space, or, once the
 * grid is held open by `boardGridMinWidth`, `k_o` px per fr. Both grow with `f`, so
 * the weight that renders exactly `T` is the smaller of their inverses:
 *   `f = min(T * S_o / (C - T), T / k_o)`  (the first is unreachable when T >= C)
 * and the saved width scales with it, `w' = w * f / fr`, clamped to 160..600.
 * When the track was not measured (jsdom), the drag adds the delta to the saved
 * width as before the shared template.
 */
export function resizedColumnWidth(startWidth: number, m: TrackResizeMeasure | null, deltaPx: number): number {
  if (!m || m.rendered <= 0 || m.fr <= 0) return startWidth + deltaPx;
  // The only fr track fills the row whatever its weight; there is nothing to resize against.
  if (m.otherFr <= 0) return startWidth;
  const target = Math.max(1, m.rendered + deltaPx);
  const fluid = target < m.fluidFrSpace ? (target * m.otherFr) / (m.fluidFrSpace - target) : Infinity;
  const held = m.otherFloorPerFr > 0 ? target / m.otherFloorPerFr : Infinity;
  const fr = Math.min(fluid, held);
  if (!Number.isFinite(fr)) return COLUMN_WIDTH_MAX;
  return Math.round(clampColumnWidth((startWidth * fr) / m.fr));
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
