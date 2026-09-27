import { useEffect, useState } from "react";

/** The demo bar flips to its warning tone this long before a reset (#1179). */
export const DEMO_WARNING_MS = 5 * 60_000;
/** Refresh cadence of the minute label while above the warning threshold. */
export const DEMO_TICK_MS = 30_000;

export interface DemoCountdown {
  /** Whole minutes until the reset, rounded up; null for an unparseable instant. */
  minutesRemaining: number | null;
  /** True from 5 minutes before the reset for the rest of the session. */
  isWarning: boolean;
}

/**
 * Countdown to the next hosted-demo reset (#1179).
 *
 * Recomputed from `Date.parse(nextResetAt) - Date.now()` on every tick rather
 * than decremented, so it cannot drift and needs no visibility-change
 * correction after a backgrounded tab's timers were throttled. Ticks every
 * 30s while above the threshold, plus one timer aimed exactly at the
 * threshold so the warning never lands up to a tick late. Once in the warning
 * window it stops ticking: the copy there is one fixed sentence with no
 * number, and the reset that follows ends the session anyway.
 */
export function useDemoCountdown(nextResetAt: string): DemoCountdown {
  const remaining = () => Date.parse(nextResetAt) - Date.now();
  const [ms, setMs] = useState(remaining);
  const [isWarning, setIsWarning] = useState(() => remaining() <= DEMO_WARNING_MS);

  useEffect(() => {
    if (isWarning) return;
    const tick = () => {
      const r = Date.parse(nextResetAt) - Date.now();
      setMs(r);
      if (r <= DEMO_WARNING_MS) setIsWarning(true);
    };
    tick();
    const interval = setInterval(tick, DEMO_TICK_MS);
    const untilWarning = Date.parse(nextResetAt) - Date.now() - DEMO_WARNING_MS;
    const boundary = Number.isFinite(untilWarning) ? setTimeout(tick, Math.max(0, untilWarning)) : undefined;
    return () => {
      clearInterval(interval);
      if (boundary !== undefined) clearTimeout(boundary);
    };
  }, [nextResetAt, isWarning]);

  if (Number.isNaN(ms)) return { minutesRemaining: null, isWarning: false };
  return { minutesRemaining: Math.max(0, Math.ceil(ms / 60_000)), isWarning };
}
