# Pick how your users sign in

Visiban signs users in with a password, Google, GitHub, GitLab, or any OIDC provider out of the box. SAML and SCIM need the enterprise edition.

**Why it matters:** The sign-in method decides who can reach your instance and how they recover access. Password, OAuth, and OIDC users share one password policy and one reset flow.

**The big picture:** Some methods are available in the OSS edition; others require the enterprise edition.

| Method | OSS | Enterprise |
|---|---|---|
| Username and password | Yes | — |
| Google OAuth | Yes | — |
| GitHub OAuth | Yes | — |
| GitLab OAuth | Yes | — |
| Generic OIDC | Yes | — |
| SAML 2.0 / ADFS | — | Yes |
| SCIM directory sync / JIT provisioning | — | Yes |

## Password policy

Every password must be at least **12 characters** long and pass Django's standard checks:

- not too similar to the user's username, email, or name
- not a commonly used password
- not entirely numeric

**Where it applies:** every path that sets a password:

- registration and invite-link sign-up
- the password-reset link
- both change-password API endpoints
- admin-created accounts
- the Django admin
- the interactive `createsuperuser` / `changepassword` management commands (`createsuperuser` still offers its own "bypass validation" prompt)

Creating an account with `createsuperuser` and a password, or through the admin users API, is recorded in the [admin action log](../api/admin.md).

**Yes, but:** the policy is checked only when a password is set. Accounts created before 1.2, when some of these paths accepted 8 characters, keep working and are asked for a 12-character password the next time they change it.

**What a password change does:** changing a password, through either `POST /api/v1/auth/change-password/` or `POST /api/v1/auth/password/change/`:

- requires the current password (except for OAuth-only accounts setting their first one, which needs an interactive session: a request authenticated with a token alone is refused)
- revokes all of the user's [personal access tokens](../features/personal-access-tokens.md) and the API token issued at login (a caller that authenticated with that token receives a replacement in the response; see [API token on password change](../api/authentication.md#api-token-on-password-change))
- clears a pending "must change password" flag set by an administrator
- leaves the browser session signed in

## Forgot password (self-service password reset)

Users with a password-based account can reset their own password from the login page, with no administrator needed.

