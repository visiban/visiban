#!/usr/bin/env python3
"""Provision Keycloak with the visiban-test realm for CI smoke tests.

This script is used by the oidc-smoke CI job to seed Keycloak with the
realm, client, and test user needed by the smoke test.  It calls the
Keycloak Admin REST API directly so no file mounts into the container are
required.

Usage:
    python scripts/oidc_provision.py --keycloak-url http://keycloak:8080

The script is idempotent: it skips creation steps when the resource already
exists, so it is safe to re-run.
"""

import argparse
import os
import socket
import time
from urllib.parse import urlparse

import requests

REALM = "visiban-test"
CLIENT_ID = "visiban"
CLIENT_SECRET = "test-oidc-secret"
TEST_USER = "testuser"
TEST_USER_EMAIL = "testuser@example.com"
TEST_PASSWORD = "testpassword"

REDIRECT_URIS = [
    "http://localhost:8000/accounts/oidc/oidc/login/callback/",
    "http://127.0.0.1:8000/accounts/oidc/oidc/login/callback/",
]


def _get_admin_token(base_url: str) -> str:
    r = requests.post(
        f"{base_url}/realms/master/protocol/openid-connect/token",
        data={
            "client_id": "admin-cli",
            "grant_type": "password",
            "username": os.environ.get("KEYCLOAK_ADMIN_USER", "admin"),
            "password": os.environ.get("KEYCLOAK_ADMIN_PASSWORD", "admin"),
        },
        timeout=15,
    )
    r.raise_for_status()
    return r.json()["access_token"]


def _headers(token: str) -> dict:
    return {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}


def _create_realm(base_url: str, token: str) -> None:
    r = requests.get(
        f"{base_url}/admin/realms/{REALM}",
        headers=_headers(token),
        timeout=10,
    )
    if r.status_code == 200:
        print(f"  Realm '{REALM}' already exists — skipping.")
        return

    payload = {
        "realm": REALM,
        "displayName": "Visiban Test Realm",
        "enabled": True,
        "loginWithEmailAllowed": True,
        "duplicateEmailsAllowed": False,
    }
    r = requests.post(
        f"{base_url}/admin/realms",
        headers=_headers(token),
        json=payload,
        timeout=10,
    )
    r.raise_for_status()
    print(f"  Created realm '{REALM}'.")


def _create_client(base_url: str, token: str) -> None:
    r = requests.get(
        f"{base_url}/admin/realms/{REALM}/clients",
        headers=_headers(token),
        params={"clientId": CLIENT_ID},
        timeout=10,
    )
    r.raise_for_status()
    existing = r.json()
    if existing:
        print(f"  Client '{CLIENT_ID}' already exists — skipping.")
        return

    payload = {
        "clientId": CLIENT_ID,
        "name": "Visiban",
        "secret": CLIENT_SECRET,
        "enabled": True,
        "publicClient": False,
        "standardFlowEnabled": True,
        "directAccessGrantsEnabled": True,
        "protocol": "openid-connect",
        "redirectUris": REDIRECT_URIS,
        "webOrigins": ["http://localhost:8000", "http://localhost:5173"],
        "defaultClientScopes": ["openid", "profile", "email"],
    }
    r = requests.post(
        f"{base_url}/admin/realms/{REALM}/clients",
        headers=_headers(token),
        json=payload,
        timeout=10,
    )
    r.raise_for_status()
    print(f"  Created client '{CLIENT_ID}'.")


def _create_user(base_url: str, token: str) -> None:
    r = requests.get(
        f"{base_url}/admin/realms/{REALM}/users",
        headers=_headers(token),
        params={"username": TEST_USER},
        timeout=10,
    )
    r.raise_for_status()
    existing = r.json()
    if existing:
        print(f"  User '{TEST_USER}' already exists — skipping.")
        return

    user_payload = {
        "username": TEST_USER,
        "email": TEST_USER_EMAIL,
        "firstName": "Test",
        "lastName": "User",
        "enabled": True,
        "emailVerified": True,
        "credentials": [
            {"type": "password", "value": TEST_PASSWORD, "temporary": False}
        ],
    }
    r = requests.post(
        f"{base_url}/admin/realms/{REALM}/users",
        headers=_headers(token),
        json=user_payload,
        timeout=10,
    )
    r.raise_for_status()
    print(f"  Created user '{TEST_USER}' ({TEST_USER_EMAIL}).")


