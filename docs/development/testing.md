# Testing

Visiban ships three layers of automated tests. Run the one that matches what you're changing, and add coverage in the same merge request as the behavior change — not in a follow-up.

| Layer | Location | Runner | When to add |
|---|---|---|---|
| Backend unit / integration | `backend/<app>/tests/` | `pytest` (Django test runner) | Every model change, serializer change, view change |
| Frontend unit / component | `frontend/src/test/` | Vitest + React Testing Library | Every component, hook, or utility change |
| End-to-end | `frontend/e2e/` | Playwright (Chromium) | User-visible flows that span multiple components |

## Backend tests

```bash
cd backend
python manage.py test
# or a single app/class/method
python manage.py test boards.tests.test_views.BoardViewSetTest.test_list_boards
```

Use Django's `TestCase` for anything that touches the database. If a test spawns threads that hit the ORM, close per-thread connections before the thread exits — see [`CLAUDE.md`](https://gitlab.com/visiban/visiban/-/blob/main/CLAUDE.md#threaded-tests--always-close-db-connections) for the pattern.

## Frontend unit tests

```bash
cd frontend
npm test               # watch mode
npm test -- --run      # single run (CI mode)
npm test -- --coverage # with coverage report
```

Prefer `@testing-library/react` queries in the order:

1. `getByRole(name: ...)` — matches how assistive technology sees the element
2. `getByLabelText` — for form fields
3. `getByPlaceholderText` — fallback when the field has no label
4. `getByText` — for non-interactive copy
5. `getByTestId` — last resort; prefer to avoid `data-testid` attributes

Mock API calls at the module boundary with Vitest (`vi.mock('../api/boards')`). Never mock `axios` directly — mock the function that uses it.

## End-to-end tests (Playwright)

E2E tests verify complete user flows against the real Vite dev server. All API calls are intercepted with `page.route()` so no Django backend or database is required — tests run anywhere Node and Chromium can.

### Running locally

```bash
cd frontend
npx playwright install chromium   # one-time
npm run test:e2e                  # all specs, headless
npm run test:e2e -- --ui          # Playwright UI mode (interactive)
npm run test:e2e -- filter-bar    # match by filename
npm run test:e2e -- --headed      # watch Chromium as it runs
```

Playwright auto-starts the Vite dev server on port 5173 (`playwright.config.ts` → `webServer`). If you already have `npm run dev` running, Playwright reuses it.

### Directory layout

```
frontend/e2e/
├── fixtures/
│   └── board.ts          # Single source of truth for USER, BOARD_FULL, CARD, etc.
├── helpers.ts            # routeAuth(page), routeBoard(page)
├── login.spec.ts         # Unauth → login flow
├── board.spec.ts         # Board renders, card CRUD
├── filter-bar.spec.ts    # Label filters, chips, saved-filter tabs
├── swimlane.spec.ts      # Swimlane collapse/expand + persistence
├── card-peek.spec.ts     # 600ms hover popover
├── card-aging.spec.ts    # Stale-card amber overlay
├── activity-drawer.spec.ts  # Cmd+\ drawer + WS events
├── card-detail.spec.ts   # Card dialog + unified activity timeline
├── command-palette.spec.ts  # Cmd+K search
├── theme.spec.ts         # Light/dark toggle + persistence
├── export.spec.ts        # Export button visibility + JSON trigger
└── mobile-nav.spec.ts    # Hamburger drawer at narrow viewport
```

### Fixture pattern

All fixtures live in `frontend/e2e/fixtures/board.ts`. Every test imports the shared `USER`, `BOARD_FULL`, `CARD`, `SITE_CONFIG`, etc. — never inline a bespoke payload unless the test is specifically exercising a variant shape.

When a test needs a variant (e.g. a viewer with stricter export permissions), spread the base fixture and override only the differing fields:

```ts
const lockedBoard = {
  ...BOARD_FULL,
  current_user_role: 'viewer' as const,
  export_min_role: 'member' as const,
}
```

If you add a new serializer field on the backend, update the fixture in the same MR. A missing field silently breaks every spec that depends on the shape.

### Route mocking

Most specs open with:

```ts
import { routeAuth, routeBoard } from './helpers'
import { BOARD_FULL, CARD } from './fixtures/board'

test.beforeEach(async ({ page }) => {
  await routeAuth(page)    // auth/me, site-config, providers, boards list
  await routeBoard(page)   // board/full, cards, saved-filters, WebSocket
})
```

Add per-test routes for endpoints not covered by the helpers:

