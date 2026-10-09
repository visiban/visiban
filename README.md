# Visiban

[![pipeline status](https://gitlab.com/visiban/visiban/badges/main/pipeline.svg)](https://gitlab.com/visiban/visiban/-/commits/main)
[![coverage report](https://gitlab.com/visiban/visiban/badges/main/coverage.svg)](https://gitlab.com/visiban/visiban/-/commits/main)
[![quality gate](https://sonarcloud.io/api/project_badges/measure?project=visiban_visiban&metric=alert_status)](https://sonarcloud.io/summary/new_code?id=visiban_visiban)
[![reliability](https://sonarcloud.io/api/project_badges/measure?project=visiban_visiban&metric=reliability_rating)](https://sonarcloud.io/summary/new_code?id=visiban_visiban)
[![security](https://sonarcloud.io/api/project_badges/measure?project=visiban_visiban&metric=security_rating)](https://sonarcloud.io/summary/new_code?id=visiban_visiban)
[![coverage (SonarCloud)](https://sonarcloud.io/api/project_badges/measure?project=visiban_visiban&metric=coverage)](https://sonarcloud.io/summary/new_code?id=visiban_visiban)
[![release](https://img.shields.io/github/v/release/visiban/visiban?include_prereleases&label=release)](https://github.com/visiban/visiban/releases)
[![docs](https://img.shields.io/badge/docs-docs.visiban.com-blue)](https://docs.visiban.com/next/)
![License](https://img.shields.io/badge/license-Apache%202.0-blue)

**Visiban is an open-source Kanban board where every row is an entity and every move is on the record.** Each swimlane is a customer, account, or project moving through a shared pipeline, so the whole board gives you an at-a-glance view of where everything stands. You get typed fields on the row, WIP limits, card aging and dwell-time analytics, and a permanent audit trail of every card movement. An API and MCP server let you connect your own tools.

Every card move is recorded automatically. You always know where something is _and_ how it got there.

**In one line: kill the spreadsheet, see how work actually moves, interrogate it with your own AI — every move on the record.** Swimlane rows carry typed fields of their own, so the data teams usually keep in a side-spreadsheet lives on the board instead. A first-class MCP server lets any AI agent you already run query and change the board through a scoped token you issue — Visiban ships the *interface*, not a model, so no data leaves your install. OIDC/OAuth SSO is in the Apache-2.0 core, not a paid tier.

Comparing options? [Why Visiban](https://docs.visiban.com/next/getting-started/why-visiban/) is an honest look at what it does differently — and when one of the alternatives is the better pick.

---

## Where things live

| | |
|---|---|
| **Source of truth** | [gitlab.com/visiban/visiban](https://gitlab.com/visiban/visiban) — development, CI/CD, and merge requests |
| **Releases & containers** | [github.com/visiban/visiban](https://github.com/visiban/visiban) — release tags, GitHub Releases, and Docker images on GHCR |
| **Bug reports & feature requests** | [GitLab Issues](https://gitlab.com/visiban/visiban/-/issues) — opening an issue on GitHub automatically bridges it there |
| **Documentation** | [docs.visiban.com](https://docs.visiban.com/next/) |
| **Sample boards** | [`backend/boards/sample_boards/`](backend/boards/sample_boards/) — ready-to-import boards, including an enterprise sales overlay board ([guide](https://docs.visiban.com/next/getting-started/sample-boards/)) |

GitHub is a read-only mirror of the GitLab repository. All development happens on GitLab; GitHub is the public distribution point.

---

## Quick start

```bash
git clone https://gitlab.com/visiban/visiban.git
cd visiban
cp .env.example .env   # set DJANGO_SECRET_KEY at minimum
docker compose up --build
```

Open **http://localhost:5173**. Retrieve the first-boot admin password with `docker compose exec backend cat /tmp/visiban_admin_password` — see [First boot](https://docs.visiban.com/next/getting-started/first-boot/) for details.

Want a populated board to explore? Import any file from [`backend/boards/sample_boards/`](backend/boards/sample_boards/) via **Dashboard → Import**.

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
| **Groups & RBAC** | Boards live inside groups (unlimited nesting). Four roles — admin, member, collaborator, viewer — plus a moderator entitlement, with automatic group inheritance. [→ Groups](https://docs.visiban.com/next/features/groups/) |
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
| Roles & permissions | [RBAC](https://docs.visiban.com/next/features/rbac/roles/) |
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
| Cache / channel layer | Valkey 8 (Redis-compatible) |
| Auth | django-allauth — Google / GitHub / GitLab OAuth + OIDC |
| Frontend | React 19, TypeScript, Vite, Tailwind CSS 3 |
| Drag & drop | @dnd-kit |
| CI/CD | GitLab CI — lint, test, SAST, Docker build verification |
| Infra | Docker Compose, Nginx, Helm (Kubernetes) |

---

## How this is built

Visiban is developed with heavy use of AI coding assistants, primarily [Claude Code](https://claude.com/claude-code). Most of the code, and most of the tests, were written by an AI; commits carry a `Co-Authored-By` trailer where that applies. Treat it the way you would any AI-assisted codebase: read it before you trust it, and use it at your own risk, as the [Apache 2.0 license](LICENSE) already says.

What stands between AI-written code and `main`:

- **Review.** Every change lands through a merge request that the maintainer reviews. Nothing is committed directly to `main`.
- **CI on every merge request.** Lint, type checks, the backend, frontend, and Playwright end-to-end suites, SAST, secret scanning (gitleaks), and dependency vulnerability scanning.
- **Schema fuzzing.** The API is fuzzed against its own schema in CI. A failing fuzz run is treated as a real defect, not a flake.
- **Static analysis.** A [SonarCloud](https://sonarcloud.io/project/overview?id=visiban_visiban) scan runs nightly.

What this does **not** prove: that AI-written tests assert the right things. Coverage numbers do not show that. Mutation testing is the way to measure it: a [manual baseline](https://docs.visiban.com/next/development/mutation-testing/) covers the movement record, RBAC, and import/export modules, and a nightly CI job (`backend-mutation`) runs mutation testing on those same modules (RBAC, the card service, the movement-record model and import/export) with a 90% floor on the merged score. For its first week the floor is reported but not yet blocking. Most of the codebase has not been mutated. If you find a test that passes without checking anything meaningful, please [open an issue](https://gitlab.com/visiban/visiban/-/issues).

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
docker pull ghcr.io/visiban/visiban/backend:v1.2.0-alpha.4
docker pull ghcr.io/visiban/visiban/frontend:v1.2.0-alpha.4
```

All release tags are listed at [github.com/visiban/visiban/releases](https://github.com/visiban/visiban/releases).

---

## Changelog

See [CHANGELOG.md](CHANGELOG.md) for a full history of releases and changes.

---

## License

Apache 2.0 — see [LICENSE](LICENSE).