def _preflight(url: str) -> None:
    """Log DNS and TCP reachability for *url* before polling it.

    A readiness loop that only reports "not ready yet" cannot distinguish an
    unresolvable host from a service that is still booting, and the two have
    completely different fixes.  Emitting this once up front means a failure is
    diagnosable from the job log alone.
    """
    parsed = urlparse(url)
    host = parsed.hostname or ""
    port = parsed.port or (443 if parsed.scheme == "https" else 80)

    try:
        addrs = sorted({ai[4][0] for ai in socket.getaddrinfo(host, port)})
        print(f"  preflight: {host} resolves to {', '.join(addrs)}")
    except OSError as exc:
        print(f"  preflight: {host} does NOT resolve ({exc})")
        return

    try:
        with socket.create_connection((host, port), timeout=5):
            print(f"  preflight: TCP connect to {host}:{port} succeeded")
    except OSError as exc:
        print(f"  preflight: TCP connect to {host}:{port} failed ({exc})")


def _wait_for_url(url: str, label: str, timeout: int = 60) -> None:
    """Poll *url* until it returns HTTP 200, or raise RuntimeError after *timeout*."""
    _preflight(url)

    deadline = time.monotonic() + timeout
    attempt = 0
    last_error = "no attempt completed"
    reported: set[str] = set()
    while time.monotonic() < deadline:
        try:
            r = requests.get(url, timeout=5)
            if r.status_code == 200:
                print(f"  {label} is ready (attempt {attempt + 1}).")
                return
            last_error = f"HTTP {r.status_code}"
        except Exception as exc:
            # Keep the reason: swallowing it here is what made a 240s timeout
            # in CI indistinguishable from a DNS failure, a refused connection
            # and a slow boot.
            last_error = f"{type(exc).__name__}: {exc}"
        attempt += 1
        # Per-attempt lines stay short so a long wait does not bury the log;
        # each distinct error is spelled out in full the first time it is seen.
        short = last_error.split("(")[0].strip().rstrip(":")
        print(f"  Waiting for {label}... ({attempt}: {short})", flush=True)
        if last_error not in reported:
            reported.add(last_error)
            print(f"    ↳ {last_error}", flush=True)
        time.sleep(5)
    raise RuntimeError(
        f"{label} at {url} did not become ready within {timeout}s "
        f"(last error: {last_error})"
    )


def _wait_for_keycloak(base_url: str, timeout: int = 120) -> None:
    _wait_for_url(
        f"{base_url}/realms/master/.well-known/openid-configuration",
        "Keycloak master realm",
        timeout=timeout,
    )


def _wait_for_realm(base_url: str, timeout: int = 30) -> None:
    """Wait for the provisioned realm's discovery endpoint to become accessible."""
    _wait_for_url(
        f"{base_url}/realms/{REALM}/.well-known/openid-configuration",
        f"Keycloak realm '{REALM}' discovery",
        timeout=timeout,
    )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--keycloak-url",
        default="http://keycloak:8080",
        help="Base URL of the Keycloak instance (default: http://keycloak:8080)",
    )
    parser.add_argument(
        "--wait-timeout",
        type=int,
        default=120,
        help="Seconds to wait for Keycloak to become ready (default: 120)",
    )
    args = parser.parse_args()
    base_url = args.keycloak_url.rstrip("/")

    print(f"Provisioning Keycloak at {base_url} …")

    _wait_for_keycloak(base_url, timeout=args.wait_timeout)

    token = _get_admin_token(base_url)
    _create_realm(base_url, token)
    # Wait for the realm to be accessible at its own discovery endpoint before
    # provisioning the client.  The Admin API realm creation is synchronous, but
    # Keycloak's HTTP routing for new realms can take a few extra seconds to
    # become active.  Django's settings are loaded at startup, so the backend
    # process must be able to reach the realm discovery URL when it boots.
    _wait_for_realm(base_url)
    # Token may expire during long waits — re-fetch after realm creation
    token = _get_admin_token(base_url)
    _create_client(base_url, token)
    _create_user(base_url, token)

    print("Provisioning complete.")


if __name__ == "__main__":
    main()
