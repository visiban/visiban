# Visiban

[![pipeline status](https://gitlab.com/visiban/visiban/badges/main/pipeline.svg)](https://gitlab.com/visiban/visiban/-/commits/main)
[![coverage report](https://gitlab.com/visiban/visiban/badges/main/coverage.svg)](https://gitlab.com/visiban/visiban/-/commits/main)
[![release](https://img.shields.io/github/v/release/visiban/visiban?include_prereleases&label=release)](https://github.com/visiban/visiban/releases)
[![docs](https://img.shields.io/badge/docs-docs.visiban.com-blue)](https://docs.visiban.com/next/)
![License](https://img.shields.io/badge/license-Apache%202.0-blue)

**Visiban is a self-hosted Kanban board for teams that track many independent entities through a shared pipeline.** Think customers moving through a sales process, accounts in an onboarding flow, or projects across delivery stages — each gets its own swimlane row, and the whole board gives you an at-a-glance view of where everything stands.

Every card move is recorded automatically. You always know where something is _and_ how it got there.

---

## Where things live

| | |
|---|---|
| **Source of truth** | [gitlab.com/visiban/visiban](https://gitlab.com/visiban/visiban) — development, CI/CD, and merge requests |
| **Releases & containers** | [github.com/visiban/visiban](https://github.com/visiban/visiban) — release tags, GitHub Releases, and Docker images on GHCR |
| **Bug reports & feature requests** | [GitLab Issues](https://gitlab.com/visiban/visiban/-/issues) — opening an issue on GitHub automatically bridges it there |
| **Documentation** | [docs.visiban.com](https://docs.visiban.com/next/) |

GitHub is a read-only mirror of the GitLab repository. All development happens on GitLab; GitHub is the public distribution point.

---

## Quick start

```bash
git clone https://gitlab.com/visiban/visiban.git
cd visiban
cp .env.example .env   # set DJANGO_SECRET_KEY at minimum
docker compose up --build
```

Open **http://localhost:5173**. The first-boot admin password is printed to the container logs.

> **Running in production?** See the [installation guide](https://docs.visiban.com/next/getting-started/installation/) for HTTPS setup, environment variables, and database configuration.

---

## What makes Visiban different

Most Kanban tools give you a single pipeline. Visiban gives you a **grid** — columns on the x-axis (stages), swimlane rows on the y-axis (entities). You can see every customer, account, or project and its current stage in one view, without clicking into anything.

Every time a card moves to a different column or swimlane, Visiban writes a **movement record**: who moved it, when, and from where. No plugins, no manual logging. The card's History tab shows the full timeline alongside comments, priority changes, and other field edits. A board-level History tab lets you search and filter movements across all cards at once.

All connected users see changes in **real time** over a WebSocket connection. Drag a card and it moves on everyone else's screen immediately.

---

## Features

| Feature | Description |
|---|---|
| **Swimlane board** | Grid of columns × swimlane rows. Collapse, resize, and reorder with drag-and-drop. [→ Board guide](https://docs.visiban.com/next/features/board/) |
| **Movement audit trail** | Every card move is timestamped and attributed. View per-card history or search the board-level History tab. [→ Card history](https://docs.visiban.com/next/features/card-history/) |
| **Analytics** | Dwell-time heatmap per stage, stalled-card detection, 7/30-day throughput velocity, CSV export. [→ Analytics](https://docs.visiban.com/next/features/analytics/) |
| **Real-time sync** | WebSocket-powered — card moves, edits, and structural changes appear instantly for all connected users. [→ Real-time](https://docs.visiban.com/next/features/realtime/) |
| **Groups & RBAC** | Boards live inside groups (unlimited nesting). Five roles — admin, member, collaborator, viewer, plus moderator entitlement — with automatic group inheritance. [→ Groups](https://docs.visiban.com/next/features/groups/) |
| **Card detail** | Rich-text description, priority, assignee, labels, due date, weight, checklist, file attachments, and threaded comments with @mentions. [→ Board guide](https://docs.visiban.com/next/features/board/#cards) |
| **Board sharing** | Generate a read-only public link. Anyone with the URL can view the board — no account needed. Revoke it any time. [→ Sharing](https://docs.visiban.com/next/features/board/#board-sharing) |
| **Import & export** | JSON round-trip with full movement history, or CSV for spreadsheets. Import from the dashboard; export from the board toolbar. [→ Export & import](https://docs.visiban.com/next/features/board/#export--import) |
| **Bulk operations** | Select multiple cards and move, reassign, reprioritize, archive, or delete them all at once. |
| **OAuth & OIDC login** | Google, GitHub, and GitLab OAuth out of the box. Connect any OIDC provider via environment variables. [→ OAuth setup](https://docs.visiban.com/next/getting-started/oauth/) |
| **Notifications** | In-app alerts for @mentions, card assignments, and stale cards. [→ Notifications](https://docs.visiban.com/next/features/notifications/) |
| **Saved filters** | Save and restore filter presets per board — private to each user, synced across devices. [→ Board guide](https://docs.visiban.com/next/features/board/#filters-and-search) |
| **Board history** | Board-level History tab with filterable movement log — search by swimlane, column, user, and date range. [→ Card history](https://docs.visiban.com/next/features/card-history/) |
| **Swimlane focus** | Focus on a single swimlane to dim all other rows — toggle via crosshair button or URL `?focus=`. [→ Board guide](https://docs.visiban.com/next/features/board/) |
| **Hard WIP enforcement** | Block all card moves (including admins) when a column is at capacity. [→ Board guide](https://docs.visiban.com/next/features/board/) |
| **Invite links** | Shareable URLs with configurable role, expiry (1d/7d/30d), and single-use options. [→ Groups](https://docs.visiban.com/next/features/groups/) |
| **Personal access tokens** | Token-based API access for scripts and integrations. [→ PATs](https://docs.visiban.com/next/features/personal-access-tokens/) |

---

## Documentation

Full documentation is at **[docs.visiban.com](https://docs.visiban.com/next/)**.

| Topic | Link |
|---|---|
| Installation & configuration | [Getting started](https://docs.visiban.com/next/getting-started/installation/) |
| First boot | [First boot](https://docs.visiban.com/next/getting-started/first-boot/) |
| Board & cards | [Board guide](https://docs.visiban.com/next/features/board/) |
| Analytics & summary | [Analytics](https://docs.visiban.com/next/features/analytics/) |
| Groups | [Groups](https://docs.visiban.com/next/features/groups/) |
| Roles & permissions | [RBAC](https://docs.visiban.com/next/rbac/roles/) |
| API reference | [API](https://docs.visiban.com/next/api/boards/) |
| Site administration | [Administration](https://docs.visiban.com/next/administration/site-admins/) |

To serve the docs locally:

```bash
pip install -r docs/requirements.txt
mkdocs serve --dev-addr=localhost:8001
```

---

## Tech stack

| Layer | Technology |
|---|---|
| Backend | Python 3.12, Django 5, Django REST Framework |
| ASGI / WebSocket | daphne, Django Channels 4, channels-redis |
| Database | PostgreSQL 17 |
| Cache | Redis 7 |
| Auth | django-allauth — Google / GitHub / GitLab OAuth + OIDC |
| Frontend | React 19, TypeScript, Vite, Tailwind CSS 3 |
| Drag & drop | @dnd-kit |
| CI/CD | GitLab CI — lint, test, SAST, Docker build verification |
| Infra | Docker Compose, Nginx, Helm (Kubernetes) |

---

## Contributing

Contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

**Bug reports and feature requests** go to [GitLab Issues](https://gitlab.com/visiban/visiban/-/issues). If you open an issue on GitHub it will be automatically bridged to GitLab — you'll receive a comment with the tracking link.

**Merge requests** are accepted on GitLab only. GitHub pull requests cannot be merged (GitHub is a mirror).

---

## Docker images

Release images are published to GitHub Container Registry and require no authentication:

```bash
docker pull ghcr.io/visiban/visiban/backend:latest
docker pull ghcr.io/visiban/visiban/frontend:latest
```

Pin to a specific release for production:

```bash
docker pull ghcr.io/visiban/visiban/backend:v1.1.0-rc.2
docker pull ghcr.io/visiban/visiban/frontend:v1.1.0-rc.2
```

All release tags are listed at [github.com/visiban/visiban/releases](https://github.com/visiban/visiban/releases).

---

## Changelog

See [CHANGELOG.md](CHANGELOG.md) for a full history of releases and changes.

---

## License

Apache 2.0 — see [LICENSE](LICENSE).
