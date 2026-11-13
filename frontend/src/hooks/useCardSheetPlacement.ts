import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

/**
 * Placement of the card detail sheet (#1914).
 *
 * This is deliberately NOT `useAnchoredPlacement`. That hook places a popover
 * vertically, keeps the side chosen at open (#1457) and exists to *dismiss* on
 * resize and outside scroll. The card detail sheet is the documented exception
 * to that rule (frontend/CLAUDE.md): it is an `aria-modal` dialog that stays
 * open and is placed again, horizontally, on open, swap, resize and board
 * scroll-end, and it may change sides when it does.
 */

export const SHEET_WIDTH = 540;
/** Gap between the column's edge and the sheet (14px from the card: cells have 8px padding). */
export const SHEET_GAP = 6;
/** Smallest gap kept between an anchored sheet and the viewport's right edge. */
export const SHEET_EDGE = 16;
/** An anchored sheet starts this far below the board toolbar... */
export const SHEET_TOP_GAP = 8;
/** ...and ends this far above the viewport's bottom edge. */
export const SHEET_BOTTOM_GAP = 12;
/** The notch never comes closer than this to the sheet's top or bottom corner. */
export const NOTCH_INSET = 28;
/** At or above this viewport width the sheet anchors to the card's column. */
export const ANCHOR_MIN_VIEWPORT = 1280;
/** At or below this viewport width the sheet is full-screen. */
export const FULLSCREEN_MAX_VIEWPORT = 640;
/** Resize and board scroll-end re-place the sheet after this much quiet. */
export const REPLACE_DEBOUNCE_MS = 150;
/** How long to keep looking for a card element that is not rendered yet. */
const APPEAR_RETRY_FRAMES = 12;

export type SheetMode = "fullscreen" | "docked" | "anchored";
/** Which side of the card's column an anchored sheet sits on. */
export type SheetSide = "right" | "left";
/** Why the sheet was placed again; the Move re-anchor always fades (#1914). */
export type PlacementReason = "open" | "move" | "resize" | "scroll" | "appear" | "dock-toggle";

export interface SheetGeometry {
  /** Viewport x of the card's column (its board cell). */
  column: { left: number; right: number };
  /** Viewport x of the swimlane label column's right edge; the sheet never covers it. */
  lanesRight: number;
  /**
   * Viewport y of the bottom of the board chrome above the grid: the board
   * toolbar, or the filter row (and any banner) below it when one is shown.
   */
  toolbarBottom: number;
  /** Viewport y of the card's vertical center. */
  cardCenterY: number;
}

export interface SheetNotch {
  /** Distance of the notch's center from the sheet's top edge, in whole pixels. */
  y: number;
  /** True when the card's center is outside the notch's range (scrolled away): the notch is pinned at an end. */
  clamped: boolean;
  /**
   * Set only when clamped: which way the card lies from the sheet's range
   * (`down` = below it). The clamped wedge's apex points that way (#1946).
   */
  direction?: "up" | "down";
}

export interface SheetPlacement {
  mode: SheetMode;
  /** Anchored only. */
  side: SheetSide | null;
  /** Anchored only: the sheet's viewport x. Docked and full-screen sheets are pinned by CSS. */
  left: number | null;
  /** Viewport y of the sheet's top edge. */
  top: number;
  /** Distance of the sheet's bottom edge from the viewport's bottom edge. */
  bottom: number;
  /** Anchored only. */
  notch: SheetNotch | null;
}

const FULLSCREEN: SheetPlacement = { mode: "fullscreen", side: null, left: null, top: 0, bottom: 0, notch: null };
const DOCKED: SheetPlacement = { mode: "docked", side: null, left: null, top: 0, bottom: 0, notch: null };