1. The user clicks **Forgot password?** on the login page and enters their email address.
2. Visiban sends a reset link to the address. The link expires after 3 days (Django's default `PASSWORD_RESET_TIMEOUT`).
3. The user clicks the link, sets a new password (minimum 12 characters), and is redirected to the login page.

**OAuth-only accounts** — if the email belongs to an account that has never set a password (signed up via Google, GitHub, GitLab, or OIDC and never used "Change password"):

- If the address is **verified** on that account, Visiban sends a normal reset link, and following it sets the account's first password. This is the recovery path for someone who can no longer sign in with the provider they signed up with. *Changed in 1.2 (#1314)* — earlier versions never issued a link to these accounts.
    - The link is tied to the address it was sent to. If that address is unverified or removed before the link is used, the link is refused, even if another address on the account is still verified (*1.2, #1337*).
    - Any change to which of the account's addresses are verified voids its outstanding links, so the user requests a new one.
- If the address was never verified, Visiban sends an alternate email saying no password is set and directing the user to sign in with their provider. No reset token is issued, because mail reaching an unverified address proves nothing about who owns the account.

**Older reset links and allauth's pages** — *Changed in 1.2 (#1554).* The server-rendered password-reset pages under `/accounts/password/reset/` (request, done, link, and link-done) now redirect to the app's `/forgot-password` page, so password reset has one implementation.

- A reset link already in an inbox (`/accounts/password/reset/key/<uid>-<key>/`) redirects to the app's reset page with the same uid and key and works until it expires.
- A malformed link under `/accounts/password/reset/key/` redirects to `/forgot-password`.
- The other pages under `/accounts/` stay mounted on purpose: `login/`, `login/code/confirm/`, `logout/`, `inactive/` and `reauthenticate/` (sign-in, sign-out and the inactive-account flow), `signup/`, `email/` and `confirm-email/` (project overrides or redirects to the app), and the social pages (`3rdparty/*`, its `social/*` aliases, and each configured provider's login and callback routes), which SSO needs.

Nothing changes for SSO sign-in or the reset email sent from the app.

**Rate limiting:** the reset-request endpoint (`POST /api/v1/auth/password/reset/`) is rate-limited per IP, so it can't be used as a bulk email-sending vector.

**Watch out: SMTP requirement.** Password reset emails require outbound email to be configured. See `EMAIL_HOST` and related settings in [Configuration](configuration.md). If email is not configured, reset emails are silently dropped (no error is shown to the user). In that case, administrators can reset passwords manually:

```bash
docker compose exec backend python manage.py changepassword <username>
```

This revokes the account's personal access tokens and API auth token, so credentials issued under the old password stop working. It does not change whether the account must choose a new password.

For API details, see [Authentication API — Forgot password](../api/authentication.md#forgot-password).

## OAuth (Google, GitHub, GitLab)

See the [OAuth Setup](../getting-started/oauth.md) guide for step-by-step configuration of each provider.

### Connected accounts and email collisions

> **Added in 1.2** (#1314)

Visiban never attaches a provider to an existing account just because the emails match, because a provider can report an address it never verified. Instead:

- **Someone signs in with a provider whose email already belongs to an account.** The login page says "You already have a Visiban account" and asks them to sign in the usual way: with their password, or, when the provider verified the email and the account has no password, with the provider the account already uses ("Continue with GitHub"). Once signed in, a one-time **Connect {Provider}?** prompt offers to connect the provider they first tried.
    - The prompt names the provider account that tried (for example its GitHub username), so someone on a shared computer who doesn't recognize it can decline.
    - The offer lasts 10 minutes and is shown once; **Not now** dismisses it for good. It is discarded if anyone else signs in on that browser, or on sign-out.
    - **Connect** only connects the same provider account that tried to sign in. If a different account of that provider is signed in on the browser, nothing is connected.
- **The matching account is deactivated.** The user sees the generic sign-in error; the account is never revealed or offered.
- **Email matching** ignores case only. `alice+work@example.com` and `a.lice@gmail.com` are treated as different addresses from `alice@example.com` and `alice@gmail.com`.

Users manage providers in **Settings → Security → Connected accounts**: connect any provider configured on the instance, or disconnect one. Nobody can remove their last way to sign in (a user without a password must keep at least one connected provider), and a provider already connected to a different Visiban account can't be connected again.

> **Added in 1.2**

A user who has a password must enter it again before a new provider is connected, unless they confirmed it, or signed in with a provider, in the last five minutes. In the app this takes three steps on unbranded pages served by the backend: confirm the password, click **Continue** on the next page, then go through the provider a second time. No second **Connect** click in Settings is needed. Signing in with a username and password does not count as a recent confirmation, so a user who just did so is still asked once. A user without a password isn't asked; their primary email address receives a notice that a sign-in provider was connected. Signing in with a provider is not affected.

> **Changed in 1.2** (#1260)

A user without a password can set one in **Settings → Security**, but only within five minutes of signing in with one of their connected providers (allauth's `ACCOUNT_REAUTHENTICATION_TIMEOUT`, default 300 seconds). After that, Settings asks them to sign out, sign in again with their provider, and set the password straight away; a user with no provider to sign in with is pointed to **Forgot password?**. This keeps a copied browser session from becoming a lasting password.

The upgrade changes nothing here: a provider sign-in made shortly before the upgrade still counts while inside the five minutes. Users with a password change it with their current password as before, and a reset link still sets a first password without this step.

> **Changed in 1.2** (#1932)

The same five-minute provider sign-in applies when a user without a password adds or changes an email address, in **Settings → Profile** and on the backend's `/accounts/email/` page. Outside it, Settings asks them to sign out, sign in again with their provider, and change the address straight away. Users with a password confirm it as before.

<a id="generic-oidc"></a>

## Generic OIDC <span style="background:#dbeafe;color:#1d4ed8;font-size:11px;font-weight:700;padding:2px 8px;border-radius:10px;vertical-align:middle;letter-spacing:0.3px;">BETA</span>

!!! info "Validated against Keycloak; community feedback welcome for other providers"
    The end-to-end login flow is validated automatically in CI against a real Keycloak instance via the `oidc-smoke` job (`docker-compose.oidc.yml`). Other providers — Okta, Authentik, Dex, and others — have not been tested end-to-end. You may encounter issues with token exchange, scope mapping, or callback handling specific to your IdP.

    If you test this against a non-Keycloak provider, report findings on [issue #349](https://gitlab.com/visiban/visiban/-/issues/349).

!!! note "Keycloak default port"
    Keycloak's default HTTP port is **8080** and Visiban's development backend uses **8000**, so there is no conflict. The local OIDC dev stack (`docker compose -f docker-compose.yml -f docker-compose.oidc.yml up`) serves Keycloak at `http://localhost:8080`, the frontend at `http://localhost:5173` and the API at `http://localhost:8000`.

Use generic OIDC when your identity provider supports standard OIDC but is not one of the pre-configured providers (Google, GitHub, GitLab). Common examples: Keycloak, Authentik, Dex, Okta, and any other OIDC-compliant IdP.

It is available in the OSS edition via `allauth.socialaccount.providers.openid_connect`, which is already included in the `django-allauth` dependency. No additional packages are required.

The end-to-end login flow is validated automatically in CI against a real Keycloak instance via the `oidc-smoke` job. See `docker-compose.oidc.yml` for local development with Keycloak.

### Configuration via environment variables (recommended)

Set all three required variables. The provider registers only when all three are present. Leaving any one blank disables OIDC entirely, which prevents startup errors from partial configuration.

| Variable | Required | Description |
|---|---|---|
| `OIDC_CLIENT_ID` | Yes | OAuth 2.0 client ID issued by your IdP |
| `OIDC_CLIENT_SECRET` | Yes | OAuth 2.0 client secret issued by your IdP |
| `OIDC_SERVER_URL` | Yes | Issuer URL of your IdP — see note below |
| `OIDC_PROVIDER_NAME` | No | Label shown on the login button (default: `SSO`) |

!!! warning "Alias removed in 1.1"
    `OIDC_SECRET` was a deprecated alias for `OIDC_CLIENT_SECRET` that was removed in 1.1. If you are upgrading from 1.0 and had `OIDC_SECRET` set, rename it to `OIDC_CLIENT_SECRET` — OIDC login will silently not activate if only the old name is present.

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

The env-var approach configures one OIDC provider. For several at once (for example, separate realms for staff and contractors), add the others in the Django admin at `/admin/socialaccount/socialapp/` with provider type `openid_connect`. Each needs a unique **Provider ID** slug, and its callback URL follows the pattern in the note above.

### OAuth/OIDC with invite-only registration

In **invite-only** registration mode (Settings > Registration), users with an invite link can register with any configured OAuth or OIDC provider, not just email and password. The invite token passes through the OAuth flow automatically.

Existing users can log in via OAuth in any registration mode. Registration mode controls who may **join**; the authentication method controls how they **prove identity**. The two are independent.

### Disabling password login when OIDC is active

Setting OIDC env vars adds the OIDC login button alongside the existing username/password and OAuth options. It does not disable them.

**Yes, but:** a future release will add an admin toggle to disable password authentication entirely when SSO is configured. Until then, enforce OIDC-only access at the IdP level by issuing credentials only to users who should have access.

## SAML 2.0 / ADFS

> **Visiban Enterprise** — This feature is available in [Visiban Enterprise](https://visiban.com/enterprise).

SAML 2.0 and ADFS authentication are available in the enterprise edition. They need a separate library and are configured through the enterprise settings. Contact your Visiban Enterprise account team for setup.

## SCIM directory sync / JIT provisioning

> **Visiban Enterprise** — This feature is available in [Visiban Enterprise](https://visiban.com/enterprise).

SCIM 2.0 directory sync (automatic user provisioning and deprovisioning from your IdP) and just-in-time (JIT) account creation on first login are enterprise features, aimed at organizations with centralized identity management at scale. Smaller teams get the same onboarding in the OSS edition through invite links.

## Classification rationale

For the reasoning behind the OSS vs enterprise boundary for these authentication methods, see the [Open-Core Boundary](../architecture/open-core-boundary.md#oidc-authentication-oss-vs-saml-scim-enterprise) reference page.
