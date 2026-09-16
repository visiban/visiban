import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { useVisibilityResync, RESYNC_THROTTLE_MS } from "../hooks/useVisibilityResync";

/**
 * Direct coverage for the shared tab-focus resync (#783). Both callers —
 * useBoardResync and useAuth — depend on the throttle being enforced HERE; a
 * regression in it would show up as unbounded request volume rather than as a
 * failing assertion in either caller's own suite.
 */
describe("useVisibilityResync", () => {
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
    origVisibilityState = Object.getOwnPropertyDescriptor(document, "visibilityState");
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    if (origVisibilityState) {
      Object.defineProperty(document, "visibilityState", origVisibilityState);
    }
  });

  it("runs the callback when the tab becomes visible", () => {
    const cb = vi.fn();
    renderHook(() => useVisibilityResync(cb));
    setVisibility("visible");
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it("ignores the event when the tab is being hidden", () => {
    const cb = vi.fn();
    renderHook(() => useVisibilityResync(cb));
    setVisibility("hidden");
    expect(cb).not.toHaveBeenCalled();
  });

  it("throttles rapid tab switching", () => {
    const cb = vi.fn();
    renderHook(() => useVisibilityResync(cb));
    setVisibility("visible");
    setVisibility("hidden");
    setVisibility("visible");
    setVisibility("hidden");
    setVisibility("visible");
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it("runs again once the throttle window has passed", () => {
    const cb = vi.fn();
    renderHook(() => useVisibilityResync(cb));
    setVisibility("visible");
    expect(cb).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(RESYNC_THROTTLE_MS + 1);
    setVisibility("visible");
    expect(cb).toHaveBeenCalledTimes(2);
  });

  it("honors a custom throttle window", () => {
    const cb = vi.fn();
    renderHook(() => useVisibilityResync(cb, 1_000));
    setVisibility("visible");
    vi.advanceTimersByTime(1_001);
    setVisibility("visible");
    expect(cb).toHaveBeenCalledTimes(2);
  });

  it("detaches the listener on unmount", () => {
    const cb = vi.fn();
    const { unmount } = renderHook(() => useVisibilityResync(cb));
    unmount();
    setVisibility("visible");
    expect(cb).not.toHaveBeenCalled();
  });
});