/** Where the notch sits on a sheet spanning `top` to `viewportHeight - bottom`. */
export function computeNotch(cardCenterY: number, top: number, bottom: number, viewportHeight: number): SheetNotch {
  const min = top + NOTCH_INSET;
  const max = viewportHeight - bottom - NOTCH_INSET;
  const y = Math.min(Math.max(cardCenterY, min), Math.max(min, max));
  // `clamped` and `direction` come from the unrounded values; only the
  // reported position is rounded to whole pixels. Direction compares the
  // unclamped center to the clamped one rather than to `y`'s position, which
  // would be ambiguous on a sheet shorter than two insets.
  const clamped = y !== cardCenterY;
  return clamped
    ? { y: Math.round(y - top), clamped, direction: cardCenterY > y ? "down" : "up" }
    : { y: Math.round(y - top), clamped };
}

/**
 * The anchor rule (#1914). `geometry` is `null` when the card has no
 * measurable element (deep link before render, command palette, a card
 * filtered out or inside a collapsed lane or column): such a sheet docks to
 * the right edge, exactly like the fallback, and is never centered.
 *
 * Beyond the design's rule, an anchored sheet must also fit fully on screen
 * and start right of the lane labels on either side: a column scrolled
 * partly under the sticky labels (or past the right edge) docks instead of
 * covering them or running off screen.
 */
export function computeCardSheetPlacement({ viewportWidth, viewportHeight, geometry, docked = false }: {
  viewportWidth: number;
  viewportHeight: number;
  geometry: SheetGeometry | null;
  /** The user's "Dock to edge" preference (#1915): ranks below full-screen, above the anchor rule. */
  docked?: boolean;
}): SheetPlacement {
  if (viewportWidth <= FULLSCREEN_MAX_VIEWPORT) return FULLSCREEN;
  if (docked) return DOCKED;
  if (viewportWidth < ANCHOR_MIN_VIEWPORT || !geometry) return DOCKED;
  const { column, lanesRight, toolbarBottom, cardCenterY } = geometry;
  const maxLeft = viewportWidth - SHEET_EDGE - SHEET_WIDTH;
  const rightLeft = column.right + SHEET_GAP;
  const leftLeft = column.left - SHEET_GAP - SHEET_WIDTH;
  let side: SheetSide;
  let left: number;
  if (rightLeft <= maxLeft && rightLeft >= lanesRight) {
    side = "right";
    left = rightLeft;
  } else if (leftLeft >= lanesRight && leftLeft <= maxLeft) {
    side = "left";
    left = leftLeft;
  } else {
    return DOCKED;
  }
  const top = toolbarBottom + SHEET_TOP_GAP;
  const bottom = SHEET_BOTTOM_GAP;
  return { mode: "anchored", side, left, top, bottom, notch: computeNotch(cardCenterY, top, bottom, viewportHeight) };
}

export function samePlacement(a: SheetPlacement, b: SheetPlacement): boolean {
  return a.mode === b.mode && a.side === b.side && a.left === b.left && a.top === b.top &&
    a.bottom === b.bottom && a.notch?.y === b.notch?.y && a.notch?.clamped === b.notch?.clamped &&
    a.notch?.direction === b.notch?.direction;
}

/** `samePlacement` ignoring the notch: whether the sheet itself moved. */
export function sameFrame(a: SheetPlacement, b: SheetPlacement): boolean {
  return a.mode === b.mode && a.side === b.side && a.left === b.left && a.top === b.top && a.bottom === b.bottom;
}

export type SheetTransition = "none" | "open" | "slide" | "fade";

/**
 * Which transition a placement change plays. Same side: a slide. A side
 * flip, a mode change (docked to anchored, for example when the card element
 * appears) or an in-sheet Move: fade out, reposition, fade in, never a slide
 * across the board. A notch-only change plays nothing.
 */
export function classifyTransition(prev: SheetPlacement | null, next: SheetPlacement, reason: PlacementReason | "swap"): SheetTransition {
  if (!prev) return "open";
  if (reason === "move" && !sameFrame(prev, next)) return "fade";
  // Toggling Dock to edge moves the same card's sheet with the swap timing (#1915).
  if (reason === "dock-toggle") return sameFrame(prev, next) ? "none" : "slide";
  if (sameFrame(prev, next)) return reason === "swap" ? "slide" : "none";
  if (prev.mode !== next.mode || prev.side !== next.side) return "fade";
  return "slide";
}

/** The board's scroll container (`BoardView`), the root every board marker is looked up in. */
export const BOARD_SCROLL_SELECTOR = "[data-board-scroll]";

