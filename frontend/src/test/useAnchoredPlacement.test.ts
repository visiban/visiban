import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import {
  computeAnchoredPlacement, computeAnchoredTop, placeFixedElement,
  getVisibleViewport, subscribeVisualViewport, useAnchoredPlacement,
} from "../hooks/useAnchoredPlacement";

/** jsdom has no `visualViewport`; stub one that can fire resize/scroll (#2138). */
function stubVisualViewport(init: { height: number; offsetTop?: number }) {
  const target = new EventTarget();
  const vv = Object.assign(target, { height: init.height, offsetTop: init.offsetTop ?? 0 });
  const add = vi.spyOn(target, "addEventListener");
  const remove = vi.spyOn(target, "removeEventListener");
  Object.defineProperty(window, "visualViewport", { configurable: true, value: vv });
  return { vv, add, remove };
}

function clearVisualViewport() {
  Object.defineProperty(window, "visualViewport", { configurable: true, value: undefined });
}

/**
 * #1457 — the side lock shared by every `useAnchoredPlacement` adopter, and
 * the imperative `placeFixedElement` used by the Tiptap mention popup.
 */
const VH = 768;

describe("computeAnchoredPlacement side lock (#1457)", () => {
  it("keeps an upward popover flush above the anchor after it shrinks", () => {
    const first = computeAnchoredPlacement({ anchorTop: 568, anchorBottom: 598, height: 440, viewportHeight: VH });
    expect(first).toEqual({ top: 124, side: "above" });
    const after = computeAnchoredPlacement({
      anchorTop: 568, anchorBottom: 598, height: 60, viewportHeight: VH, lockedSide: first.side,
    });
    // Unlocked it would flip below (602); locked, its bottom edge stays at the anchor.
    expect(after).toEqual({ top: 504, side: "above" });
  });

  it("keeps a downward popover below while it still fits there", () => {
    expect(computeAnchoredPlacement({
      anchorTop: 100, anchorBottom: 130, height: 60, viewportHeight: VH, lockedSide: "below",
    })).toEqual({ top: 134, side: "below" });
  });

  it("flips a locked-below popover above when it grows past the bottom edge, never over the trigger", () => {
    // Opened below an input at 638-668 with one row (fits: 672 + 60 <= 760),
    // then a later query returns more rows (400px).
    const first = computeAnchoredPlacement({ anchorTop: 638, anchorBottom: 668, height: 60, viewportHeight: VH });
    expect(first.side).toBe("below");
    const grown = computeAnchoredPlacement({
      anchorTop: 638, anchorBottom: 668, height: 400, viewportHeight: VH, lockedSide: first.side,
    });
    expect(grown).toEqual({ top: 638 - 4 - 400, side: "above" });
    // Its bottom edge stays above the trigger instead of covering it.
    expect(grown.top + 400).toBeLessThanOrEqual(638);
  });

  it("re-chooses a locked-above popover that grows past the top edge", () => {
    expect(computeAnchoredPlacement({
      anchorTop: 200, anchorBottom: 230, height: 400, viewportHeight: VH, lockedSide: "above",
    })).toEqual({ top: 234, side: "below" });
  });

  it("keeps a pinned popover pinned", () => {
    expect(computeAnchoredPlacement({
      anchorTop: 100, anchorBottom: 130, height: 60, viewportHeight: VH, lockedSide: "pinned",
    })).toEqual({ top: VH - 8 - 60, side: "pinned" });
  });

  it("computeAnchoredTop returns the placement's top alone", () => {
    expect(computeAnchoredTop({
      anchorTop: 568, anchorBottom: 598, height: 60, viewportHeight: VH, lockedSide: "above",
    })).toBe(504);
  });
});

describe("placeFixedElement (#1457)", () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it("returns no side and leaves the element untouched while it has no height", () => {
    const el = document.createElement("div");
    el.style.visibility = "hidden";
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(0);
    expect(placeFixedElement(el, { top: 100, bottom: 120, left: 30 })).toBeUndefined();
    expect(el.style.visibility).toBe("hidden");
    expect(el.style.top).toBe("");
  });

  it("never re-hides a placed element on a transient empty measurement", () => {
    // ReactRenderer can render the list empty (items loading) and refill it
    // within one frame; a ResizeObserver then sees no size change, so a
    // re-hide here would leave the popup hidden for good.
    const el = document.createElement("div");
    const height = vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(200);
    placeFixedElement(el, { top: 100, bottom: 120, left: 30 });
    expect(el.style.visibility).toBe("");
    height.mockReturnValue(0);
    expect(placeFixedElement(el, { top: 100, bottom: 120, left: 30 })).toBeUndefined();
    expect(el.style.visibility).toBe("");
    expect(el.style.top).toBe("124px");
  });

  it("places from the measured height and honors the locked side", () => {
    const el = document.createElement("div");
    const height = vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(200);
    const side = placeFixedElement(el, { top: window.innerHeight - 40, bottom: window.innerHeight - 20, left: 0 });
    expect(side).toBe("above");
    expect(el.style.top).toBe(`${window.innerHeight - 40 - 4 - 200}px`);
    expect(el.style.visibility).toBe("");
    height.mockReturnValue(30);
    expect(placeFixedElement(el, { top: window.innerHeight - 40, bottom: window.innerHeight - 20, left: 0 }, side)).toBe("above");
    expect(el.style.top).toBe(`${window.innerHeight - 40 - 4 - 30}px`);
  });
});

