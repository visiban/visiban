Add OIDC end-to-end smoke test and clarify callback URL slug (#725, #726).

- `docker-compose.oidc.yml`: new Docker Compose overlay that spins up Keycloak 24
  with the `visiban-test` realm, client, and test user for local OIDC development.
- `oidc/keycloak-realm.json`: pre-seeded realm config for `--import-realm` import.
- `scripts/oidc_provision.py`: idempotent Keycloak provisioning via Admin REST API
  (used by the CI smoke test job, no file mounts required).
- `scripts/oidc_smoke_test.py`: drives the full authorization code flow using
  `requests.Session` — discovery, login form, code exchange, callback, identity check.
- CI job `oidc-smoke`: runs the smoke test in every pipeline against a real Keycloak
  service; removes the Tech Preview limitation.
- `docs/administration/authentication.md`: removed Tech Preview warning, added
  explanation of the `oidc/oidc` double-slug in the callback URL (first segment is
  allauth's `OPENID_CONNECT_URL_PREFIX`; second is the `provider_id`).
