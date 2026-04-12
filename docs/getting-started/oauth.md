# OAuth Setup

Visiban supports Google, GitHub, and GitLab OAuth login. All three are optional — username/email + password login always works.

## Google

1. Go to [Google Cloud Console](https://console.cloud.google.com/) → APIs & Services → Credentials
2. Create an OAuth 2.0 client ID (Web application)
3. Add `http://localhost:8000/accounts/google/login/callback/` to authorized redirect URIs
4. Add to `.env`:

```
GOOGLE_CLIENT_ID=your-client-id
GOOGLE_CLIENT_SECRET=your-client-secret
```

Scopes required: `openid`, `email`, `profile`

## GitHub

1. GitHub → Settings → Developer settings → OAuth Apps → New OAuth App
2. Set callback URL to `http://localhost:8000/accounts/github/login/callback/`
3. Add to `.env`:

```
GITHUB_CLIENT_ID=your-client-id
GITHUB_CLIENT_SECRET=your-client-secret
```

Scopes required: `read:user`, `user:email`

## GitLab

1. GitLab → User Settings → Applications → Add new application
2. Set redirect URI to `http://localhost:8000/accounts/gitlab/login/callback/`
3. Add to `.env`:

```
GITLAB_CLIENT_ID=your-app-id
GITLAB_CLIENT_SECRET=your-app-secret
```

Scopes required: `read_user`, `openid`, `email`

## Production URLs

Replace `http://localhost:8000` with your public domain in all callback URLs.

!!! note
    OAuth callbacks are routed through `/_allauth/` paths handled by the backend. Ensure your production nginx config proxies `/_allauth/` to the backend — both `nginx/app.conf.template` (HTTPS) and `nginx/app-http.conf.template` (HTTP) already include this block.

## Generic OIDC (OpenID Connect)

Visiban supports any standards-compliant OpenID Connect provider (Keycloak, Authentik, Dex, Azure AD, Okta, etc.) via the generic OIDC backend.

1. Create a confidential client in your identity provider with:
   - Grant type: **Authorization Code**
   - Redirect URI: `https://yourdomain.com/_allauth/browser/v1/auth/provider/callback` (replace with your domain; use `http://localhost:8000` for local dev)
2. Add to `.env`:

```
OIDC_CLIENT_ID=your-client-id
OIDC_CLIENT_SECRET=your-client-secret
OIDC_SERVER_URL=https://idp.example.com/realms/my-realm
OIDC_PROVIDER_NAME=SSO        # optional — controls the login button label
```

All three of `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, and `OIDC_SERVER_URL` must be set for OIDC to be enabled; setting only one or two has no effect.

`OIDC_SERVER_URL` must be the issuer root URL. Visiban appends `/.well-known/openid-configuration` to discover token and userinfo endpoints automatically.

Scopes requested: `openid`, `email`, `profile`.