// Pointer events that came from the board's React tree (#1914). BoardView's
// scroll container marks them in onPointerDownCapture; React events bubble
// through portals, so this includes popovers a card face portals to
// document.body (the custom-field quick-edit popover and its dropdowns, the
// hover peek). The card detail sheet's click-catcher leaves those alone.
const boardTreePointerEvents = new WeakSet<Event>();
export function markBoardTreePointerEvent(e: { nativeEvent: Event }) {
  boardTreePointerEvents.add(e.nativeEvent);
}
export function isBoardTreePointerEvent(e: Event): boolean {
  return boardTreePointerEvents.has(e);
}

/**
 * The rendered face of a card on the board, or `null` when it has none to
 * measure. Looked up inside the board's scroll container only, so the drag
 * overlay copy or any other surface that renders a `CardItem` never matches.
 * A zero-size element (`display: none`) counts as missing.
 */
export function findBoardCardElement(cardId: number): HTMLElement | null {
  const root = document.querySelector(BOARD_SCROLL_SELECTOR);
  const el = root?.querySelector<HTMLElement>(`[data-card-id="${cardId}"]`) ?? null;
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return r.width === 0 && r.height === 0 ? null : el;
}

/** Reads the anchor rule's inputs off the DOM around a rendered card. */
export function measureCardSheetGeometry(cardEl: HTMLElement): SheetGeometry {
  const card = cardEl.getBoundingClientRect();
  const cell = (cardEl.closest("[data-board-cell]") as HTMLElement | null) ?? cardEl;
  const col = cell.getBoundingClientRect();
  const root = cardEl.closest(BOARD_SCROLL_SELECTOR);
  // All lane labels share one width and are sticky to the left edge, so the
  // first one's right edge is the whole label column's.
  const lane = root?.querySelector("[data-lane-label]");
  const lanesRight = lane ? lane.getBoundingClientRect().right : (root?.getBoundingClientRect().left ?? 0);
  const toolbar = document.querySelector('nav[aria-label="Board toolbar"]');
  // The board grid starts at the scroll container's top. With the filter row
  // (F) or a banner shown it sits below the toolbar, and the sheet must not
  // cover those controls; with neither, the two are the same edge.
  const chromeBottom = Math.max(
    toolbar ? toolbar.getBoundingClientRect().bottom : 0,
    root ? root.getBoundingClientRect().top : 0,
  );
  return {
    column: { left: col.left, right: col.right },
    lanesRight,
    toolbarBottom: chromeBottom,
    cardCenterY: card.top + card.height / 2,
  };
}

export interface CardSheetPlacementState {
  placement: SheetPlacement;
  /** The card's board element when one was measured; also the focus-return target. */
  cardEl: HTMLElement | null;
  reason: PlacementReason;
  /** False until the first measurement; nothing is animated before it. */
  measured: boolean;
}

function initialState(docked: boolean): CardSheetPlacementState {
  return {
    placement: computeCardSheetPlacement({ viewportWidth: window.innerWidth, viewportHeight: window.innerHeight, geometry: null, docked }),
    cardEl: null,
    reason: "open",
    measured: false,
  };
}

/**
 * Measures the card's board element and places the sheet by the anchor rule.
 *
 * Re-places in a layout effect (before paint) on open and whenever
 * `locationKey` changes (the card moved, e.g. through the in-sheet Move: the
 * card re-mounts in its new cell in the same commit), after a 150ms quiet
 * period on window resize and board scroll-end, and from a `ResizeObserver`
 * on the board content (a lane or column expanding can make a missing card
 * appear). The notch alone follows vertical board scroll every frame; the
 * sheet never follows the card vertically and the board is never scrolled.
 *
 * Scroll inside the sheet (its long body, a dropdown list) is ignored: only a
 * scroll of the board container or the document counts.
 */
