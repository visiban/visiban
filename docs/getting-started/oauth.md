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
