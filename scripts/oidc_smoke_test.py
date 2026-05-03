#!/usr/bin/env python3
"""OIDC smoke test — exercises the full authorization code flow end-to-end.

Drives the login flow programmatically using requests.Session:
  1. Hits Visiban's OIDC login endpoint → redirected to IdP
  2. Follows the redirect to the IdP's login form
  3. Submits test credentials to the login form
  4. Follows the authorization code callback back to Visiban
  5. Asserts that GET /api/v1/auth/user/ returns the expected identity

This test catches issues with discovery endpoint parsing, token exchange,
scope/claim mapping, and callback URL routing that unit tests cannot reach
because they mock the IdP interaction entirely.

Usage (local dev):
    docker compose -f docker-compose.yml -f docker-compose.oidc.yml up -d
    python scripts/oidc_smoke_test.py

Usage (CI):
    python scripts/oidc_smoke_test.py \\
        --base-url http://localhost:8000 \\
        --username testuser \\
        --password testpassword \\
        --expected-email testuser@example.com
"""

import argparse
import html.parser
import sys
import time
import urllib.parse

import requests


class _FormParser(html.parser.HTMLParser):
    """Extract the first form's action URL and all input field values."""

    def __init__(self):
        super().__init__()
        self.action = None
        self.inputs = {}
        self._in_form = False

    def handle_starttag(self, tag, attrs):
        attrs_dict = dict(attrs)
        if tag == "form":
            if self.action is None and "action" in attrs_dict:
                self.action = attrs_dict["action"]
            self._in_form = True
        elif tag == "input" and self._in_form and attrs_dict.get("name"):
            self.inputs[attrs_dict["name"]] = attrs_dict.get("value", "")

    def handle_endtag(self, tag):
        if tag == "form":
            self._in_form = False


def _wait_for_url(url: str, timeout: int = 60) -> None:
    """Poll *url* until it returns a non-5xx status or *timeout* seconds elapse."""
    deadline = time.monotonic() + timeout
    attempt = 0
    while time.monotonic() < deadline:
        try:
            r = requests.get(url, timeout=5)
            if r.status_code < 500:
                return
        except Exception:
            pass
        attempt += 1
        print(f"  Waiting for {url} … ({attempt})", flush=True)
        time.sleep(3)
    raise RuntimeError(f"Service at {url} did not become ready within {timeout}s")


