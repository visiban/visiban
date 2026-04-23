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
- The `changelog-check` job blocks the pipeline if no fragment is added under `changelog.d/`

All four jobs must be green before a merge request can be merged.