describe("visualViewport placement (#2138)", () => {
  afterEach(() => { clearVisualViewport(); vi.restoreAllMocks(); });

  it("getVisibleViewport falls back to the window without visualViewport", () => {
    clearVisualViewport();
    expect(getVisibleViewport()).toEqual({ top: 0, height: window.innerHeight });
  });

  it("getVisibleViewport reads height and offsetTop from visualViewport", () => {
    stubVisualViewport({ height: 400, offsetTop: 30 });
    expect(getVisibleViewport()).toEqual({ top: 30, height: 400 });
  });

  it("getVisibleViewport ignores a zero-height visualViewport", () => {
    stubVisualViewport({ height: 0 });
    expect(getVisibleViewport()).toEqual({ top: 0, height: window.innerHeight });
  });

  it("subscribeVisualViewport is a no-op without visualViewport", () => {
    clearVisualViewport();
    expect(() => subscribeVisualViewport(vi.fn())()).not.toThrow();
  });

  it("subscribeVisualViewport listens to resize and scroll and removes both", () => {
    const { vv, add, remove } = stubVisualViewport({ height: 400 });
    const cb = vi.fn();
    const off = subscribeVisualViewport(cb);
    vv.dispatchEvent(new Event("resize"));
    vv.dispatchEvent(new Event("scroll"));
    expect(cb).toHaveBeenCalledTimes(2);
    off();
    expect(add.mock.calls.map((c) => c[0]).sort()).toEqual(["resize", "scroll"]);
    expect(remove.mock.calls.map((c) => c[0]).sort()).toEqual(["resize", "scroll"]);
    vv.dispatchEvent(new Event("resize"));
    expect(cb).toHaveBeenCalledTimes(2);
  });

  it("computeAnchoredPlacement measures inside a visible box that starts below the viewport top", () => {
    // Visible box: y 100..500. Anchor 380-420 leaves 500-8-424 = 68 below; a 100px list goes above.
    expect(computeAnchoredPlacement({
      anchorTop: 380, anchorBottom: 420, height: 100, viewportHeight: 400, viewportTop: 100,
    })).toEqual({ top: 276, side: "above" });
    // With room below it stays below.
    expect(computeAnchoredPlacement({
      anchorTop: 120, anchorBottom: 160, height: 100, viewportHeight: 400, viewportTop: 100,
    })).toEqual({ top: 164, side: "below" });
    // Pinning respects both edges of the visible box.
    expect(computeAnchoredPlacement({
      anchorTop: 200, anchorBottom: 240, height: 390, viewportHeight: 400, viewportTop: 100,
    })).toEqual({ top: 108, side: "pinned" });
  });

  it("placeFixedElement goes above when the keyboard leaves no room below, and below without visualViewport", () => {
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(100);
    const anchor = { top: 300, bottom: 340, left: 10 };
    const el = document.createElement("div");
    // innerHeight (768) alone would place it below at 344; the keyboard leaves 400px.
    stubVisualViewport({ height: 400 });
    expect(placeFixedElement(el, anchor)).toBe("above");
    expect(el.style.top).toBe("196px");
    clearVisualViewport();
    const el2 = document.createElement("div");
    expect(placeFixedElement(el2, anchor)).toBe("below");
    expect(el2.style.top).toBe("344px");
  });

  it("placeFixedElement honors visualViewport.offsetTop for a panned viewport", () => {
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(100);
    // Visible box y 200..600. Anchor 520-560: 564+100 > 592 so it cannot fit below; above is 416.
    stubVisualViewport({ height: 400, offsetTop: 200 });
    const el = document.createElement("div");
    expect(placeFixedElement(el, { top: 520, bottom: 560, left: 0 })).toBe("above");
    expect(el.style.top).toBe("416px");
    // An anchor near the box top must not pin above the box: 210-250 fits below at 254.
    const el2 = document.createElement("div");
    expect(placeFixedElement(el2, { top: 210, bottom: 250, left: 0 })).toBe("below");
    expect(el2.style.top).toBe("254px");
    // Too tall for either side: pinned inside the box (the bottom-pinned 202 is clamped up to the box top plus margin: 200 + max(8, 2) = 208), not at innerHeight - ...
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(390);
    const el3 = document.createElement("div");
    expect(placeFixedElement(el3, { top: 300, bottom: 340, left: 0 })).toBe("pinned");
    expect(el3.style.top).toBe("208px");
  });

  it("useAnchoredPlacement re-places on visualViewport resize and scroll, and removes the listeners", () => {
    const { vv, remove } = stubVisualViewport({ height: 768 });
    const panel = document.createElement("div");
    vi.spyOn(panel, "offsetHeight", "get").mockReturnValue(100);
    const ref = { current: panel };
    const { result, unmount } = renderHook(() =>
      useAnchoredPlacement(ref, { anchor: { top: 300, bottom: 340 } }));
    expect(result.current).toBe(344);
    // Keyboard opens: the side is re-chosen from the smaller visible height.
    act(() => { vv.height = 400; vv.dispatchEvent(new Event("resize")); });
    expect(result.current).toBe(196);
    // The browser pans the visual viewport; the box now spans 200..600.
    act(() => { vv.height = 400; vv.offsetTop = 200; vv.dispatchEvent(new Event("scroll")); });
    expect(result.current).toBe(344);
    unmount();
    expect(remove.mock.calls.map((c) => c[0]).sort()).toEqual(["resize", "scroll"]);
  });

  it("useAnchoredPlacement does not subscribe while closed", () => {
    const { add } = stubVisualViewport({ height: 768 });
    const ref = { current: document.createElement("div") };
    const { result } = renderHook(() => useAnchoredPlacement(ref, { anchor: null }));
    expect(result.current).toBeNull();
    expect(add).not.toHaveBeenCalled();
  });
});