```ts
await page.route(`**/api/v1/boards/${BOARD_FULL.id}/cards/${CARD.id}/timeline/**`, (route) =>
  route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ count: 0, next: null, results: [] }),
  }),
)
```

**Patterns to keep consistent:**

- Use `**` prefix on routes so they match regardless of origin (`http://localhost:8000` in dev, any host in CI)
- Return `{ count, results: [...] }` for paginated endpoints — the frontend unwraps DRF pagination uniformly
- Register routes **before** `page.goto()` — routes set after navigation don't apply to the initial request
- Register the most specific route first if you have both a generic and a specific handler for the same path
- Endpoints that take query params (e.g. `?starred=true`) need a regex pattern in the helper — a bare glob like `**/api/v1/boards/` matches only the exact path and misses the query-string variant

### WebSocket stubbing

`routeBoard()` registers a stub that sends a `connected` event immediately, so the board never renders in "disconnected" state. For tests that exercise live events, override the stub:

```ts
await page.routeWebSocket(`**/ws/boards/${BOARD_FULL.id}/`, (ws) => {
  ws.send(JSON.stringify({ event: 'connected', data: {} }))
  setTimeout(() => {
    ws.send(JSON.stringify({
      event: 'card.created',
      data: { id: 99, title: 'Remote-created card', /* ... */ },
    }))
  }, 200)
})
```

Event shape is always `{ event, data }` — never the flat `{ type, ...spread }` form. See `docs/api/websockets.md`.

### DOM query preferences

Match the semantic role whenever it exists — tests that assert on role + accessible name survive refactors that touch class names or DOM structure:

1. `page.getByRole('button', { name: 'Export board' })`
2. `page.getByRole('combobox', { name: 'Command palette search' })`
3. `page.getByLabel('Email address')` — form controls without a visible label
4. `page.getByPlaceholder('Search…')` — no label, has a placeholder
5. `page.getByText('Download started')` — status copy with no interactive role
6. `page.locator('#card-detail-title')` — last resort, when no accessible name exists

Avoid class-based selectors (`page.locator('.btn-primary')`) — they break on every Tailwind refactor.

### Mobile viewports

For tests that target the below-`lg` breakpoint (1024 px), scope the viewport at the `describe` level:

```ts
test.describe('mobile nav drawer', () => {
  test.use({ viewport: { width: 375, height: 720 } })
  // ...
})
```

Do not change the viewport mid-test — responsive layout transitions are expensive and flaky.

### Non-fetch side effects

Some components use `window.open()` rather than `fetch()` (e.g. board export → server-generated download). Intercept those with an init script that monkey-patches `window.open` before the page loads:

```ts
await page.addInitScript(() => {
  ;(window as unknown as { __opened: string[] }).__opened = []
  window.open = ((url?: string | URL) => {
    ;(window as unknown as { __opened: string[] }).__opened.push(String(url ?? ''))
    return null
  }) as typeof window.open
})

