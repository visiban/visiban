# Run the test layer that matches your change

Visiban ships three layers of automated tests. Run the one that matches what you're changing.

**Why it matters:** Add coverage in the same merge request as the behavior change, not in a follow-up.

| Layer | Location | Runner | When to add |
|---|---|---|---|
| Backend unit / integration | `backend/<app>/tests/` | `pytest` (Django test runner) | Every model change, serializer change, view change |
| Frontend unit / component | `frontend/src/test/` | Vitest + React Testing Library | Every component, hook, or utility change |
| End-to-end | `frontend/e2e/` | Playwright (Chromium) | User-visible flows that span multiple components |

## Backend tests

CI and local runs both go through `pytest` (`backend/setup.cfg`'s `[tool:pytest]` config),
not `manage.py test` — `pytest-django` reads the same `TestCase` classes.

```bash
cd backend
pytest                 # whole suite
pytest -q boards/tests/test_views_extra.py                                   # one file
pytest -q boards/tests/test_views_extra.py::CardAttachmentTests::test_list_attachments_empty  # one test
```

Use Django's `TestCase` for anything that touches the database. If a test spawns threads that hit the ORM, close per-thread connections before the thread exits — see [`CLAUDE.md`](https://gitlab.com/visiban/visiban/-/blob/main/CLAUDE.md#threaded-tests--always-close-db-connections) for the pattern.

## Frontend unit tests

```bash
cd frontend
npx vitest              # watch mode
npm test                # single run with coverage off (CI mode; runs `vitest run`)
npm test -- --coverage  # single run with a coverage report
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
npx playwright test               # all specs, headless
npx playwright test --ui          # Playwright UI mode (interactive)
npx playwright test filter-bar    # match by filename
npx playwright test --headed      # watch Chromium as it runs
```

`npm run test:e2e` is the same command (`playwright test`) via a package.json alias — either form works.

Playwright auto-starts the Vite dev server on port 5173 (`playwright.config.ts` → `webServer`). If you already have `npm run dev` running, Playwright reuses it.

### Directory layout

```
frontend/e2e/
├── fixtures/
│   └── board.ts          # Single source of truth for USER, BOARD_FULL, CARD, etc.
├── helpers.ts            # routeAuth(page), routeBoard(page), END_OF_LINE
├── login.spec.ts         # Unauth → login flow
├── board.spec.ts         # Board renders, card CRUD
├── filter-bar.spec.ts    # Label filters, chips, saved-filter tabs
├── swimlane.spec.ts      # Swimlane collapse/expand + persistence
├── card-peek.spec.ts     # 600ms hover popover
├── card-aging.spec.ts    # Card aging ramp overlay + idle-days badge
├── activity-drawer.spec.ts  # Cmd+\ drawer + WS events
├── card-detail.spec.ts   # Card dialog + unified activity timeline
├── command-palette.spec.ts  # Cmd+K search
├── theme.spec.ts         # Light/dark toggle + persistence
├── export.spec.ts        # Export button visibility + JSON trigger
├── mobile-nav.spec.ts    # Hamburger drawer at narrow viewport
├── rich-text-editor.spec.ts  # Card description editor + markdown round-trip
├── card-description-caret.spec.ts  # Caret stays visible typing at the end of a description
└── demo.spec.ts          # Hosted demo visitor loop (explore, move a card, create-board refused)
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

### Moving the caret to the end of a line

Use `END_OF_LINE` from `./helpers` (`page.keyboard.press(END_OF_LINE)`), never a bare `'End'` or `'Home'`. On a macOS host, Playwright's Chromium driver maps those keys to the native editing commands `scrollToEndOfDocument:` and `scrollToBeginningOfDocument:`, which smooth-scroll the nearest scroll container without moving the caret. On Linux (CI) the same keys move the caret, so a spec that uses them behaves differently on a developer's Mac than in the pipeline (#1475). `END_OF_LINE` is `Meta+ArrowRight` on macOS and `End` elsewhere.

### Mobile viewports

For tests that target the below-`lg` breakpoint (1024 px), scope the viewport at the `describe` level:

```ts
test.describe('mobile nav drawer', () => {
  test.use({ viewport: { width: 375, height: 720 } })
  // ...
})
```

Don't change the viewport mid-test — responsive layout transitions are expensive and flaky.

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
  window.localStorage.setItem('user:prefs:theme', 'dark')
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

### Flake-resistance checklist (Vitest unit tests)

The Playwright list above has a unit-test counterpart. Every root-caused `frontend-test` flake so
far (#1304, #1305, #1319) was a component defect that a loaded CI runner exposed, not test noise:

- [ ] **Act only on a settled page.** Finding the first element a fetch renders doesn't mean the
  page is idle: the commit that shows it can still have mount effects and further fetches queued,
  and on a slow runner `waitFor` returns inside that window. Before firing events, wait for the
  last thing the page loads. `renderAdminPageSettled()` in `src/test/adminPage.test.tsx` is the
  pattern: it waits for `EmailSettingsSection`'s `Host` field, the last section to load.
- [ ] **Re-query after an event** (`screen.getByLabelText(...)`) instead of asserting on a node
  captured before it, so a remount can't leave the assertion reading a detached element.
- [ ] **Test the commit-to-effect window when a component holds a local input buffer.** Mount it
  from a resolved promise (outside `act()`), call `stallEventLoopAfterWaitFor()` from
  `src/test/eventLoopStall.ts` inside the `waitFor` that finds the input, assert the mount effects
  haven't run yet, then type. `customFieldValueInput.test.tsx` and `lensFilterBar.test.tsx` show
  it. The component rule this protects is in `frontend/CLAUDE.md` § Local input buffers and timers.
- [ ] **No timer that can outlive its component.** Hold a delayed timer's id in a ref, clear it
  on unmount, and add a test that unmounts with the timer pending. ESLint `no-restricted-syntax`
  catches only a call whose id is visibly discarded (a whole statement, an arrow's expression
  body such as `.then(() => setTimeout(...))`, or `void setTimeout(...)`) with a delay other
  than a literal `0`. It doesn't catch a stored id that's never cleared, so review still has
  to look for the cleanup.

## Writing tests that catch mutations

A test that only checks `status_code == 200` or `assertTrue(result)` passes when the code under it's wrong. The [mutation baseline](mutation-testing.md) shows what kills mutants instead. Four patterns account for nearly all of it. The examples are real excerpts from `backend/boards/tests/`.

### 1. Exact values over truthiness

Assert the full value the caller sees: the whole message, every field, the wire value of an enum. A fragment check (`assertIn`, `startswith` alone) survives a mutant that wraps the message in extra text.

```python
# test_import_export_mutation_gaps.py
resp = self.post(_upload(b"x" * (1024 * 1024 + 1)))
self.assert_400(resp, "File too large. Maximum size is 1 MB.")
```

### 2. Boundary tests at N-1, N, and N+1

A `>=` to `>` change on a limit survives unless a test sits exactly on the limit. Test the last accepted value and the first rejected value, and assert the exact rejection message.

```python
# test_import_export_mutation_gaps.py
def test_cards_500_accepted(self):
    resp = self.post(_minimal(cards=self._cards(500)))
    self.assertEqual(resp.status_code, 201, resp.content[:300])
    self.assertEqual(Card.objects.count(), 500)

def test_cards_501_rejected(self):
    self.assert_400(
        self.post(_minimal(cards=self._cards(501))),
        "Import contains 501 cards, which exceeds the limit of 500.",
    )
```

### 3. Persisted state after a reload

A response can be right while the row is wrong. Re-read from the database (`refresh_from_db()` or a fresh query) and assert on what was stored, including denormalized columns that must outlive the thing they point at.

```python
# test_movement_record_mutation_gaps.py
other_lane.delete()
row2.refresh_from_db()
self.assertIsNone(row2.from_swimlane)
self.assertEqual(row2.to_swimlane_name, "Other")
```

### 4. Denied paths assert that nothing happened

A rejected request must leave no row, movement, or event behind. Asserting the 4xx alone lets a mutant that writes first and rejects afterward survive. Count the rows after the denial, and check the exception detail or response body, not just the type.

```python
# test_import_export_mutation_gaps.py
def test_nothing_is_created_by_a_rejected_import(self):
    self.post(
        _minimal(cards=[{"title": "B", "column": "Nope", "swimlane": "General"}])
    )
    self.assertEqual(Board.objects.count(), 0)
```

The same applies to audit rows. This denied create asserts the exact 409 body, the unchanged count, and that no `CardMovement` row was written (a sibling suite, not a gap file):

```python
# test_limit_enforcement_paths.py
self.assertEqual(r.status_code, 409, r.content)
self.assertEqual(self._active(self.limited), 2)
# The rollback covers the audit row too.
self.assertFalse(CardMovement.objects.filter(notes="Card created").exists())
```

Do the same for broadcast events: assert nothing was queued.

### Row-lock tests (PostgreSQL only)

SQLite has no row locks, so a `select_for_update()` can be deleted without failing the SQLite suite. Test each lock with the hold-the-first-transaction pattern: pause the first request inside its transaction (after it took the lock and wrote, before it commits), start a second request only once the first is paused, and assert both that the second couldn't finish before the pause ended and that the final state is consistent (distinct positions, caps respected). Decorate the class with `@skipUnless(connection.vendor == "postgresql", ...)` and use `TransactionTestCase`. Every thread that touches the ORM must call `connections.close_all()` in a `finally`. Prove the test is meaningful by temporarily removing the lock and confirming it fails on PostgreSQL. See `backend/boards/tests/test_concurrent_moves.py` (`ConcurrentMoveLockTests`) and `backend/boards/tests/test_concurrent_lock_sites.py`.

### What not to do

- **Do not write one test per mutant.** Write the smallest assertion that states the behavior; one test often kills several mutants. A suite shaped like the survivor list breaks on every refactor.
- **Do not pin the full wording of logger text.** Assert the level and a stable event-name prefix or key substring (`assertLogs(..., level="WARNING")` plus `assertIn("malformed payload", ...)`), not the whole sentence. Pin the full message only when it's a documented contract.
- **Do not assert on `.get()` defaults that are always overridden.** If no production input can reach the default, the mutant is equivalent: mark it `# pragma: no mutate -- <reason>` (a reason is required) instead of leaving it as a survivor. See the [policy](mutation-testing.md#equivalent-mutants-and-the-score-1503).
- **Do not chase equivalent mutants** (dead branches, schema constants guarded by `migration-check`); exclude them with a reasoned pragma. See "How to read the results" in the mutation baseline.

## CI

- Backend tests run in the `backend-test` job (8 parallel shards) on every MR that touches `backend/**/*` or `requirements*.txt`
  - Shards are time-balanced by `pytest-split` from the committed `backend/.test_durations` file. Shards never write it (concurrent shards would overwrite each other's slice). Refresh it occasionally, e.g. after a large batch of new tests: `cd backend && pytest --store-durations --durations-path .test_durations`, then commit the file. A stale file only degrades balance, never correctness.
- `backend-benchmark` is a **manual** job (#1341) that runs `python manage.py benchmark --fail-on-budget`.
    - **Trigger:** use the pipeline page's manual-job play button on an MR or `main` pipeline. It's `allow_failure: true` so an unrun job never blocks a merge, and it never runs on schedules or tags.
    - **What it does:** the command seeds its own throw-away board (100 cards) and counts SQL queries for the card list, `full/`, and `summary/` against committed budgets. It fails on a non-2xx response, on `DEBUG` being off, or on any endpoint over budget.
    - **Locally:** `cd backend && DEBUG=True python manage.py benchmark --fail-on-budget`
    - **Why manual:** the same `benchmark --fail-on-budget` already runs on Postgres inside `backend-test` on every backend MR via `BenchmarkCommandCiGateTests.test_within_budget_passes_with_fail_on_budget`, so an automatic job would be near-redundant and cost a Postgres + Valkey pair per MR. Run on demand it adds `DEBUG` taken from the environment, a run outside a `TestCase` transaction, and a fresh `migrate`.
    - **Latency:** regressions that keep the query count identical are covered by `nightly-load-test` ([nightly-load-test.md](nightly-load-test.md)).
    - **First measured** on Postgres in #1341: cards 9 (budget 12), `full/` 17 (budget 20), `summary/` 4 (budget 10).
    - **Budgets** partly overlap `backend/boards/tests/test_query_counts.py`. The benchmark's cards check serializes `_card_queryset` directly (a subset of the endpoint), so its budget of 12 is intentionally different from `CardListQueryCountTests.BUDGET` (14); it's a coarser check, not a replacement. `full/` (20) is deliberately 1 above `BoardFullQueryCountTests.BUDGET` (19) and `summary/` (10) equals `SummaryQueryCountTests.BUDGET`. Neither should exceed the `test_query_counts.py` value plus that slack. When a budget legitimately changes, bump both files together following [perf-bench.md section 6](https://gitlab.com/visiban/visiban/-/blob/main/.claude/agents/perf-bench.md).
- Frontend unit tests run in `frontend-test`. Unlike `backend-schema-fuzz` below, a single failed test retries once automatically under CI (`vitest.config.ts`'s `test.retry`, gated on `process.env.CI` so local runs stay strict) before failing the job.
    - The retry only absorbs a one-off scheduler hiccup.
    - Every occurrence that has been root-caused was a component defect that failed on both attempts: a leaked post-save timer (#1319 occurrence 3) and an effect-seeded input buffer racing the first edit (occurrence 4; occurrence 1 was most likely the same race).
    - **A red job whose test shows `(retry x1)` means a real bug.** Investigate it; don't re-run the job until it passes.
    - Don't raise the retry to 2 either. A second retry wouldn't have saved any of these, and it would hide the next one.
- Playwright E2E runs in `playwright-e2e` — starts its own Vite dev server, no separate build step needed. It's `allow_failure: true` during rollout; promotion to blocking is tracked separately.
- `backend-schema-validate` checks the generated OpenAPI document is well-formed;
  `backend-schema-fuzz` goes further and fuzzes a real, running instance with
  [schemathesis](https://schemathesis.readthedocs.io/) to catch a response that doesn't match
  its declared schema — see [`docs/api/openapi.md`](../api/openapi.md#fuzz-testing-the-contract-against-real-responses-backend-schema-fuzz).
  It's blocking (`allow_failure: false`) as of #1120.
    - A handful of already-tracked schema-accuracy gaps (#1119, #1123, now closed) were recorded as scoped, justified entries in `backend/schemathesis-baseline.json` rather than blocking on them landing first.
    - #1170 pruned the leftovers down to 12 entries (from two full-length runs, different seeds), each now carrying a `"reason"` field.
    - The undocumented-`400` gap (#1124) is closed generically by `visiban/schema_hooks.py` (#1165).
    - **A red run is a real defect, never a flake.** Don't retry it; see the
  [triage steps](../api/openapi.md#a-red-backend-schema-fuzz-job-is-never-a-flake)
- `backend-schema-fuzz-git-lens` is the same fuzz with `GIT_LENS_ENABLED=True`, narrowed to
  the Issue Board Lens routes, with its own `backend/schemathesis-baseline-git-lens.json` and
  the GitHub/GitLab calls answered by an in-process stub (#1338). See
  [`docs/api/openapi.md`](../api/openapi.md)
- The `changelog-check` job blocks the pipeline if no fragment is added under `changelog.d/`

### SonarCloud coverage import (#1370)

SonarCloud doesn't run tests. It imports the reports the `test` stage already produces, via `sonar.python.coverage.reportPaths` and `sonar.javascript.lcov.reportPaths` in `sonar-project.properties`. The nightly `sonar:scan` job consumes:

- the `backend-test-coverage` artifact (`backend/coverage.xml`, Cobertura);
- the `frontend-test` artifact (`frontend/coverage/lcov.info`). `lcov` is one of the vitest `coverage.reporter` formats alongside `text` and `cobertura`, which GitLab's coverage badge and `coverage_report` still depend on.

Neither report resolves from the repo root as emitted, so `scripts/sonar-scan.sh --prep-only` rewrites them into `backend/coverage.sonar.xml` (injects the `<source>` root) and `frontend/coverage/lcov.sonar.info` (prefixes `SF:src/` with `frontend/`).

- **Reproduce the CI scan locally:** generate both reports, then run `SONAR_TOKEN=... scripts/sonar-scan.sh`.
- **`--prep-only`** prints how many class entries and `SF:` files each rewritten report lists (and warns on zero), so the nightly log shows whether paths resolved.
- **`scripts/sonar-scan.sh --self-test`** fixtures both rewrites and runs in the `sonar-scan-selftest` CI job.

Test code, migrations, repo tooling, and seed/factory modules are removed from the coverage denominator by `sonar.coverage.exclusions`. Each entry is justified in the properties file, and nothing under product source is excluded.

### Mutation score (#1384)

Coverage says a line ran. A **mutation score** says whether the tests would notice if the line were wrong. The weekly `backend-mutation` job makes one small change at a time to the code (flip `==` to `!=`, change a constant, replace a value with `None`), re-runs that code's tests, and counts the change as **killed** if a test fails or **survived** if every test still passes. It covers `boards/permissions.py`, `boards/services/cards.py`, the `CardMovement` class in `boards/models.py` and `boards/views/import_export.py`; the list and each target's test files are `TARGETS` in `backend/mutmut_config.py`.

- **What the number means:** 92% means that of every 100 small, plausible bugs introduced into the code, the tests caught 92. The other 8 are *survivors*: changes the tests couldn't tell apart from the real code. A survivor is either a missing assertion (worth a test) or an equivalent mutant (a change no production input could observe). It isn't a measure of correctness, and a high score in these modules says nothing about code outside them.
- **Score:** the **adjusted** score is `(killed + timeout) / (killed + timeout + survived + suspicious)`; mutants on other shards' lines (`skipped`) aren't counted. Mutants excluded with `# pragma: no mutate -- <reason>` are left out of it. The **raw** score also counts them (as not detected), so exclusions stay visible; both are printed and written to the artifact. A timeout counts as killed because the change hung the suite.
- **Where to read it:** the `backend-mutation-report` job log prints one line per target and then the merged counts and score. The `mutmut-cicd-stats.json` artifact (kept 30 days) holds the merged numbers at the top level and each target under `targets`. It runs on the Weekly mutation testing schedule only (Sundays, 06:00 ET), never on an MR.
- **Floor:** `MUTATION_MIN=0.90` gates the **merged adjusted** score over all targets (exit 1 below it). A target under 90% on its own is named in the log but doesn't fail the job by itself. Until the follow-up on #1384 both jobs are `allow_failure: true`, so a low score shows as a yellow job, not a red pipeline; a follow-up makes the report blocking. The floor is a fraction (`0.90`, never `90`); `0` or a value outside (0, 1] is rejected (exit 2).
- **Yellow can also mean not measured** (exit 2): a shard or a whole target's stats files didn't arrive (a shard timed out or failed before writing its file), a file is malformed, a target's shards aren't one consistent run (their `total` mutant counts differ, or their non-skipped mutants don't add up to that total), a run finished with untested mutants, or nothing was scoreable. The export step also exits 2 if mutmut isn't importable or if a source file has pragmas that change no mutant count. The artifact is still written and carries a `not_measured` key with the reason; read the log to tell this from a low score. An invalid `MUTATION_MIN` fails before any stats are read, so that run has no artifact; fix the variable. Treat not measured as a broken job, not a score.
- **Reading survivors:** survivors aren't in the artifact. Reproduce the target locally in a throwaway copy of `backend/` (see [Mutation Testing Baseline](mutation-testing.md#how-to-reproduce)), then `mutmut results` lists them and `mutmut show <id>` prints the diff of one. For each survivor ask, in order: could any production input observe this change? If not, it's an **equivalent mutant**: mark it with a reasoned `# pragma: no mutate`. Does any test in the target's list reach the line? If not, it's **untested code**. Otherwise it's a **missing assertion**: add the smallest assertion that fails on the mutant (an exact message, a boundary value, an empty case). See [Writing tests that catch mutations](#writing-tests-that-catch-mutations).

### Coverage targets

Three different numbers apply. They measure different things; see
[SonarCloud § Why GitLab's coverage badge and Sonar's differ](sonarcloud.md#why-gitlabs-coverage-badge-and-sonars-differ).

| Measure | Target | Enforced by |
|---|---|---|
| SonarCloud overall coverage (backend and frontend, product source only) | **At least 85%**, with **80% as the floor** | Policy, read on the SonarCloud dashboard. Not a CI gate |
| Backend aggregate | **90%** | `backend-test-coverage` runs `coverage report --fail-under=90` and blocks the pipeline |
| Frontend aggregate | Lines **83%**, statements **80%**, functions and branches **77%** | `coverage.thresholds` in `frontend/vitest.config.ts` |
| Lines an MR adds or changes | **80%** | `backend-diff-coverage` and `frontend-diff-coverage` (see [Diff coverage](#diff-coverage-1076)) |

**Yes, but:** The frontend thresholds are a floor that stops the aggregate from regressing, and they are lower than the Sonar target. A change that leaves the frontend at its threshold can still pull Sonar's combined number under 85%, so aim higher on new code instead of treating the threshold as the goal.

**Watch out:** Raise a threshold when the aggregate has stayed comfortably above it. Never lower one to make a pipeline pass.

### Diff coverage (#1076)

**Why it matters:** `backend-test-coverage` and `frontend-test`'s vitest thresholds gate the *aggregate* coverage of the whole codebase. That number moves slowly: a large, well-tested codebase can absorb a fully untested new feature and barely notice.

`backend-diff-coverage` and `frontend-diff-coverage` close that gap:

- They run only on MR pipelines (there's no diff to measure on `main`).
- They use [`diff-cover`](https://github.com/Bachmann1234/diff_cover) to measure coverage of only the lines the MR adds or changes, against the same `coverage.xml` / `cobertura-coverage.xml` the aggregate jobs already produce. No test re-run.
- Both are blocking at **80% of changed lines** and print the uncovered line numbers in the job log (`--show-uncovered`), not just a percentage.

Excluded from the diff denominator on both sides:

- backend `*/migrations/*` and `manage.py` (schema, not behavior; see the `backend-diff-coverage` job comment in `.gitlab-ci.yml` for why the aggregate run *does* count migrations but the diff gate doesn't);
- frontend `src/test/*`, `*.test.*`, `*.spec.*` (already excluded from the coverage report itself by `vitest.config.ts`'s `coverage.exclude`; the CI job's `--exclude` is belt-and-suspenders).

Generated files, if any are ever introduced, should be added to the same exclude list.

#### Diff coverage escape hatch

An MR can legitimately fail this gate without meaning "add more tests": a pure refactor that only moves lines, or a vendored file with no realistic local test. When that happens:

1. Say so explicitly in the MR description (a line under a `## Notes` heading is enough:
   *"backend-diff-coverage fails on moved-but-unchanged lines in `foo.py`; no new
   behavior to test."*).
2. A reviewer confirms the reasoning and re-runs the job manually with an adjusted
   understanding, or approves the MR with the failing job explicitly acknowledged.

**Watch out:** The override is always visible in the MR discussion and job history. Never silence the gate by weakening the threshold or broadening `--exclude` to route around a single MR.

### Added-file coverage guard (#1091)

**Why it matters:** `diff-cover` has an inverted blind spot. A **brand-new** source file with zero tests never appears in `coverage.xml` / `cobertura-coverage.xml` at all, so `diff-cover` finds no rows for it and reports **100%** for that file. A file with *some* tests gets scrutinized; a file with *none* sails through. (The aggregate-coverage version of this same bug, an uninstrumented CI job reading as 0%, is #1090.)

`added-files-coverage-check` closes this gap. It reuses the same `coverage.xml` / `cobertura-coverage.xml` artifacts as the diff-coverage jobs above (no test re-run). For every file *added* (not modified) since the MR's merge-base, it checks:

- the file is in scope: `backend/*.py` and `frontend/src/*.ts(x)`, excluding whatever `backend/.coveragerc`'s `omit` list and `vitest.config.ts`'s `coverage.exclude` list already exclude (plus migrations and `manage.py`, same as the diff-coverage `--exclude`);
- the file has a `<class filename="...">` row in the report. If not, it fails the build, naming the file and explaining what to do about it in the job log.

The script (`scripts/check-added-files-covered.mjs`) ships a `--self-test` mode, run in its own `added-files-coverage-check-self-test` CI job on the same `node:20-alpine` image as the real check. It builds a synthetic git repo and coverage fixtures in a temp directory (no network, no database, no changes to the real working tree) and asserts detection fires on a known-bad fixture and stays clean on a known-good one. This is the house pattern for bespoke gate scripts described in #1093.

### Stale dev venv

**Symptom:** a clean branch fails with a bare `ModuleNotFoundError` that reads like a regression (#1715: `mcp` 1.x installed against the `mcp==2.3.0` pin).

**Cause:** backend tests run against the venv in `backend/.venv`, which every `scripts/wt` worktree shares by symlink, and `backend/requirements.txt` moved since the venv was last synced.

**Fix:** run `scripts/wt doctor` (also run by `scripts/wt new`). It warns, per drifted `==` pin, `<package>: requires X, installed Y`. Then run `backend/.venv/bin/pip install -r backend/requirements.txt`. The check is covered by `scripts/tests/wt-doctor-drift.test.sh`.

Every `glab`/`gh` call in `scripts/wt` is bounded by `WT_FORGE_TIMEOUT` (a positive integer, default 20 seconds). A stalled call degrades to a warning instead of hanging, and `scripts/wt release <issue>` clears a lock left behind. `scripts/tests/wt-forge-timeout.test.sh` covers this.

## Git hooks

Run `scripts/setup-hooks.sh` once per clone to install the push-time collision check and the pre-commit secret scan.

**Why it matters:** `scripts/wt` (see its `--help`) applies a `status::wip` GitLab label when you create a worktree with `wt new`/`wt claim`, so a parallel agent or teammate doesn't grab the same issue. That lock only covers work that goes through `wt`. A plain `git checkout -b feat/N-something` bypasses it entirely, and the first sign of a collision is two merge requests solving the same issue.

`scripts/check-issue-collision.sh` closes that gap at push time, regardless of how the branch was created. Install it once per clone:

```bash
scripts/setup-hooks.sh
```

This installs a `pre-push` hook and a `pre-commit` hook. Every `scripts/wt` worktree of this clone shares them, since hooks live in the git common dir, so there's no need to re-run per worktree.

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

The `pre-commit` hook runs `scripts/gitleaks-precommit.sh`, blocking a commit that stages a hardcoded secret.

- It no-ops with a warning if `gitleaks` isn't installed locally. The merge-blocking `gitleaks-scan` CI job is the hard gate; this hook is just the earliest possible local catch.
- Install gitleaks with `brew install gitleaks` (or see [gitleaks releases](https://github.com/gitleaks/gitleaks/releases)).

`setup-hooks.sh` is idempotent and never clobbers a hook it doesn't manage (e.g. a hand-written lint hook) for either `pre-push` or `pre-commit`. It prints the line to add manually so the two can be chained instead. Run `scripts/check-issue-collision.sh --self-test` to exercise the issue-collision check offline against stubbed forge responses.

**Yes, but:** Both hooks are local, best-effort checks. `gitleaks-scan` is the CI job that blocks a merge; `check-issue-collision.sh` has no CI counterpart (see [CI gate self-tests](ci-gates.md#known-gaps-and-deferred-work)).
