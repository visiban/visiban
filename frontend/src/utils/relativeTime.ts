/**
 * Single shared relative-time formatter (#git-lens).
 *
 * Extracted from ConnectionStatus so the issue-lens freshness control and the
 * connection-status popover render "X ago" identically. Do not fork a second
 * relative-time formatter — import this one. See frontend/CLAUDE.md.
 *
 * @param ts  the past timestamp, in epoch milliseconds
 * @param now the reference "now", in epoch milliseconds (pass an explicit value
 *            so callers stay deterministic in tests)
 */
export function relativeTime(ts: number, now: number): string {
  const diff = Math.max(0, now - ts);
  if (diff < 10_000) return "just now";
  if (diff < 60_000) return `${Math.floor(diff / 1000)} s ago`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} h ago`;
  return `${Math.floor(diff / 86_400_000)} d ago`;
}
