import type { AnalyticsErrorCode } from "../types";
import { retryAfterDelayMs } from "./retryAfter";

/**
 * The analytics limits' refusals (#2428): `analytics_busy` (503, retry after
 * Retry-After), `analytics_timeout` (503, #2645: the request ran past the
 * server's time limit, so the same request would likely run as long again) and
 * `analytics_too_large` (422, retrying does not help).
 * Matched on status plus code, like `isSessionUnavailableError`, since a proxy
 * also answers 503.
 */
export type AnalyticsErrorKind = "busy" | "timeout" | "too_large" | "other";

const BUSY: AnalyticsErrorCode = "analytics_busy";
const TIMEOUT: AnalyticsErrorCode = "analytics_timeout";
const TOO_LARGE: AnalyticsErrorCode = "analytics_too_large";
const BUSY_RETRY_DEFAULT_MS = 10_000;

export function analyticsErrorKind(reason: unknown): AnalyticsErrorKind {
  const response = (reason as { response?: { status?: number; data?: unknown } } | null)?.response;
  const code = (response?.data as { code?: unknown } | undefined)?.code;
  if (response?.status === 503 && code === BUSY) return "busy";
  if (response?.status === 503 && code === TIMEOUT) return "timeout";
  if (response?.status === 422 && code === TOO_LARGE) return "too_large";
  return "other";
}

/** The worst of several failures: too_large wins (retrying cannot help), then timeout, then busy. */
export function worstAnalyticsErrorKind(reasons: unknown[]): AnalyticsErrorKind {
  const kinds = reasons.map((reason) => analyticsErrorKind(reason));
  if (kinds.includes("too_large")) return "too_large";
  if (kinds.includes("timeout")) return "timeout";
  if (kinds.includes("busy")) return "busy";
  return "other";
}

/**
 * What a failed analytics region says, per kind. `null` keeps the region's own generic copy.
 * `wholeHistory` is for a request whose size does not follow the period (the cumulative-flow
 * day drill-down, which reads every card of the board), where a shorter period would not help. `noPeriod` is
 * for a surface with no period to shorten (the Summary tab).
 */
export function analyticsErrorMessage(
  kind: AnalyticsErrorKind, { wholeHistory = false, noPeriod = false } = {},
): string | null {
  if (kind === "busy") return "Analytics is busy right now. Try again in a moment.";
  if (kind === "timeout") {
    if (wholeHistory) return "This took longer than the server allows, so these cards can't be listed here. Ask your administrator.";
    if (noPeriod) return "This took longer than the server allows. Ask your administrator.";
    return "This took longer than the server allows. Try a shorter period, or ask your administrator.";
  }
  if (kind === "too_large") {
    // The headline matches the API's constant detail; the advice is only what helps on this surface.
    if (wholeHistory) {
      return "This board has more history than this server is set up to analyze, so these cards can't be listed here. Ask your administrator.";
    }
    if (noPeriod) return "This board has more history than this server is set up to analyze. Ask your administrator.";
    return "This board has more history than this server is set up to analyze. Try a shorter period, or ask your administrator.";
  }
  return null;
}

/** Whether a Retry control makes sense for this failure: never for too_large or timeout. */
export function analyticsErrorRetryable(kind: AnalyticsErrorKind): boolean {
  return kind !== "too_large" && kind !== "timeout";
}

/** The rejection of a busy retry dropped because its caller unmounted or moved on. */
export class AnalyticsRetryCanceled extends Error {
  constructor() {
    super("The analytics retry was canceled.");
    this.name = "AbortError";
  }
}

/** Resolve after `ms`, or reject with `AnalyticsRetryCanceled` (clearing the timer) once `signal` aborts. */
export function cancelableWait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) { reject(new AnalyticsRetryCanceled()); return; }
    const onAbort = () => { clearTimeout(timer); reject(new AnalyticsRetryCanceled()); };
    const timer = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(); }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Run `request`, and when the server answers `analytics_busy`, wait its
 * Retry-After (clamped to 1-60 s) and run it once more. Any other failure, and
 * a second busy, reject as they came, so the caller shows its failure state.
 *
 * `signal` cancels the pending retry: once it aborts (the caller unmounted or
 * its filters changed), the timer is cleared and the request is not sent again,
 * so a stale retry never takes one of the user's analytics slots.
 */
export async function withAnalyticsBusyRetry<T>(
  request: () => Promise<T>,
  wait: (ms: number, signal?: AbortSignal) => Promise<void> = cancelableWait,
  signal?: AbortSignal,
): Promise<T> {
  try {
    return await request();
  } catch (error) {
    if (analyticsErrorKind(error) !== "busy") throw error;
    await wait(retryAfterDelayMs(error, BUSY_RETRY_DEFAULT_MS), signal);
    if (signal?.aborted) throw new AnalyticsRetryCanceled();
    return request();
  }
}
