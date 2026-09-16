import { useCallback, useEffect, useRef, useState } from "react";
import { getCurrentUser, logout as apiLogout } from "../api/auth";
import { useVisibilityResync } from "./useVisibilityResync";
import type { User } from "../types";

export function useAuth() {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    getCurrentUser()
      .then(setUser)
      .catch(() => setUser(null))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    const handleSessionExpired = () => {
      // Clear any pending invite-link state so a subsequent user on the same
      // tab doesn't inherit a stale join intent from the previous session.
      sessionStorage.removeItem("pendingJoinToken");
      sessionStorage.removeItem("returnTo");
      setUser(null);
    };
    window.addEventListener("auth:sessionExpired", handleSessionExpired);
    return () => window.removeEventListener("auth:sessionExpired", handleSessionExpired);
  }, []);

  useEffect(() => {
    // A write was rejected because the instance entered maintenance mode after
    // this session bootstrapped (#783). The user object in memory still says
    // maintenance_mode is false, so patch it from the event rather than
    // re-fetching: the notice is already in the 503 body, and a refetch here
    // would fire once per rejected write during exactly the window when the
    // server is least able to absorb extra load.
    const handleMaintenanceBlocked = (event: Event) => {
      const { message } = (event as CustomEvent<{ message: string }>).detail ?? { message: "" };
      setUser((current) =>
        current && !current.maintenance_mode
          ? { ...current, maintenance_mode: true, maintenance_message: message }
          : current,
      );
    };
    window.addEventListener("auth:maintenanceBlocked", handleMaintenanceBlocked);
    return () => window.removeEventListener("auth:maintenanceBlocked", handleMaintenanceBlocked);
  }, []);

  // The banner must also be able to go AWAY. Nothing pushes maintenance state
  // to an open tab — there is no WebSocket event for it, and polling would add
  // steady-state load for a condition that is off on virtually every install —
  // so refresh the current user when the tab returns to the foreground. That is
  // the moment someone comes back to a tab they left before the maintenance
  // window started, or after it ended.
  //
  // Goes through the shared useVisibilityResync so it inherits the same 30s
  // throttle the board resync uses: without it, every alt-tab would fire a
  // request, and this hook is mounted at the app root for the whole session
  // rather than only while a board is open.
  // Tracked in a ref rather than closed over, so the callback stays stable and
  // the resync listener is not torn down and re-registered on every user
  // change (which would also reset its throttle).
  const hasUserRef = useRef(false);
  useEffect(() => {
    hasUserRef.current = user !== null;
  }, [user]);

  const refreshMaintenanceState = useCallback(() => {
    // MUST NOT run while signed out. An unauthenticated GET /auth/user/ returns
    // 401, the response interceptor turns that into auth:sessionExpired, and
    // the handler above clears pendingJoinToken and returnTo — silently
    // breaking the invite-link join flow for anyone who alt-tabs away from the
    // login page to fetch their password. The .catch() below does not help:
    // the interceptor has already fired by the time it runs.
    if (!hasUserRef.current) return;
    getCurrentUser()
      .then((fresh) =>
        // Merge only the instance-wide flags instead of replacing the whole
        // user. A wholesale replace would revert any optimistic profile edit
        // (theme, timezone, display name, has_completed_tour) whose PATCH is
        // still in flight when a tab-focus lands — a last-write-wins race for
        // no benefit, since maintenance state is the only thing this refresh
        // exists to learn.
        setUser((current) =>
          current
            ? {
                ...current,
                maintenance_mode: fresh.maintenance_mode,
                maintenance_message: fresh.maintenance_message,
              }
            : current,
        ),
      )
      // Swallowed deliberately: a failed refresh must not sign the user out.
      // A genuinely dead session is handled by the 401 interceptor above.
      .catch(() => {});
  }, []);
  useVisibilityResync(refreshMaintenanceState);

  const logout = async () => {
    await apiLogout();
    sessionStorage.removeItem("pendingJoinToken");
    sessionStorage.removeItem("returnTo");
    setUser(null);
  };

  return { user, loading, logout, updateUser: setUser };
}
