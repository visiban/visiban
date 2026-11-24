// Bounds on a wait the server sets with Retry-After (#2143, #2428). The
// header decides within them; a missing or unreadable header falls back to
// the caller's default.
const RETRY_AFTER_MIN_MS = 1_000;
const RETRY_AFTER_MAX_MS = 60_000;

/** Milliseconds to wait before retrying, from a 503's Retry-After (seconds), clamped to 1-60 s. */
export function retryAfterDelayMs(error: unknown, defaultMs: number): number {
  const headers = (error as { response?: { headers?: Record<string, unknown> } } | null)?.response?.headers;
  const seconds = Number(headers?.["retry-after"]);
  if (!Number.isFinite(seconds) || seconds <= 0) return defaultMs;
  return Math.min(RETRY_AFTER_MAX_MS, Math.max(RETRY_AFTER_MIN_MS, seconds * 1000));
}
