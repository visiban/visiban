import { describe, it, expect, vi, afterEach } from "vitest";
import { computeAnchoredPlacement, computeAnchoredTop, placeFixedElement } from "../hooks/useAnchoredPlacement";

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
