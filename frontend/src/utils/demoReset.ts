/**
 * Hosted-demo reset detection (#1179).
 *
 * The demo resets on a schedule by wiping the whole database, which also ends
 * every session. The visitor's next request then fails auth — a REST 401 or a
 * WebSocket 4001/4003 close — and without this they would see a generic
 * "session expired" (or a dead socket) instead of being told the demo reset.
 *
 * While signed in, useAuth stashes the server-computed next reset instant in
 * sessionStorage. When auth later fails, `checkAndFlagDemoReset()` compares it
 * with the clock: if the reset time has passed, the failure is the reset, so
 * it leaves a one-shot notice for LoginPage to show. sessionStorage is per-tab,
 * so a tab closed across a reset loses the notice — accepted, not a bug.
 */

export const DEMO_NEXT_RESET_KEY = "demo_next_reset_at";
export const DEMO_RESET_NOTICE_KEY = "demo_reset_notice_at";

/** Remember (or forget) the next reset instant for the signed-in session. */
export function stashDemoNextReset(nextResetAt: string | null | undefined): void {
  try {
    if (nextResetAt) sessionStorage.setItem(DEMO_NEXT_RESET_KEY, nextResetAt);
    else sessionStorage.removeItem(DEMO_NEXT_RESET_KEY);
  } catch {
    /* storage unavailable (private mode) — the notice is a nicety */
  }
}

/**
 * If a stashed reset instant has passed, flag the post-reset login notice and
 * return true. Called on an auth failure, before the session-expired event.
 */
export function checkAndFlagDemoReset(now: number = Date.now()): boolean {
  try {
    const stashed = sessionStorage.getItem(DEMO_NEXT_RESET_KEY);
    if (!stashed) return false;
    const at = Date.parse(stashed);
    if (Number.isNaN(at) || now < at) return false;
    sessionStorage.setItem(DEMO_RESET_NOTICE_KEY, stashed);
    sessionStorage.removeItem(DEMO_NEXT_RESET_KEY);
    return true;
  } catch {
    return false;
  }
}

/** Read and clear the one-shot post-reset notice; returns the reset instant or null. */
export function consumeDemoResetNotice(): string | null {
  try {
    const value = sessionStorage.getItem(DEMO_RESET_NOTICE_KEY);
    if (value) sessionStorage.removeItem(DEMO_RESET_NOTICE_KEY);
    return value;
  } catch {
    return null;
  }
}
