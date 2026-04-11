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
import json
import sys
import time

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
            "username": "admin",
            "password": "admin",
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


def _wait_for_keycloak(base_url: str, timeout: int = 120) -> None:
    url = f"{base_url}/realms/master/.well-known/openid-configuration"
    deadline = time.monotonic() + timeout
    attempt = 0
    while time.monotonic() < deadline:
        try:
            r = requests.get(url, timeout=5)
            if r.status_code == 200:
                print(f"  Keycloak is ready (attempt {attempt + 1}).")
                return
        except Exception:
            pass
        attempt += 1
        print(f"  Waiting for Keycloak... ({attempt})", flush=True)
        time.sleep(5)
    raise RuntimeError(f"Keycloak at {base_url} did not become ready within {timeout}s")


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
    # Token may expire during long waits — re-fetch after realm creation
    token = _get_admin_token(base_url)
    _create_client(base_url, token)
    _create_user(base_url, token)

    print("Provisioning complete.")


if __name__ == "__main__":
    main()
