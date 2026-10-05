import { describe, it, expect, vi, afterEach } from "vitest";
import { computeAnchoredPlacement, placeFixedElement } from "../hooks/useAnchoredPlacement";

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

  it("keeps a downward popover below, sliding up only when it grows past the edge", () => {
    expect(computeAnchoredPlacement({
      anchorTop: 500, anchorBottom: 530, height: 400, viewportHeight: VH, lockedSide: "below",
    })).toEqual({ top: VH - 8 - 400, side: "below" });
  });

  it("keeps a pinned popover pinned", () => {
    expect(computeAnchoredPlacement({
      anchorTop: 100, anchorBottom: 130, height: 60, viewportHeight: VH, lockedSide: "pinned",
    })).toEqual({ top: VH - 8 - 60, side: "pinned" });
  });
});

describe("placeFixedElement (#1457)", () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it("stays hidden and returns no side until the element has a height", () => {
    const el = document.createElement("div");
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(0);
    expect(placeFixedElement(el, { top: 100, bottom: 120, left: 30 })).toBeUndefined();
    expect(el.style.visibility).toBe("hidden");
    expect(el.style.left).toBe("30px");
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
