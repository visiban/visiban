# Let people sign in with the account they already have

Each login provider is two environment variables plus a callback URL registered with the provider. All of them are optional: username/email and password login always works.

**Why it matters:** OAuth and OIDC login are in the free, open-source core. Your team signs in with the identity provider you already run.

**The big picture:**

| Provider | Variables | Scopes |
|---|---|---|
| [Google](#google) | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | `profile`, `email` (requested) |
| [GitHub](#github) | `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | `read:user`, `user:email` (required) |
| [GitLab](#gitlab) | `GITLAB_CLIENT_ID`, `GITLAB_CLIENT_SECRET` | `read_user`, `openid`, `email` (required) |
| [Any OIDC provider](#generic-oidc-openid-connect) | `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, `OIDC_SERVER_URL`, optional `OIDC_PROVIDER_NAME` | `openid`, `email`, `profile` (requested) |

**Watch out:** The callback URLs below use `http://localhost:8000` for local development. In production, replace it with your public domain in every callback URL.

## Google

1. Go to [Google Cloud Console](https://console.cloud.google.com/) → APIs & Services → Credentials.
2. Create an OAuth 2.0 client ID (Web application).
3. Add `http://localhost:8000/accounts/google/login/callback/` to the authorized redirect URIs.
4. Add to `.env`:

```
GOOGLE_CLIENT_ID=your-client-id
GOOGLE_CLIENT_SECRET=your-client-secret
```

## GitHub

1. GitHub → Settings → Developer settings → OAuth Apps → New OAuth App.
2. Set the callback URL to `http://localhost:8000/accounts/github/login/callback/`.
3. Add to `.env`:

```
GITHUB_CLIENT_ID=your-client-id
GITHUB_CLIENT_SECRET=your-client-secret
```

## GitLab

1. GitLab → User Settings → Applications → Add new application.
2. Set the redirect URI to `http://localhost:8000/accounts/gitlab/login/callback/`.
3. Add to `.env`:

```
GITLAB_CLIENT_ID=your-app-id
GITLAB_CLIENT_SECRET=your-app-secret
```

## Production URLs

Replace `http://localhost:8000` with your public domain in every callback URL.

!!! note "nginx must proxy `/accounts/`"
    OAuth callbacks are handled under `/accounts/...` (as shown above). Make sure your production nginx config proxies `/accounts/` to the backend. Both `nginx/app.conf.template` (HTTPS) and `nginx/app-http.conf.template` (HTTP) already include this block.

## Generic OIDC (OpenID Connect)

Any standards-compliant OpenID Connect provider works through the generic OIDC backend. Examples include Keycloak, Authentik, Dex, Azure AD, and Okta.

1. In your identity provider, create a confidential client with:
   - Grant type: **Authorization Code**
   - Redirect URI: `https://yourdomain.com/accounts/oidc/oidc/login/callback/` (replace with your domain; use `http://localhost:8000` for local dev)
2. Add to `.env`:

```
OIDC_CLIENT_ID=your-client-id
OIDC_CLIENT_SECRET=your-client-secret
OIDC_SERVER_URL=https://idp.example.com/realms/my-realm
OIDC_PROVIDER_NAME=SSO        # optional — controls the login button label
```

**Watch out: set all three or nothing happens.** OIDC is enabled only when `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, and `OIDC_SERVER_URL` are all set. Setting one or two has no effect.

**How it works:** `OIDC_SERVER_URL` must be the issuer root URL. Visiban appends `/.well-known/openid-configuration` to discover the token and userinfo endpoints automatically.

!!! note "The doubled `oidc` in the callback URL isn't a typo"
    The first `oidc` is allauth's `OPENID_CONNECT_URL_PREFIX` (its default). The second is Visiban's fixed `provider_id` for the generic OIDC provider. `OIDC_PROVIDER_NAME` changes only the button label, not this path.

<a id="testing-oidc-locally"></a>

## Test OIDC locally

`docker-compose.oidc.yml` starts a pre-seeded Keycloak alongside the main stack. You can exercise the full OIDC login flow without a real identity provider:

```bash
docker compose -f docker-compose.yml -f docker-compose.oidc.yml up
```

Log in at http://localhost:5173 with the **Keycloak** SSO button as `testuser` / `testpassword`. The Keycloak admin console is at http://localhost:8080 (`admin` / `admin`).

**Go deeper:** Invite links carry through OAuth sign-up; see [Inviting your team](first-boot.md#inviting-your-team).
