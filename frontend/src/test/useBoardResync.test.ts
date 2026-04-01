import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { useBoardResync } from "../hooks/useBoardResync";

describe("useBoardResync", () => {
  let origVisibilityState: PropertyDescriptor | undefined;

  function setVisibility(state: "visible" | "hidden") {
    Object.defineProperty(document, "visibilityState", {
      value: state,
      writable: true,
      configurable: true,
    });
    document.dispatchEvent(new Event("visibilitychange"));
  }

  beforeEach(() => {
    origVisibilityState = Object.getOwnPropertyDescriptor(
      document,
      "visibilityState"
    );
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    if (origVisibilityState) {
      Object.defineProperty(document, "visibilityState", origVisibilityState);
    }
  });

  it("calls reload when tab becomes visible", () => {
    const reload = vi.fn();
    renderHook(() => useBoardResync(reload));

    setVisibility("visible");
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("does not call reload when tab becomes hidden", () => {
    const reload = vi.fn();
    renderHook(() => useBoardResync(reload));

    setVisibility("hidden");
    expect(reload).not.toHaveBeenCalled();
  });

  it("throttles resyncs to 30s intervals", () => {
    const reload = vi.fn();
    renderHook(() => useBoardResync(reload));

    setVisibility("visible");
    expect(reload).toHaveBeenCalledTimes(1);

    // Immediately trigger another visibility change — should be throttled.
    setVisibility("hidden");
    setVisibility("visible");
    expect(reload).toHaveBeenCalledTimes(1);

    // Advance past the throttle window.
    vi.advanceTimersByTime(31_000);
    setVisibility("hidden");
    setVisibility("visible");
    expect(reload).toHaveBeenCalledTimes(2);
  });

  it("cleans up the event listener on unmount", () => {
    const reload = vi.fn();
    const spy = vi.spyOn(document, "removeEventListener");
    const { unmount } = renderHook(() => useBoardResync(reload));

    unmount();
    expect(spy).toHaveBeenCalledWith(
      "visibilitychange",
      expect.any(Function)
    );
    spy.mockRestore();
  });
});
