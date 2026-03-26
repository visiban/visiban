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

## OAuth (Google, GitHub, GitLab)

See the [OAuth Setup](../getting-started/oauth.md) guide for step-by-step configuration of each provider.

## Generic OIDC

!!! warning "Tech Preview — not tested against a real identity provider"
    The OIDC configuration plumbing (env vars, provider registration, settings guard) is implemented and unit-tested. However, **the end-to-end login flow has not been validated against any real identity provider** — Keycloak, Okta, Authentik, Dex, or otherwise. Treat this as a tech preview: the wiring is in place, but you may encounter issues with token exchange, scope mapping, or callback handling that have not yet been discovered.

    If you test this against your IdP, please report findings on [issue #349](https://gitlab.com/visiban/visiban/-/issues/349).

Generic OIDC is available in the OSS edition via `allauth.socialaccount.providers.openid_connect`, which is already included in the `django-allauth` dependency. No additional packages are required.

Use this when your identity provider supports standard OIDC but is not one of the pre-configured providers (Google, GitHub, GitLab). Common examples: Keycloak, Authentik, Dex, Okta, and any other OIDC-compliant IdP.

### Configuration via environment variables (recommended)

Set all three of the following environment variables. The provider is only registered when all three are present — leaving any one blank disables OIDC entirely, preventing startup errors from partial configuration.

| Variable | Required | Description |
|---|---|---|
| `OIDC_CLIENT_ID` | Yes | OAuth 2.0 client ID issued by your IdP |
| `OIDC_SECRET` | Yes | OAuth 2.0 client secret issued by your IdP |
| `OIDC_SERVER_URL` | Yes | Issuer URL of your IdP — see note below |
| `OIDC_PROVIDER_NAME` | No | Label shown on the login button (default: `SSO`) |

**Example** (`docker-compose.yml` or `.env`):

```env
OIDC_CLIENT_ID=visiban
OIDC_SECRET=my-client-secret
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

### Multi-provider support

The env-var approach configures a single OIDC provider. If you need multiple OIDC providers simultaneously (for example, separate realms for staff and contractors), configure additional providers through the Django admin at `/admin/socialaccount/socialapp/` with provider type `openid_connect`. Each additional provider requires a unique **Provider ID** slug.

### Disabling password login when OIDC is active

Setting OIDC env vars makes the OIDC login button appear alongside existing username/password and OAuth options — it does not disable them. A future release will add an env var to restrict login to OIDC only. Until then, you can enforce OIDC-only access at the IdP level by issuing credentials only to users who should have access.

### Callback URL (legacy / Django admin method)

If you configure additional providers via the Django admin rather than env vars, the callback URL pattern is:

```
https://<your-domain>/accounts/oidc/<provider-id>/login/callback/
```

where `<provider-id>` is the slug you set in the **Provider ID** field.

## SAML 2.0 / ADFS

> **Visiban Enterprise** — This feature is available in [Visiban Enterprise](https://visiban.com/enterprise).

SAML 2.0 and ADFS authentication are available in the enterprise edition. They require a separate library and are configured through the enterprise settings. Contact your Visiban Enterprise account team for setup instructions.

## Classification rationale

For the reasoning behind the OSS vs enterprise boundary for these authentication methods, see the [Open-Core Boundary](../architecture/open-core-boundary.md#oidc-authentication-oss-vs-saml-enterprise) reference page.