// later…
const opened = await page.evaluate(() => (window as unknown as { __opened: string[] }).__opened)
expect(opened.some((u) => u.includes('/api/v1/boards/1/export/'))).toBe(true)
```

Return `null` from the patched `window.open` to avoid popup blocker / `about:blank` noise.

### LocalStorage pre-seeding

Tests that assert "setting persists across reload" should pre-seed the key with `page.addInitScript()` so the value is written before any React code runs:

```ts
await page.addInitScript(() => {
  window.localStorage.setItem('visiban-theme', 'dark')
})
await page.goto('/settings')
await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
```

Never call `localStorage.setItem` after `page.goto()` — by then the provider has already read the initial value.

### Flake-resistance checklist

Before committing a new spec:

- [ ] Every `expect(...).toBeVisible()` on a post-navigation element includes an explicit `{ timeout: ... }` — don't rely on the default
- [ ] No raw `page.waitForTimeout(ms)` — wait on a DOM condition instead
- [ ] No race between a `page.route()` registration and a `page.goto()` that triggers the request — register first
- [ ] Assertions are keyed on role + name, not class names
- [ ] Fixtures are imported from `fixtures/board.ts`, not inlined per-test

## CI

- Backend tests run in the `test-backend` job on every MR
- Frontend unit tests run in `test-frontend`
- Playwright E2E runs in `e2e-test` — requires the Vite dev server build to succeed first
- `backend-schema-validate` checks the generated OpenAPI document is well-formed;
  `backend-schema-fuzz` goes further and fuzzes a real, running instance with
  [schemathesis](https://schemathesis.readthedocs.io/) to catch a response that doesn't match
  its declared schema — see [`docs/api/openapi.md`](../api/openapi.md#fuzz-testing-the-contract-against-real-responses-backend-schema-fuzz).
  Blocking (`allow_failure: false`) as of #1120; a handful of already-tracked
  schema-accuracy gaps (#1119, #1123, #1124) are recorded as scoped, justified entries in
  `backend/schemathesis-baseline.json` rather than blocking on them landing first
- The `changelog-check` job blocks the pipeline if no fragment is added under `changelog.d/`

### Diff coverage (#1076)

`backend-test-coverage` and `frontend-test`'s vitest thresholds gate the *aggregate*
coverage of the whole codebase. That number moves slowly — a large, well-tested
codebase can absorb a fully untested new feature and barely notice. `backend-diff-coverage`
and `frontend-diff-coverage` close that gap: they run only on MR pipelines (there's no
diff to measure on `main`) and use [`diff-cover`](https://github.com/Bachmann1234/diff_cover)
to measure coverage of only the lines the MR actually adds or changes, against the same
`coverage.xml` / `cobertura-coverage.xml` the aggregate jobs already produce — no test
re-run. Both are blocking at **80% of changed lines** and print the uncovered line numbers
in the job log (`--show-uncovered`), not just a percentage.

Excluded from the diff denominator on both sides: backend `*/migrations/*` and `manage.py`
(schema, not behavior — see the `backend-diff-coverage` job comment in `.gitlab-ci.yml` for
why the aggregate run *does* count migrations but the diff gate doesn't), and frontend
`src/test/*`, `*.test.*`, `*.spec.*` (already excluded from the coverage report itself by
`vitest.config.ts`'s `coverage.exclude`; the CI job's `--exclude` is belt-and-suspenders).
Generated files, if any are ever introduced, should be added to the same exclude list.

#### Diff coverage escape hatch

An MR can legitimately fail this gate without meaning "add more tests" — a pure refactor
that only moves lines, or a vendored file with no realistic local test. When that happens:

1. Say so explicitly in the MR description (a line under a `## Notes` heading is enough:
   *"backend-diff-coverage fails on moved-but-unchanged lines in `foo.py`; no new
   behavior to test."*).
2. A reviewer confirms the reasoning and re-runs the job manually with an adjusted
   understanding, or approves the MR with the failing job explicitly acknowledged.

The override is always visible in the MR discussion and job history — never silence the
gate by weakening the threshold or broadening `--exclude` to route around a single MR.

### Added-file coverage guard (#1091)

`diff-cover` has a blind spot that's the inverse of what you'd expect: a **brand-new**
source file with zero tests never appears in `coverage.xml` / `cobertura-coverage.xml` at
all, so `diff-cover` finds no rows for it and reports **100%** for that file — a file with
*some* tests gets scrutinized, a file with *none* sails through. (The aggregate-coverage
version of this same bug — an uninstrumented CI job reading as 0% — is #1090.)

`added-files-coverage-check` closes this gap. It reuses the same `coverage.xml` /
`cobertura-coverage.xml` artifacts as the diff-coverage jobs above (no test re-run):
for every file *added* (not modified) since the MR's merge-base, filtered to
`backend/*.py` and `frontend/src/*.ts(x)` and excluding whatever `backend/.coveragerc`'s
`omit` list and `vitest.config.ts`'s `coverage.exclude` list already exclude (plus
migrations and `manage.py`, same as the diff-coverage `--exclude`), it fails the build if
the file has no `<class filename="...">` row in the report at all — naming the file and
explaining what to do about it in the job log.

The script (`scripts/check-added-files-covered.mjs`) ships a `--self-test` mode, run in
its own `added-files-coverage-check-self-test` CI job on the same `node:20-alpine` image as
the real check: it builds a synthetic git repo and coverage fixtures in a temp directory
(no network, no database, no changes to the real working tree) and asserts detection fires
on a known-bad fixture and stays clean on a known-good one. This is the house pattern for
bespoke gate scripts described in #1093.

## Git hooks

`scripts/wt` (see its `--help`) applies a `status::wip` GitLab label when you create a
worktree with `wt new`/`wt claim`, so a parallel agent or teammate doesn't grab the same
issue — but that lock only covers work that goes through `wt`. A plain
`git checkout -b feat/N-something` bypasses it entirely, and the first sign of a
collision is two merge requests solving the same issue.

`scripts/check-issue-collision.sh` closes that gap at push time, regardless of how the
branch was created. Install it once per clone:

```bash
scripts/setup-hooks.sh
```

This installs a `pre-push` hook and a `pre-commit` hook (shared by every `scripts/wt`
worktree of this clone, since hooks live in the git common dir — no need to re-run per
worktree).

Before each push, on a branch named `(feat|fix|chore|docs)/<issue>-...`, the `pre-push`
hook:

- **Blocks the push** if an *open* merge request already exists for that issue from a
  *different* source branch — naming the MR and branch
- **Warns only** (never blocks) if the issue is already closed, or its `status::wip`
  lock is held by a different branch, possibly another worktree
- **Degrades to a warning and allows the push** whenever the forge can't be consulted —
  `glab` missing or unauthenticated, no network, origin isn't GitLab-hosted — so being
  offline never blocks a push

For the legitimate stacked-MR case (two branches against the same issue on purpose),
override a detected collision with:

```bash
ALLOW_ISSUE_COLLISION=1 git push ...
```

The `pre-commit` hook runs `scripts/gitleaks-precommit.sh`, blocking a commit that stages
a hardcoded secret. It no-ops with a warning if `gitleaks` isn't installed locally — the
merge-blocking `gitleaks-scan` CI job is the hard gate; this hook is just the earliest
possible local catch. Install gitleaks with `brew install gitleaks` (or see
[gitleaks releases](https://github.com/gitleaks/gitleaks/releases)).

`setup-hooks.sh` is idempotent and never clobbers a hook it doesn't manage (e.g. a
hand-written lint hook) for either `pre-push` or `pre-commit` — it prints the line to add
manually so the two can be chained instead. Run `scripts/check-issue-collision.sh
--self-test` to exercise the issue-collision check offline against stubbed forge
responses.

All four jobs must be green before a merge request can be merged.
