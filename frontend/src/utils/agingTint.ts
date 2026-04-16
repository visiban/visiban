/**
 * Computes the aging tint classes for a card tile overlay.
 * Uses a two-stage model: warning tint (approaching threshold) and stale tint (past threshold).
 * Color + opacity dual-signal satisfies WCAG 1.4.1.
 */
export function agingTint(
  lastMovedAt: string | null,
  thresholdDays: number,
  warningPct: number
): { overlayClass: string | null; bodyOpacityClass: string } {
  if (!lastMovedAt) return { overlayClass: null, bodyOpacityClass: "" };
  const days = Math.max(1, thresholdDays); // prevent division by zero
  const ratio = Math.min(1, (Date.now() - new Date(lastMovedAt).getTime()) / (days * 86_400_000));
  const warnRatio = 1 - warningPct / 100;
  if (ratio >= 1.0) {
    return {
      overlayClass: "absolute inset-0 rounded-md pointer-events-none bg-amber-500/20",
      bodyOpacityClass: "opacity-60",
    };
  }
  if (ratio >= warnRatio) {
    return {
      overlayClass: "absolute inset-0 rounded-md pointer-events-none bg-amber-500/10",
      bodyOpacityClass: "opacity-80",
    };
  }
  return { overlayClass: null, bodyOpacityClass: "" };
}

/** Returns the number of whole days since lastMovedAt. Returns 0 if null. */
export function idleDays(lastMovedAt: string | null): number {
  if (!lastMovedAt) return 0;
  return Math.floor((Date.now() - new Date(lastMovedAt).getTime()) / 86_400_000);
}
