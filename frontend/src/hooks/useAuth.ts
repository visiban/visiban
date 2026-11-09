import { useEffect, useState } from "react";
import { getCurrentUser, logout as apiLogout } from "../api/auth";
import { isSessionUnavailableError } from "../api/client";
import { clearRecentBoardsPrefs } from "./useRecentBoardsPref";
import { stashDemoNextReset } from "../utils/demoReset";
import type { User } from "../types";

// Bounds on the wait before re-reading the current user while the server
// can't check the session (#2143). The server's Retry-After decides within
// them; a missing or unreadable header falls back to the default.
export const SESSION_RETRY_DEFAULT_MS = 10_000;
const SESSION_RETRY_MIN_MS = 1_000;
const SESSION_RETRY_MAX_MS = 60_000;

/** Milliseconds to wait before retrying, from the 503's Retry-After (seconds). */
export function sessionRetryDelayMs(error: unknown): number {
  const headers = (error as { response?: { headers?: Record<string, unknown> } }).response?.headers;
  const seconds = Number(headers?.["retry-after"]);
  if (!Number.isFinite(seconds) || seconds <= 0) return SESSION_RETRY_DEFAULT_MS;
  return Math.min(SESSION_RETRY_MAX_MS, Math.max(SESSION_RETRY_MIN_MS, seconds * 1000));
}

export function useAuth() {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  // The bootstrap read answered "session can't be checked" (#2143): keep
  // loading (never show the sign-in page for a session that still exists)
  // and retry until the server answers either way.
  const [sessionUnavailable, setSessionUnavailable] = useState(false);

  useEffect(() => {
    let canceled = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    const load = () => {
      getCurrentUser()
        .then((current) => {
          if (canceled) return;
          setUser(current);
          setSessionUnavailable(false);
          setLoading(false);
        })
        .catch((error: unknown) => {
          if (canceled) return;
          if (isSessionUnavailableError(error)) {
            setSessionUnavailable(true);
            retryTimer = setTimeout(load, sessionRetryDelayMs(error));
            return;
          }
          setUser(null);
          setSessionUnavailable(false);
          setLoading(false);
        });
    };
    load();
    return () => {
      canceled = true;
      clearTimeout(retryTimer);
    };
  }, []);

  useEffect(() => {
    const handleSessionExpired = () => {
      // Clear any pending invite-link state so a subsequent user on the same
      // tab doesn't inherit a stale join intent from the previous session.
      sessionStorage.removeItem("pendingJoinToken");
      sessionStorage.removeItem("returnTo");
      // Recent boards hold board/group names; drop them so the next account on
      // this browser cannot read them (#1955).
      clearRecentBoardsPrefs();
      setUser(null);
    };
    window.addEventListener("auth:sessionExpired", handleSessionExpired);
    return () => window.removeEventListener("auth:sessionExpired", handleSessionExpired);
  }, []);

  const logout = async () => {
    await apiLogout();
    // A deliberate sign-out is not a reset; forget the instant so a later
    // auth failure in this tab cannot be misread as one.
    stashDemoNextReset(null);
    sessionStorage.removeItem("pendingJoinToken");
    sessionStorage.removeItem("returnTo");
    clearRecentBoardsPrefs();
    setUser(null);
  };

  return { user, loading, sessionUnavailable, logout, updateUser: setUser };
}
