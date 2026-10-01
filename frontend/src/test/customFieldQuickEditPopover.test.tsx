import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import CustomFieldQuickEditPopover from "../components/Card/CustomFieldQuickEditPopover";

// jsdom returns a zeroed DOMRect from getBoundingClientRect by default, but
// this component takes anchorRect as a prop rather than measuring the DOM
// itself, so tests just build the rect object directly (same shape used by
// CardPeekPopover's tests in cardPeek.test.tsx).
function makeRect(overrides: Partial<DOMRect> = {}): DOMRect {
  return {
    top: 260,
    left: 100,
    bottom: 300,
    right: 150,
    width: 50,
    height: 40,
    x: 100,
    y: 260,
    toJSON: () => ({}),
    ...overrides,
  } as DOMRect;
}

const CHOICES = ["Low", "Medium", "High"];

function setInnerWidth(width: number) {
  Object.defineProperty(window, "innerWidth", { writable: true, configurable: true, value: width });
}

const ORIGINAL_INNER_WIDTH = window.innerWidth;

describe("CustomFieldQuickEditPopover", () => {
  afterEach(() => {
    setInnerWidth(ORIGINAL_INNER_WIDTH);
    vi.restoreAllMocks();
  });

  it("calls onDismiss when Escape is pressed", () => {
    const onDismiss = vi.fn();
    render(
      <CustomFieldQuickEditPopover
        anchorRect={makeRect()}
        choices={CHOICES}
        selected="Low"
        onSelect={() => {}}
        onDismiss={onDismiss}
      />
    );

    fireEvent.keyDown(document, { key: "Escape" });

    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("does not call onDismiss for a non-Escape key", () => {
    const onDismiss = vi.fn();
    render(
      <CustomFieldQuickEditPopover
        anchorRect={makeRect()}
        choices={CHOICES}
        selected="Low"
        onSelect={() => {}}
        onDismiss={onDismiss}
      />
    );

    fireEvent.keyDown(document, { key: "Enter" });

    expect(onDismiss).not.toHaveBeenCalled();
  });

  it("calls onDismiss when a mousedown occurs outside the popover", () => {
    const onDismiss = vi.fn();
    render(
      <CustomFieldQuickEditPopover
        anchorRect={makeRect()}
        choices={CHOICES}
        selected="Low"
        onSelect={() => {}}
        onDismiss={onDismiss}
      />
    );

    fireEvent.mouseDown(document.body);

    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("does NOT call onDismiss when a mousedown occurs inside the popover", () => {
    const onDismiss = vi.fn();
    render(
      <CustomFieldQuickEditPopover
        anchorRect={makeRect()}
        choices={CHOICES}
        selected="Low"
        onSelect={() => {}}
        onDismiss={onDismiss}
      />
    );

    fireEvent.mouseDown(screen.getAllByRole("option")[0]);

    expect(onDismiss).not.toHaveBeenCalled();
  });

  it("removes the keydown and mousedown listeners on unmount", () => {
    const addSpy = vi.spyOn(document, "addEventListener");
    const removeSpy = vi.spyOn(document, "removeEventListener");
    const onDismiss = vi.fn();

    const { unmount } = render(
      <CustomFieldQuickEditPopover
        anchorRect={makeRect()}
        choices={CHOICES}
        selected="Low"
        onSelect={() => {}}
        onDismiss={onDismiss}
      />
    );

    const keydownHandler = addSpy.mock.calls.find((call) => call[0] === "keydown")?.[1];
    const mousedownHandler = addSpy.mock.calls.find((call) => call[0] === "mousedown")?.[1];
    expect(keydownHandler).toBeDefined();
    expect(mousedownHandler).toBeDefined();

    unmount();

    expect(removeSpy).toHaveBeenCalledWith("keydown", keydownHandler);
    expect(removeSpy).toHaveBeenCalledWith("mousedown", mousedownHandler);

    // Belt-and-suspenders: a regression where the listener is added but never
    // actually removed (e.g. a dependency-array mismatch producing a new
    // handler on each render) would still pass the mock-call assertions above
    // if removeEventListener is called with *a* handler, just not the live
    // one. Firing Escape post-unmount and confirming onDismiss stays silent
    // catches that case directly.
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it("flips to right-anchored positioning when the anchor is near the right edge of the viewport", () => {
    setInnerWidth(320);
    // left (200) + POPOVER_WIDTH (190) = 390 > 320 → must overflow and flip.
    const anchorRect = makeRect({ left: 200, right: 250 });

    render(
      <CustomFieldQuickEditPopover
        anchorRect={anchorRect}
        choices={CHOICES}
        selected="Low"
        onSelect={() => {}}
        onDismiss={() => {}}
      />
    );

    const popover = screen.getByRole("listbox");
    expect(popover.style.right).toBe(`${320 - 250}px`);
    expect(popover.style.left).toBe("");
  });

  it("does not flip positioning when the anchor is not near the right edge of the viewport", () => {
    setInnerWidth(1024);
    // left (100) + POPOVER_WIDTH (190) = 290 < 1024 → stays left-anchored.
    const anchorRect = makeRect({ left: 100, right: 150 });

    render(
      <CustomFieldQuickEditPopover
        anchorRect={anchorRect}
        choices={CHOICES}
        selected="Low"
        onSelect={() => {}}
        onDismiss={() => {}}
      />
    );

    const popover = screen.getByRole("listbox");
    expect(popover.style.left).toBe("100px");
    expect(popover.style.right).toBe("");
  });

  it("flips exactly at the overflow boundary (left + 190 === innerWidth stays left-anchored)", () => {
    setInnerWidth(340);
    // left (150) + POPOVER_WIDTH (190) = 340 === innerWidth → not `>`, so no flip.
    const anchorRect = makeRect({ left: 150, right: 200 });

    render(
      <CustomFieldQuickEditPopover
        anchorRect={anchorRect}
        choices={CHOICES}
        selected="Low"
        onSelect={() => {}}
        onDismiss={() => {}}
      />
    );

    const popover = screen.getByRole("listbox");
    expect(popover.style.left).toBe("150px");
    expect(popover.style.right).toBe("");
  });
});
