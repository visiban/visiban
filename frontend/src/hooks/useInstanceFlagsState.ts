import { useCallback, useEffect, useRef, useState } from "react";
import { getSiteConfig } from "../api/auth";
import { useVisibilityResync } from "./useVisibilityResync";
import { stashDemoNextReset } from "../utils/demoReset";
import { setInstanceTimezone } from "../utils/instanceTimezone";
import { DEFAULT_INSTANCE_FLAGS, type InstanceFlags } from "../contexts/InstanceFlagsContext";
import type { SiteConfig } from "../types";

/** A login right after the bootstrap fetch does not need a second request. */
const FRESH_MS = 5_000;

function pickFlags(config: SiteConfig): InstanceFlags {
  return {
    maintenance_mode: config.maintenance_mode ?? false,
    maintenance_message: config.maintenance_message ?? "",
    demo_mode: config.demo_mode ?? false,
    demo_next_reset_at: config.demo_next_reset_at ?? null,
  };
}

/**
 * Owns the instance flags for the signed-in app (#1913): fetched from
 * /auth/site-config/ (anonymous, so it can run before the user bootstrap
 * settles), refreshed on tab focus, and patched from the 503 maintenance event.
 * Replaces the same three jobs `useAuth` did against `/auth/user/`.
 *
 * `loaded` flips true once the first fetch settles, success or failure, so the
 * shell can wait for it without a dead site-config hanging the app.
 */
export function useInstanceFlagsState(signedIn: boolean) {
  const [flags, setFlags] = useState<InstanceFlags>(DEFAULT_INSTANCE_FLAGS);
  const [loaded, setLoaded] = useState(false);
  const lastFetchRef = useRef(0);

  const fetchFlags = useCallback((fresh = false) => {
    lastFetchRef.current = Date.now();
    return getSiteConfig({ fresh })
      .then((config) => {
        // The overdue rule's "today" (#2313); module state, read by cardUrgency.
        setInstanceTimezone(config.instance_timezone);
        setFlags(pickFlags(config));
      })
      // Swallowed deliberately: a failed refresh must not break the app; the
      // server still enforces maintenance and the demo fence on every write.
      .catch(() => {})
      .finally(() => setLoaded(true));
  }, []);

  // Bootstrap, and again on sign-in when the last fetch is old, so a long-open
  // login page is less likely to start the session on a stale demo reset
  // instant. Shares one request with the login page's own read (getSiteConfig).
  useEffect(() => {
    if (Date.now() - lastFetchRef.current < FRESH_MS && lastFetchRef.current !== 0) return;
    void fetchFlags();
  }, [signedIn, fetchFlags]);

  // Hosted demo (#1179): keep the next reset instant in sessionStorage while
  // signed in, so an auth failure after it can be recognized as the reset
  // (utils/demoReset.ts). Deliberately NOT cleared on sign-out: the 401
  // interceptor reads it just before that happens.
  useEffect(() => {
    if (!signedIn || !loaded) return;
    stashDemoNextReset(flags.demo_mode ? flags.demo_next_reset_at : null);
  }, [signedIn, loaded, flags]);

  useEffect(() => {
    // A write was rejected because the instance entered maintenance mode after
    // this session bootstrapped (#783). Patch the flags from the event instead
    // of re-fetching: the notice is already in the 503 body, and a refetch per
    // rejected write would land exactly when the server is least able to
    // absorb it.
    const handleMaintenanceBlocked = (event: Event) => {
      const { message } = (event as CustomEvent<{ message: string }>).detail ?? { message: "" };
      setFlags((current) =>
        current.maintenance_mode
          ? current
          : { ...current, maintenance_mode: true, maintenance_message: message },
      );
    };
    window.addEventListener("auth:maintenanceBlocked", handleMaintenanceBlocked);
    return () => window.removeEventListener("auth:maintenanceBlocked", handleMaintenanceBlocked);
  }, []);

  // The banner must also be able to go AWAY, and nothing pushes maintenance
  // state to an open tab, so refresh when the tab returns to the foreground.
  // Shares useVisibilityResync's 30s throttle. Skipped while signed out: the
  // login page does not render these flags and has its own site-config fetch.
  const signedInRef = useRef(false);
  useEffect(() => {
    signedInRef.current = signedIn;
  }, [signedIn]);
  const refresh = useCallback(() => {
    if (!signedInRef.current) return;
    void fetchFlags(true);
  }, [fetchFlags]);
  useVisibilityResync(refresh);

  return { flags, loaded };
}
