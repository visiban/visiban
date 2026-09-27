# Hosted demo (try.visiban.com)

Deployment artifacts for the public demo instance (#1034): a Docker Compose
stack on a small VPS, Caddy for automatic TLS, and a nightly reset back to a
known seed state.

> **Dedicated host only.** Demo mode publishes the admin credentials on the
> login page and the nightly reset deletes the database. Never enable it on an
> instance holding real data, never configure SSO/OAuth or real SMTP on it, and
> never share its database with another install.

## What is here

| File | Purpose |
|---|---|
| `docker-compose.demo.yml` | Override for `docker-compose.prod.yml`: swaps nginx for Caddy |
| `Caddyfile` | Reverse proxy + SPA hosting with automatic Let's Encrypt TLS |
| `.env.example` | Demo settings to copy into the repo-root `.env` (placeholders only) |
| `reset.sh` | Nightly `down -v`, `up -d`, reseed |
| `visiban-demo-reset.cron` | `/etc/cron.d` entry that runs `reset.sh` at 00:00 UTC |

## Setup

1. Clone the repo on the demo host (for example to `/opt/visiban`) and point
   DNS for `try.visiban.com` at it. Ports 80 and 443 must be reachable.
2. Copy `deploy/demo/.env.example` to `.env` in the repo root and replace every
   `REPLACE_ME` (`openssl rand -base64 36`). The repo-root `.env` is git-ignored.
3. Start the stack and seed it once:

   ```bash
   docker compose -f docker-compose.prod.yml -f deploy/demo/docker-compose.demo.yml up -d
   docker compose -f docker-compose.prod.yml -f deploy/demo/docker-compose.demo.yml \
     exec -T backend python manage.py seed_demo_data --force --wipe --demo-site
   ```

4. Install the nightly reset:

   ```bash
   sudo install -m 0644 deploy/demo/visiban-demo-reset.cron /etc/cron.d/visiban-demo-reset
   ```

`reset.sh` refuses to run unless `DEMO_MODE=true` is set in `.env`, so a stray
cron entry cannot wipe a real install.

## What gets seeded

`seed_demo_data --demo-site` (see [Demo data](../../docs/administration/demo-data.md#hosted-demo-instance))
creates Software Team, Marketing Campaigns, and Hiring Pipeline boards (20 cards
each, with comments, assignees, labels, and movement history) alongside the
standard demo board, an admin account (`DEMO_LOGIN_USERNAME`), and two member
accounts (`maya`, `jordan`). Nobody has completed the onboarding tour, so it runs
on first login.

## Not covered here (human follow-ups)

VPS provisioning, DNS, verifying the nightly reset in production, and the
analytics/reporting pieces of #1034 (Plausible or Umami snippet, weekly Slack
digest to #growth) are outside this directory.
