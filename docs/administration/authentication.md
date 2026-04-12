# Authentication

Visiban supports several authentication methods. Some are available in the OSS edition; others require the enterprise edition.

| Method | OSS | Enterprise |
|---|---|---|
| Username and password | Yes | — |
| Google OAuth | Yes | — |
| GitHub OAuth | Yes | — |
| GitLab OAuth | Yes | — |
| Generic OIDC | Yes | — |
| SAML 2.0 / ADFS | — | Yes |
| SCIM directory sync / JIT provisioning | — | Yes |

## Forgot password (self-service password reset)

Users with a password-based account can reset their own password from the login page without administrator intervention.

1. The user clicks **Forgot password?** on the login page and enters their email address.
2. Visiban sends a reset link to the address. The link expires after 3 days (Django's default `PASSWORD_RESET_TIMEOUT`).
3. The user clicks the link, sets a new password (minimum 12 characters), and is redirected to the login page.

**OAuth-only accounts** — if the email belongs to an account that has never set a password (signed up via Google, GitHub, GitLab, or OIDC and never used "Change password"), Visiban sends an alternate email explaining that no password is set and directing the user to log in via their OAuth provider. No reset token is issued.

**Rate limiting** — the reset-request endpoint (`POST /api/v1/auth/password/reset/`) is rate-limited per IP to prevent it from being used as a bulk email-sending vector.

**SMTP requirement** — password reset emails require outbound email to be configured. See `EMAIL_HOST` and related settings in [Configuration](configuration.md). If email is not configured, reset emails are silently dropped (no error is shown to the user). In that case, administrators can reset passwords manually:

```bash
docker compose exec backend python manage.py changepassword <username>
```

For API details, see [Authentication API — Forgot password](../api/authentication.md#forgot-password).

## OAuth (Google, GitHub, GitLab)

See the [OAuth Setup](../getting-started/oauth.md) guide for step-by-step configuration of each provider.

## Generic OIDC <span style="background:#dbeafe;color:#1d4ed8;font-size:11px;font-weight:700;padding:2px 8px;border-radius:10px;vertical-align:middle;letter-spacing:0.3px;">BETA</span>

!!! info "Beta — validated against Keycloak; community feedback needed for other providers"
    The end-to-end login flow is validated automatically in CI against a real Keycloak instance via the `oidc-smoke` job (`docker-compose.oidc.yml`). **Other providers — Okta, Authentik, Dex, and others — have not been tested.** You may encounter issues with token exchange, scope mapping, or callback handling specific to your IdP.

    If you test this against a non-Keycloak provider, please report findings on [issue #349](https://gitlab.com/visiban/visiban/-/issues/349).

!!! note "Keycloak default port"
    Keycloak's default HTTP port is **8080**. Visiban's backend also defaults to port **8000** in the development Docker Compose setup — there is no conflict. When running the local OIDC dev stack (`docker compose -f docker-compose.yml -f docker-compose.oidc.yml up`), Keycloak is available at `http://localhost:8080` and the app at `http://localhost:5173` (frontend) / `http://localhost:8000` (API).

Generic OIDC is available in the OSS edition via `allauth.socialaccount.providers.openid_connect`, which is already included in the `django-allauth` dependency. No additional packages are required.

The end-to-end login flow is validated automatically in CI against a real Keycloak instance via the `oidc-smoke` job. See `docker-compose.oidc.yml` for local development with Keycloak.

Use this when your identity provider supports standard OIDC but is not one of the pre-configured providers (Google, GitHub, GitLab). Common examples: Keycloak, Authentik, Dex, Okta, and any other OIDC-compliant IdP.

### Configuration via environment variables (recommended)

Set all three of the following environment variables. The provider is only registered when all three are present — leaving any one blank disables OIDC entirely, preventing startup errors from partial configuration.

| Variable | Required | Description |
|---|---|---|
| `OIDC_CLIENT_ID` | Yes | OAuth 2.0 client ID issued by your IdP |
| `OIDC_CLIENT_SECRET` | Yes | OAuth 2.0 client secret issued by your IdP |
| `OIDC_SERVER_URL` | Yes | Issuer URL of your IdP — see note below |
| `OIDC_PROVIDER_NAME` | No | Label shown on the login button (default: `SSO`) |

!!! note "Deprecated alias"
    `OIDC_SECRET` is a deprecated alias for `OIDC_CLIENT_SECRET`, kept for one release cycle. Rename it to `OIDC_CLIENT_SECRET` when you next update your environment. The alias will be removed in 1.1.

**Example** (`docker-compose.yml` or `.env`):

```env
OIDC_CLIENT_ID=visiban
OIDC_CLIENT_SECRET=my-client-secret
OIDC_SERVER_URL=https://sso.example.com/realms/my-realm
OIDC_PROVIDER_NAME=Keycloak
```

!!! note "`OIDC_SERVER_URL` format"
    Set `OIDC_SERVER_URL` to the **issuer URL** — the base URL of your realm or tenant, **without** the `/.well-known/openid-configuration` path. Visiban appends that path automatically.

    | IdP | Example `OIDC_SERVER_URL` |
    |---|---|
    | Keycloak | `https://sso.example.com/realms/my-realm` |
    | Authentik | `https://sso.example.com/application/o/my-app` |
    | Okta | `https://dev-12345.okta.com/oauth2/default` |
    | Dex | `https://dex.example.com` |
    | Google (OIDC) | `https://accounts.google.com` |

The callback URL to register with your IdP:

```
https://<your-domain>/accounts/oidc/oidc/login/callback/
```

!!! note "Why does the URL contain `oidc` twice?"
    The path has two separate `oidc` segments with different meanings:

    ```
    /accounts / oidc / oidc / login/callback/
       │          │      │
       │          │      └─ provider_id — the slug assigned to this OIDC app.
       │          │         Visiban's env-var configuration defaults this to "oidc".
       │          │
       │          └─ allauth's OPENID_CONNECT_URL_PREFIX — a fixed namespace
       │             for all openid_connect providers (default value: "oidc").
       │
       └─ allauth's base URL prefix — all allauth routes live under /accounts/.
    ```

    The `oidc/oidc/` pattern is correct and expected for the default configuration.
    It is not a misconfiguration. Keycloak, Okta, Authentik, and Dex all accept
    this URL without issue.

    If you configure a custom `provider_id` (e.g. `keycloak`) via the Django admin,
    the callback URL becomes:
    `https://<your-domain>/accounts/oidc/keycloak/login/callback/`

### Multi-provider support

The env-var approach configures a single OIDC provider. If you need multiple OIDC providers simultaneously (for example, separate realms for staff and contractors), configure additional providers through the Django admin at `/admin/socialaccount/socialapp/` with provider type `openid_connect`. Each additional provider requires a unique **Provider ID** slug, and its callback URL follows the pattern in the note above.

### OAuth/OIDC with invite-only registration

When the instance is set to **invite-only** registration mode (Settings > Registration), users who receive an invite link can register using any configured OAuth or OIDC provider — not just email and password. The invite token is passed through the OAuth flow automatically.

Existing users can log in via OAuth regardless of the registration mode setting. The registration mode controls who may **join**; the authentication method controls how they **prove identity**. These are independent.

### Disabling password login when OIDC is active

Setting OIDC env vars makes the OIDC login button appear alongside existing username/password and OAuth options — it does not disable them. A future release will add an admin toggle to disable password authentication entirely when SSO is configured. Until then, you can enforce OIDC-only access at the IdP level by issuing credentials only to users who should have access.

## SAML 2.0 / ADFS

> **Visiban Enterprise** — This feature is available in [Visiban Enterprise](https://visiban.com/enterprise).

SAML 2.0 and ADFS authentication are available in the enterprise edition. They require a separate library and are configured through the enterprise settings. Contact your Visiban Enterprise account team for setup instructions.

## SCIM directory sync / JIT provisioning

> **Visiban Enterprise** — This feature is available in [Visiban Enterprise](https://visiban.com/enterprise).

SCIM 2.0 directory sync (automatic user provisioning and deprovisioning from your IdP) and just-in-time (JIT) account creation on first login are enterprise features. They are intended for organizations with centralized identity management at scale. For smaller teams, manual user invitation via invite links covers the same onboarding workflow in the OSS edition.

## Classification rationale

For the reasoning behind the OSS vs enterprise boundary for these authentication methods, see the [Open-Core Boundary](../architecture/open-core-boundary.md#oidc-authentication-oss-vs-saml-enterprise) reference page.
