import { vi } from "vitest";

/**
 * jsdom has no `window.visualViewport`; stub one that can fire resize/scroll
 * (#2138, #2161). Shared by the hook test and every anchored-popover adopter
 * test so each case runs with and without a visual viewport.
 */
export function stubVisualViewport(init: { height: number; offsetTop?: number; width?: number; offsetLeft?: number }) {
  const target = new EventTarget();
  const vv = Object.assign(target, {
    height: init.height,
    offsetTop: init.offsetTop ?? 0,
    width: init.width ?? window.innerWidth,
    offsetLeft: init.offsetLeft ?? 0,
  });
  const add = vi.spyOn(target, "addEventListener");
  const remove = vi.spyOn(target, "removeEventListener");
  Object.defineProperty(window, "visualViewport", { configurable: true, value: vv });
  return { vv, add, remove };
}

export function clearVisualViewport() {
  Object.defineProperty(window, "visualViewport", { configurable: true, value: undefined });
}
