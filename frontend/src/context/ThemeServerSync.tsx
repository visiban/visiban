import { useEffect, useRef } from "react";

import { updateCurrentUser } from "../api/auth";
import type { User } from "../types";
import { STORAGE_KEY, useTheme } from "./ThemeContext";

/**
 * Bridges the per-browser ThemeContext (localStorage-backed) with the
 * authenticated user's server-side theme preference.
 *
 * Precedence rules — deliberately designed to avoid clobbering an existing
 * user's locally chosen preference on first load after the #183 upgrade:
 *
 *  1. First authenticated load after upgrade: a sentinel ("visiban-theme-synced")
 *     is absent. If the local preference differs from the server value we PATCH
 *     the server with the local value, then set the sentinel. Rationale: users
 *     already have a deliberate localStorage choice that predates the server
 *     field. Ignoring it would silently overwrite their setting with the default.
 *
 *  2. Subsequent loads (sentinel present): the server is authoritative. If its
 *     value differs from the local mirror, we update localStorage (which the
 *     storage-event listener in other tabs picks up) and the context state.
 *
 *  3. On every in-session change via setPreference, we PATCH the server so the
 *     choice propagates to other devices. Write-on-change is acceptable — theme
 *     changes are extremely infrequent and the request is a single-field PATCH.
 */
const SYNC_SENTINEL_KEY = "visiban-theme-synced";

export function ThemeServerSync({
  user,
  onUserUpdated,
}: {
  user: User;
  onUserUpdated: (u: User) => void;
}) {
  const { preference, setPreference } = useTheme();
  // Track the last value we PATCHed (or observed as sync'd) so the in-session
  // branch below does not fire a spurious or duplicate PATCH. Seeded to the
  // initial preference on first render so the first commit is a no-op unless
  // the initial-sync branch explicitly decided to push a value.
  const lastServerPushRef = useRef<string | null>(preference);
  const didInitialSyncRef = useRef(false);

  // Single effect — combines initial sync (first run) and in-session propagation
  // (subsequent runs on preference change). Collapsing into one effect ensures
  // we never trigger the in-session PATCH on the same commit as the initial
  // sync, which was racy: both effects saw the pre-setPreference value.
  useEffect(() => {
    if (!didInitialSyncRef.current) {
      didInitialSyncRef.current = true;

      const serverTheme = user.theme ?? "system";
      const localTheme =
        (localStorage.getItem(STORAGE_KEY) as typeof preference | null) ?? "system";
      const sentinel = localStorage.getItem(SYNC_SENTINEL_KEY);

      if (!sentinel) {
        // First load after upgrade. Local choice wins — push it to the server.
        localStorage.setItem(SYNC_SENTINEL_KEY, "1");
        if (localTheme !== serverTheme) {
          lastServerPushRef.current = localTheme;
          updateCurrentUser({ theme: localTheme })
            .then((updated) => onUserUpdated(updated))
            .catch(() => {
              // Non-fatal: the local theme still applies; retry on next change.
            });
        }
        return;
      }

      // Subsequent loads: server wins.
      if (serverTheme !== localTheme) {
        lastServerPushRef.current = serverTheme;
        setPreference(serverTheme);
      }
      return;
    }

    // In-session change via setPreference — propagate to the server.
    if (lastServerPushRef.current === preference) return;
    lastServerPushRef.current = preference;
    updateCurrentUser({ theme: preference })
      .then((updated) => onUserUpdated(updated))
      .catch(() => {
        // Swallow — the preference still applies locally. A retry will happen
        // the next time the user changes the setting.
      });
    // user and setPreference are intentionally stable across renders — user
    // changes would re-fire a full sync that the current design does not cover.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preference, onUserUpdated]);

  return null;
}