def run_smoke_test(
    base_url: str,
    username: str,
    password: str,
    expected_email: str,
    verify_ssl: bool = True,
) -> None:
    print(f"Running OIDC smoke test against {base_url}")

    # Wait for the backend to be ready
    _wait_for_url(f"{base_url}/api/health/liveness/", timeout=60)

    session = requests.Session()
    session.verify = verify_ssl
    if not verify_ssl:
        requests.packages.urllib3.disable_warnings()

    # ── Step 1: Hit Visiban's OIDC login endpoint ──────────────────────────────
    # allauth's default SOCIALACCOUNT_LOGIN_ON_GET = False renders a confirmation
    # page (200) on GET before redirecting to the IdP.  We handle this by reading
    # the CSRF token from the cookie and POSTing to the same URL to proceed.
    login_url = f"{base_url}/accounts/oidc/oidc/login/"
    r = session.get(login_url, allow_redirects=False)

    if r.status_code == 200:
        # Confirmation page — extract CSRF token and POST to continue
        csrf_token = (
            session.cookies.get("csrftoken")
            or r.cookies.get("csrftoken")
        )
        if not csrf_token:
            # Fall back to parsing the form for csrfmiddlewaretoken
            csrf_parser = _FormParser()
            csrf_parser.feed(r.text)
            csrf_token = csrf_parser.inputs.get("csrfmiddlewaretoken", "")
        r = session.post(
            login_url,
            data={"csrfmiddlewaretoken": csrf_token},
            headers={"Referer": login_url},
            allow_redirects=False,
        )

    if r.status_code not in (301, 302):
        raise AssertionError(
            f"Expected a redirect from the OIDC login endpoint; got {r.status_code}.\n"
            "Is OIDC configured? (OIDC_CLIENT_ID, OIDC_CLIENT_SECRET, OIDC_SERVER_URL)\n"
            f"Response body (first 300 chars): {r.text[:300]}"
        )
    idp_auth_url = r.headers["Location"]
    parsed = urllib.parse.urlparse(idp_auth_url)
    print(f"  ✓ Visiban redirected to IdP at {parsed.scheme}://{parsed.netloc}")

    # ── Step 2: Fetch the IdP login form ──────────────────────────────────────
    r = session.get(idp_auth_url)
    if r.status_code != 200:
        raise AssertionError(
            f"IdP login form returned {r.status_code} — "
            f"is the server URL reachable and the realm configured?"
        )
    parser = _FormParser()
    parser.feed(r.text)
    if not parser.action:
        raise AssertionError(
            "Could not find a <form action=...> in the IdP login page. "
            "The IdP may have returned an error page instead of the login form."
        )
    print("  ✓ Received IdP login form")

    # ── Step 3: Submit credentials ─────────────────────────────────────────────
    # The login page is served by Keycloak and the form posts back to Keycloak —
    # a same-origin navigation in browser terms.  Browsers do not send an Origin
    # header for same-origin navigations, and Keycloak 24 validates Origin against
    # the client's registered webOrigins when the header is present.  Sending
    # Origin: http://keycloak:8080 triggers that check and results in a 400 because
    # the Docker-internal hostname is not in webOrigins.  We omit Origin entirely
    # and send Referer instead, which is what a real browser would do.
    #
    # Keycloak sets AUTH_SESSION_ID with domain "keycloak.local" (Keycloak's default
    # internal domain).  Python's http.cookiejar RFC 2965 domain-matching refuses to
    # send a "keycloak.local" cookie to the host "keycloak" (no TLD match), causing
    # a 400 from Keycloak.  Passing the cookies as a plain dict forces requests to
    # create them with domain="" (no restriction), bypassing the domain check.
    login_page_url = r.url  # final URL after any Keycloak-internal redirects
    payload = dict(parser.inputs)
    payload["username"] = username
    payload["password"] = password
    kc_cookie_names = {"AUTH_SESSION_ID", "AUTH_SESSION_ID_LEGACY", "KC_RESTART"}
    kc_cookies = {c.name: c.value for c in session.cookies if c.name in kc_cookie_names}
    print(f"  Submitting to form action: {parser.action}")
    print(f"  Keycloak session cookies forwarded: {list(kc_cookies)}")
    r = session.post(
        parser.action,
        data=payload,
        cookies=kc_cookies,  # dict cookies bypass http.cookiejar domain matching
        headers={"Referer": login_page_url},
        allow_redirects=False,
    )
    if r.status_code not in (301, 302):
        raise AssertionError(
            f"Credential submission returned {r.status_code} — "
            "login may have failed (wrong username/password, or IdP rejected the client).\n"
            f"Response body (first 500 chars): {r.text[:500]}"
        )
    callback_url = r.headers["Location"]
    print("  ✓ IdP accepted credentials; got callback redirect")

    # ── Step 4: Follow the callback to Visiban ─────────────────────────────────
    # Visiban processes the authorization code, logs the user in, then redirects
    # to FRONTEND_URL (LOGIN_REDIRECT_URL).  We follow all redirects but do not
    # fail if the final destination is unreachable (frontend may not be running).
    try:
        r = session.get(callback_url, allow_redirects=True, timeout=15)
    except requests.exceptions.ConnectionError as exc:
        # Connection error on the final frontend redirect is expected in CI.
        # The session cookie is already set by Visiban before this redirect fires.
        print(f"  ✓ Callback processed (final redirect to frontend not followed: {exc})")
    else:
        if r.status_code >= 500:
            raise AssertionError(
                f"Visiban returned {r.status_code} processing the callback: {r.text[:300]}"
            )
        print(f"  ✓ Callback processed (HTTP {r.status_code})")

    # ── Step 5: Verify the authenticated identity ──────────────────────────────
    r = session.get(f"{base_url}/api/v1/auth/user/", timeout=10)
    if r.status_code != 200:
        raise AssertionError(
            f"/api/v1/auth/user/ returned {r.status_code}. "
            "The session cookie may not have been set — check the callback URL "
            "registration in the IdP matches the Visiban backend URL exactly."
        )
    user_data = r.json()
    actual_email = user_data.get("email", "")
    if actual_email != expected_email:
        raise AssertionError(
            f"Expected email {expected_email!r}; got {actual_email!r}. "
            "Check that the test user in the IdP has the correct email address."
        )
    print(f"  ✓ Identity verified: {actual_email}")
    print("OIDC smoke test PASSED.")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--base-url",
        default="http://localhost:8000",
        help="Base URL of the Visiban backend (default: http://localhost:8000)",
    )
    parser.add_argument(
        "--username",
        default="testuser",
        help="OIDC test user username (default: testuser)",
    )
    parser.add_argument(
        "--password",
        default="testpassword",
        help="OIDC test user password (default: testpassword)",
    )
    parser.add_argument(
        "--expected-email",
        default="testuser@example.com",
        help="Expected email address after login (default: testuser@example.com)",
    )
    parser.add_argument(
        "--no-verify",
        action="store_true",
        default=False,
        help="Disable SSL certificate verification (use only with HTTP or self-signed certs)",
    )
    args = parser.parse_args()

    try:
        run_smoke_test(
            base_url=args.base_url.rstrip("/"),
            username=args.username,
            password=args.password,
            expected_email=args.expected_email,
            verify_ssl=not args.no_verify,
        )
    except (AssertionError, RuntimeError) as exc:
        print(f"\nFAIL: {exc}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
