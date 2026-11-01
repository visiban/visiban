import { getCurrentUser } from "../api/auth";

/**
 * Ask the server whether the current session is still valid (#2037).
 *
 * A WebSocket 4003 close is ambiguous: it means "authenticated but no access"
 * (lost one board, pending account change) and also "the credential this
 * socket connected with was revoked" (session expired, logout elsewhere,
 * password change). The close frame cannot tell them apart, a REST call can.
 *
 * This helper never dispatches anything itself. A dead session makes the
 * request 401, and the shared axios interceptor (api/client.ts) already emits
 * `auth:sessionExpired` for that, exactly as for any other REST call. A live
 * session, or any non-401 failure such as a network error, changes nothing:
 * we must not sign a user out because we could not reach the server.
 */
export async function probeSession(): Promise<void> {
  try {
    await getCurrentUser();
  } catch {
    /* 401 is handled by the interceptor; anything else is deliberately ignored */
  }
}
