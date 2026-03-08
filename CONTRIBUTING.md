# Contributing to Visiban

Thank you for taking the time to contribute. This document covers how to report bugs, request features, and submit code changes.

## Contents

- [Filing a bug report](#filing-a-bug-report)
- [Requesting a feature](#requesting-a-feature)
- [Setting up for development](#setting-up-for-development)
- [Submitting a merge request](#submitting-a-merge-request)
- [Code style](#code-style)

---

## Filing a bug report

Open an issue at [gitlab.com/visiban/visiban/-/issues](https://gitlab.com/visiban/visiban/-/issues) and include:

1. **What you were doing** — a short description of the steps that led to the problem
2. **What you expected to happen**
3. **What actually happened** — paste any error messages or screenshots
4. **Environment** — your browser, operating system, and how you're running Visiban (Docker Compose, local dev, etc.)

The more detail you provide, the faster we can reproduce and fix the issue.

> If you believe you have found a security vulnerability, please do **not** open a public issue. Instead, contact the maintainer directly.

---

## Requesting a feature

Open an issue and describe:

- The problem you're trying to solve (not just the solution you have in mind)
- How you currently work around it, if at all
- Any context that would help — screenshots, sketches, links to similar tools

---

## Setting up for development

See [Installation](docs/getting-started/installation.md) for the full guide. The short version:

```bash
git clone https://gitlab.com/visiban/visiban.git
cd visiban
cp .env.example .env
docker compose up --build
```

For local backend development without Docker, see the **Local Development** section of the installation guide.

---

## Submitting a merge request

1. **Fork** the repository and create a branch from `main`
2. **Name your branch** descriptively — `feat/my-feature`, `fix/the-bug`, `docs/update-readme`
3. **Keep changes focused** — one feature or fix per MR makes review much easier
4. **Write a clear MR description** — what changed and why, and any testing steps the reviewer should follow
5. **Update the [CHANGELOG](CHANGELOG.md)** — add an entry under `[Unreleased]` in the appropriate section (Added / Changed / Fixed / Removed)
6. Open the MR against `main`

If you're unsure whether a change is a good fit, open an issue to discuss it first before putting in the work.

---

## Code style

### Backend (Python)

- Follow PEP 8
- All new API endpoints should have corresponding tests in `backend/boards/tests/`
- Keep views thin — business logic belongs in models or dedicated service functions
- All card mutation endpoints must use `@transaction.atomic`

### Frontend (TypeScript / React)

- TypeScript strict mode is enabled — avoid `any`
- Component state is local React state; there is no global state library
- Optimistic updates for all user-initiated mutations — roll back on failure
- Tailwind CSS for styling — avoid inline styles

### Commits

Use conventional commit prefixes:

| Prefix | Use for |
|---|---|
| `feat:` | New features |
| `fix:` | Bug fixes |
| `docs:` | Documentation only |
| `refactor:` | Code changes that aren't features or fixes |
| `test:` | Adding or updating tests |
| `chore:` | Build, CI, dependency updates |
