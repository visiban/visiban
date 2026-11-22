import { useSyncExternalStore } from "react";

/**
 * One shared ticker for every card-face relative time (#2210).
 *
 * A board can hold hundreds of parent footers; one interval per footer would be
 * hundreds of timers. All subscribers share a single interval that starts with
 * the first subscriber and is cleared when the last unsubscribes, so nothing
 * outlives the last unmount (a leaked timer was a real CI failure here before).
 * Granularity is a minute: the finest relative wording is "just now" / hours.
 */
export const CLOCK_TICK_MS = 60_000;

let now = Date.now();
let timerId: number | null = null;
const listeners = new Set<() => void>();

function start() {
  if (timerId !== null) return;
  now = Date.now();
  timerId = window.setInterval(() => {
    now = Date.now();
    listeners.forEach((l) => l());
  }, CLOCK_TICK_MS);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  start();
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timerId !== null) {
      window.clearInterval(timerId);
      timerId = null;
    }
  };
}

/** Epoch ms, refreshed every minute while any component is mounted. */
export function useSharedMinuteClock(): number {
  return useSyncExternalStore(subscribe, () => now, () => now);
}
