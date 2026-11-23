import type { AnalyticsErrorCode } from "../types";
import { retryAfterDelayMs } from "./retryAfter";

/**
 * The analytics limits' refusals (#2428): `analytics_busy` (503, retry after
 * Retry-After) and `analytics_too_large` (422, retrying does not help).
 * Matched on status plus code, like `isSessionUnavailableError`, since a proxy
 * also answers 503.
 */
export type AnalyticsErrorKind = "busy" | "too_large" | "other";

const BUSY: AnalyticsErrorCode = "analytics_busy";
const TOO_LARGE: AnalyticsErrorCode = "analytics_too_large";
const BUSY_RETRY_DEFAULT_MS = 10_000;

export function analyticsErrorKind(reason: unknown): AnalyticsErrorKind {
  const response = (reason as { response?: { status?: number; data?: unknown } } | null)?.response;
  const code = (response?.data as { code?: unknown } | undefined)?.code;
  if (response?.status === 503 && code === BUSY) return "busy";
  if (response?.status === 422 && code === TOO_LARGE) return "too_large";
  return "other";
}

/** The worst of several failures: too_large wins (retrying cannot help), then busy. */
export function worstAnalyticsErrorKind(reasons: unknown[]): AnalyticsErrorKind {
  const kinds = reasons.map((reason) => analyticsErrorKind(reason));
  if (kinds.includes("too_large")) return "too_large";
  if (kinds.includes("busy")) return "busy";
  return "other";
}

/**
 * What a failed analytics region says, per kind. `null` keeps the region's own generic copy.
 * `wholeHistory` is for a request that reads the board's whole history whatever the period
 * (the cumulative-flow day drill-down), where a shorter period would not help.
 */
export function analyticsErrorMessage(kind: AnalyticsErrorKind, { wholeHistory = false } = {}): string | null {
  if (kind === "busy") return "Analytics is busy right now. Try again in a moment.";
  if (kind === "too_large") {
    return wholeHistory
      ? "This board has too much history to list these cards here. Ask your administrator."
      : "This board has too much history to analyze here. Try a shorter period, or ask your administrator.";
  }
  return null;
}

/** Whether a Retry control makes sense for this failure: never for too_large. */
export function analyticsErrorRetryable(kind: AnalyticsErrorKind): boolean {
  return kind !== "too_large";
}

const defaultWait = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); });

/**
 * Run `request`, and when the server answers `analytics_busy`, wait its
 * Retry-After (clamped to 1-60 s) and run it once more. Any other failure, and
 * a second busy, reject as they came, so the caller shows its failure state.
 */
export async function withAnalyticsBusyRetry<T>(
  request: () => Promise<T>, wait: (ms: number) => Promise<void> = defaultWait,
): Promise<T> {
  try {
    return await request();
  } catch (error) {
    if (analyticsErrorKind(error) !== "busy") throw error;
    await wait(retryAfterDelayMs(error, BUSY_RETRY_DEFAULT_MS));
    return request();
  }
}
