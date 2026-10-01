/**
 * Browser round trips to the backend's allauth provider views (#1314).
 *
 * These are real navigations, not API calls: the provider has to be visited.
 */

const API = import.meta.env.VITE_API_URL ?? "http://localhost:8000";

/**
 * allauth's login path for a provider. Generic OIDC apps live under
 * allauth's `oidc/` URL prefix *and* their own `provider_id` (Visiban's is
 * `oidc`), so the path is `/accounts/oidc/oidc/login/` — the same one the
 * callback URL in docs/administration/authentication.md is built on.
 */
export function providerLoginPath(provider: string): string {
  if (provider === "oidc") return "/accounts/oidc/oidc/login/";
  return `/accounts/${encodeURIComponent(provider)}/login/`;
}

/** Absolute URL that starts a sign-in with `provider`. */
export function providerLoginUrl(provider: string): string {
  return `${API}${providerLoginPath(provider)}?process=login`;
}

/**
 * Start connecting `provider` to the signed-in account.
 *
 * A POST with the CSRF token, never a GET link: connecting changes the
 * account, so it must not be triggerable by a cross-site link (the backend
 * never enables SOCIALACCOUNT_LOGIN_ON_GET). The backend returns the browser
 * to /settings with `?connected=` or `?connect_error=`.
 */
export function startProviderConnect(provider: string): void {
  const form = document.createElement("form");
  form.method = "POST";
  form.action = `${API}${providerLoginPath(provider)}?process=connect`;
  form.style.display = "none";
  const csrf = document.cookie.match(/(^| )csrftoken=([^;]+)/)?.[2];
  if (csrf) {
    const input = document.createElement("input");
    input.type = "hidden";
    input.name = "csrfmiddlewaretoken";
    input.value = csrf;
    form.appendChild(input);
  }
  document.body.appendChild(form);
  form.submit();
}