export function useCardSheetPlacement(cardId: number, locationKey: string, docked = false): CardSheetPlacementState {
  const [state, setState] = useState<CardSheetPlacementState>(() => initialState(docked));
  const stateRef = useRef(state);
  stateRef.current = state;

  const place = useCallback((reason: PlacementReason): HTMLElement | null => {
    const el = findBoardCardElement(cardId);
    const placement = computeCardSheetPlacement({
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      geometry: el ? measureCardSheetGeometry(el) : null,
      docked,
    });
    setState((prev) => (
      prev.measured && prev.cardEl === el && samePlacement(prev.placement, placement)
        ? prev
        : { placement, cardEl: el, reason, measured: true }
    ));
    return el;
  }, [cardId, docked]);

  // Open and Move re-anchor. A card that is not rendered yet gets a few
  // frames to appear (a deep link that lands before the board renders).
  const lastLocationRef = useRef<string | null>(null);
  const lastDockedRef = useRef(docked);
  useLayoutEffect(() => {
    const dockToggled = lastDockedRef.current !== docked;
    lastDockedRef.current = docked;
    const reason: PlacementReason = dockToggled ? "dock-toggle"
      : lastLocationRef.current === null || lastLocationRef.current === locationKey ? "open" : "move";
    lastLocationRef.current = locationKey;
    if (place(reason)) return;
    let frames = 0;
    let raf = 0;
    const retry = () => {
      if (place(reason === "move" ? "move" : "appear") || ++frames >= APPEAR_RETRY_FRAMES) return;
      raf = requestAnimationFrame(retry);
    };
    raf = requestAnimationFrame(retry);
    return () => cancelAnimationFrame(raf);
  }, [place, locationKey, docked]);

  useEffect(() => {
    let resizeTimer: ReturnType<typeof setTimeout> | null = null;
    let scrollTimer: ReturnType<typeof setTimeout> | null = null;
    let notchFrame = 0;

    const onResize = () => {
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => { place("resize"); }, REPLACE_DEBOUNCE_MS);
    };

    const updateNotch = () => {
      notchFrame = 0;
      const { placement, cardEl } = stateRef.current;
      if (placement.mode !== "anchored" || !cardEl?.isConnected) return;
      const r = cardEl.getBoundingClientRect();
      const notch = computeNotch(r.top + r.height / 2, placement.top, placement.bottom, window.innerHeight);
      if (notch.y === placement.notch?.y && notch.clamped === placement.notch?.clamped &&
        notch.direction === placement.notch?.direction) return;
      setState((prev) => (prev.placement !== placement ? prev : { ...prev, placement: { ...placement, notch } }));
    };

    const onScroll = (e: Event) => {
      const t = e.target;
      const isBoard = t === document || (t instanceof Element && t.matches(BOARD_SCROLL_SELECTOR));
      if (!isBoard) return;
      if (!notchFrame) notchFrame = requestAnimationFrame(updateNotch);
      if (scrollTimer) clearTimeout(scrollTimer);
      scrollTimer = setTimeout(() => { place("scroll"); }, REPLACE_DEBOUNCE_MS);
    };

    window.addEventListener("resize", onResize);
    window.addEventListener("scroll", onScroll, true);

    // Layout changes inside the board (a lane or column expanding, cards
    // added) without a window resize. Observing only the board content's size
    // keeps this cheap: no MutationObserver over the whole board.
    let observer: ResizeObserver | null = null;
    const content = document.querySelector(BOARD_SCROLL_SELECTOR)?.firstElementChild;
    if (content && typeof ResizeObserver !== "undefined") {
      let first = true;
      observer = new ResizeObserver(() => {
        // The first callback reports the size at observe time, not a change.
        if (first) { first = false; return; }
        onResizeFromBoard();
      });
      observer.observe(content);
    }
    function onResizeFromBoard() {
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => { place(stateRef.current.cardEl ? "resize" : "appear"); }, REPLACE_DEBOUNCE_MS);
    }

    return () => {
      window.removeEventListener("resize", onResize);
      window.removeEventListener("scroll", onScroll, true);
      observer?.disconnect();
      if (resizeTimer) clearTimeout(resizeTimer);
      if (scrollTimer) clearTimeout(scrollTimer);
      if (notchFrame) cancelAnimationFrame(notchFrame);
    };
  }, [place]);

  return state;
}
