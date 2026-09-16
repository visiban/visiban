import axios from "axios";

const client = axios.create({
  baseURL: import.meta.env.VITE_API_URL ?? "http://localhost:8000",
  withCredentials: true,
  headers: { "Content-Type": "application/json" },
});

client.interceptors.request.use((config) => {
  const match = document.cookie.match(/(^| )csrftoken=([^;]+)/);
  const csrfToken = match ? match[2] : null;
  if (csrfToken) config.headers["X-CSRFToken"] = csrfToken;
  if (config.data instanceof FormData) {
    delete config.headers["Content-Type"];
  }
  return config;
});

// When the backend signals that credentials are no longer valid, emit an event
// so that useAuth can clear the user and redirect to the login page.
// DRF returns 401 (NotAuthenticated) when no authenticator succeeds; a stale
// session after a password change is the most common real-world trigger.
/** Detail carried by the `auth:maintenanceBlocked` event (#783). */
export interface MaintenanceBlockedDetail {
  /** The operator's notice. Always non-empty — the server substitutes its own
   *  default for a blank message — so consumers need no fallback string. */
  message: string;
}

client.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response?.status === 401) {
      window.dispatchEvent(new Event("auth:sessionExpired"));
    }
    // The instance went into maintenance mode (#783) after this session
    // bootstrapped, so the cached current-user object still says it is off and
    // no banner is showing. Announce it here — the one place every write
    // funnels through — rather than teaching each caller to recognize a 503, so
    // a write rejected mid-session explains itself instead of silently rolling
    // back. Mirrors the auth:sessionExpired convention above.
    //
    // Matched on the `maintenance_mode` code and not on the 503 status alone:
    // a proxy or a genuinely overloaded backend also returns 503, and showing a
    // maintenance banner for those would be a lie.
    if (
      error.response?.status === 503 &&
      (error.response?.data as { code?: string } | undefined)?.code === "maintenance_mode"
    ) {
      const data = error.response.data as { detail?: string };
      window.dispatchEvent(
        new CustomEvent<MaintenanceBlockedDetail>("auth:maintenanceBlocked", {
          detail: { message: data?.detail ?? "" },
        }),
      );
    }
    return Promise.reject(error);
  },
);

export default client;
