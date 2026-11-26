import { test, expect, type Page } from '@playwright/test'
import { routeAuth, routeBoard } from './helpers'
import { REDESIGN_BOARD, REDESIGN_MOVEMENTS, REDESIGN_NOW } from './fixtures/redesign-board'

/**
 * Board redesign fidelity baseline (#2279). Each test captures one state of the
 * seeded sample board (`e2e/fixtures/redesign-board.ts`) and compares it with its
 * pinned `toHaveScreenshot` image; the references they were reviewed against live in
 * `docs/development/board-redesign/`. The board names the `classic` preset id on
 * purpose: that id resolves to this same board (#2279).
 *
 * Snapshots are Linux/Chromium images generated in the CI Playwright image; see
 * frontend/CLAUDE.md § Board presets for how to update them. On any other platform the
 * screenshot comparisons skip (with the reason) and the structural assertions still run.
 */
// An absolute pixel budget, not a ratio: on a 1440x2180 page a 1% ratio is about 31,000 pixels,
// enough to hide a priority badge or one card losing its aging tint. The images come from the
// same CI image that runs the comparison, so a few hundred pixels of antialiasing slack is plenty.
const SHOT = { animations: 'disabled' as const, maxDiffPixels: 300 }

const SHOT_SKIP_REASON =
  'screenshot baselines are Linux/Chromium images generated in the CI Playwright image; other platforms render fonts differently (frontend/CLAUDE.md § Board presets)'

/** `toHaveScreenshot` that skips, with a reason, off Linux. Assertions before it still run. */
async function expectShot(page: Page, name: string, options: { animations?: 'disabled' | 'allow'; maxDiffPixels?: number; fullPage?: boolean } = {}) {
  test.skip(process.platform !== 'linux', SHOT_SKIP_REASON)
  await expect(page).toHaveScreenshot(name, options)
}

async function openBoard(page: Page, theme: 'light' | 'dark', search = '') {
  await page.clock.setFixedTime(new Date(REDESIGN_NOW))
  await page.addInitScript((t) => {
    window.localStorage.setItem('user:prefs:theme', t)
  }, theme)
  await routeAuth(page)
  await routeBoard(page, REDESIGN_BOARD as unknown as Parameters<typeof routeBoard>[1])
  // The activity drawer's saved-history request (#2596) answers with no rows (an unrouted
  // request would fail and show the drawer's error row in the capture), so replay the
  // sample's moves as live `card.moved` events after the socket connects: the reference
  // shows seven.
  await page.route(new RegExp(`/api/v1/boards/${REDESIGN_BOARD.id}/movements/(\\?.*)?$`), (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ count: 0, offset: 0, page_size: 50, results: [] }) }),
  )
  // Each event carries the card as it already is on the board, so the board does not change.
  // The movement id matters (#2596): the clock is frozen, so every row ties on time and the
  // drawer orders ties by id. Without it each row gets a random id and the order shuffles.
  await page.routeWebSocket(`**/ws/boards/${REDESIGN_BOARD.id}/`, (ws) => {
    ws.send(JSON.stringify({ event: 'connected', data: {} }))
    setTimeout(() => {
      for (const m of REDESIGN_MOVEMENTS) {
        const card = REDESIGN_BOARD.cards.find((c) => c.uid === m.card_uid)
        ws.send(JSON.stringify({
          event: 'card.moved',
          data: { card, movement: { id: m.id, from_column_name: m.from_column_name, to_column_name: m.to_column_name, moved_by: m.moved_by } },
        }))
      }
    }, 1_000)
  })
  // The peek panel's history and time-in-column read the card's own movements.
  await page.route(`**/api/v1/boards/${REDESIGN_BOARD.id}/cards/*/movements/`, (route) => {
    const id = Number(route.request().url().match(/cards\/(\d+)\/movements/)?.[1])
    const card = REDESIGN_BOARD.cards.find((c) => c.id === id)
    // The card's last move is the one that put it in its column, so the history agrees with the
    // "No movement for N days" banner and the time in each column instead of reading "3 h ago".
    const history = REDESIGN_MOVEMENTS.filter((m) => m.card_uid === card?.uid).map((m) => ({
      ...m,
      moved_at: card?.column_entered_at ?? m.moved_at,
    }))
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(history) })
  })
  // ...and its sub-column moves, from the timeline's gate group (#2365). None here, so the
  // peek history is the movements alone and the pinned peek capture is unchanged.
  await page.route(/\/api\/v1\/boards\/\d+\/cards\/\d+\/timeline\/(\?.*)?$/, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ count: 0, next: null, previous: null, results: [] }) }),
  )
  await page.goto(`/boards/${REDESIGN_BOARD.id}${search}`)
  await expect(page.locator('[data-card-id]').first()).toBeVisible({ timeout: 15_000 })
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme)
  await page.evaluate(() => document.fonts.ready)
}

test.describe('board redesign baseline', () => {
  // Each reference is dark or light as drawn: board-light is light; board-dark, collapsed,
  // peek, activity, menus, states and phone are dark. The captures follow them.
  test.describe('desktop 1440', () => {
    // 2180 tall like the references, so the lower lanes (APAC, EMEA) are in the baseline.
    test.use({ viewport: { width: 1440, height: 2180 } })

    for (const theme of ['light', 'dark'] as const) {
      test(`board ${theme}`, async ({ page }) => {
        await openBoard(page, theme, '?preset=classic')
        await expectShot(page, `board-${theme}.png`, { ...SHOT, fullPage: true })
      })
    }
  })

  test.describe('desktop 1440 states', () => {
    test.use({ viewport: { width: 1440, height: 900 } })

    test('a ?preset=classic link loads the redesigned board', async ({ page }) => {
      await openBoard(page, 'light', '?preset=classic')
      await expect(page.getByRole('button', { name: /^Preset: Classic/ })).toHaveCount(0) // picker lives in the View menu
      await expect(page.getByTestId('board-header-row')).toBeVisible()
      await expect(page.locator('[data-card-id]').first()).toBeVisible()
    })

    test('collapsed lanes', async ({ page }) => {
      await openBoard(page, 'dark')
      await page.getByRole('button', { name: 'Collapse all lanes' }).click()
      await expect(page.getByRole('button', { name: 'Expand all lanes' })).toBeVisible()
      await expectShot(page, 'board-collapsed.png', SHOT)
    })

    test('hover peek is a tooltip, not a panel', async ({ page }) => {
      await openBoard(page, 'dark')
      const card = page.locator('[data-card-id]').first()
      const hoveredId = Number(await card.getAttribute('data-card-id'))
      const hovered = REDESIGN_BOARD.cards.find((c) => c.id === hoveredId)!
      await card.hover()
      // The peek tooltip is portaled, so tie it to the hovered card by its title, not just any tooltip.
      await expect(page.getByRole('tooltip').filter({ hasText: hovered.title })).toBeVisible({ timeout: 3_000 })
    })

    test('peek panel', async ({ page }) => {
      await openBoard(page, 'dark')
      // Shift+click opens the read-only peek panel the reference draws (#2358).
      await page.locator('[data-card-id]').first().click({ modifiers: ['Shift'] })
      await expect(page.getByRole('dialog', { name: /./ }).first()).toBeVisible()
      await expect(page.getByRole('button', { name: 'Close card peek' })).toBeVisible()
      await page.mouse.move(0, 0)
      await expectShot(page, 'board-peek.png', SHOT)
    })

    test('activity drawer', async ({ page }) => {
      await openBoard(page, 'dark')
      await page.getByRole('button', { name: 'Open activity drawer' }).click()
      await expect(page.getByRole('complementary', { name: 'Activity' })).toBeVisible()
      await expect(page.getByRole('complementary', { name: 'Activity' }).getByText(REDESIGN_MOVEMENTS[0].card_title)).toBeVisible()
      await page.mouse.move(720, 890) // off the toolbar, so no tooltip draws over the board
      await expectShot(page, 'board-activity.png', SHOT)
    })

    test('view menu', async ({ page }) => {
      await openBoard(page, 'dark')
      await page.getByRole('button', { name: /^View/ }).first().click()
      await expect(page.getByText('Preset', { exact: true }).first()).toBeVisible()
      await expectShot(page, 'board-menu-view.png', SHOT)
    })

    test('empty board state', async ({ page }) => {
      await page.addInitScript(() => {
        window.localStorage.setItem('user:prefs:theme', 'dark')
      })
      await page.clock.setFixedTime(new Date(REDESIGN_NOW))
      await routeAuth(page)
      await routeBoard(page, { ...REDESIGN_BOARD, cards: [] } as unknown as Parameters<typeof routeBoard>[1])
      await page.goto(`/boards/${REDESIGN_BOARD.id}`)
      await expect(page.getByTestId('board-empty-state')).toBeVisible({ timeout: 15_000 })
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
      await expectShot(page, 'board-state-empty.png', SHOT)
    })

    // Menus (#2394): the Filter panel and the ... menu, the two reference menus the View menu shot
    // does not cover. Opened one at a time (the reference draws all three side by side).
    test('filter menu', async ({ page }) => {
      // The reference opens the panel over two active filters (Label: Renewal and a second row), so
      // the capture carries the count badge, the highlighted rows and the chip row (#2450). The
      // second filter is Overdue rather than the reference's APAC lane rule: a lane rule travels
      // as a compact JSON URL param, and the panel's selected-row treatment is the same.
      const renewal = REDESIGN_BOARD.labels.find((l) => l.name === 'Renewal')!
      await openBoard(page, 'dark', `?f_labels=${renewal.id}&f_due=overdue`)
      await page.getByRole('button', { name: /^Filter/ }).first().click()
      await expect(page.getByRole('dialog', { name: 'Filter' })).toBeVisible()
      await page.mouse.move(0, 0)
      await expectShot(page, 'board-menu-filter.png', SHOT)
    })

    test('overflow menu', async ({ page }) => {
      await openBoard(page, 'dark')
      await page.getByRole('button', { name: 'More board actions' }).click()
      await expect(page.getByRole('menu')).toBeVisible()
      await page.mouse.move(0, 0)
      await expectShot(page, 'board-menu-more.png', SHOT)
    })
  })

  // Board states (#2394): loading, filter matches nothing, offline, load error and view only. The
  // empty state is `board-state-empty.png` above. Each is held in place by a request or socket that
  // never answers, or by a fixed URL param, so the frame is stable. components.png and
  // stages-settings.png are not captured here because they are a component sheet and a settings panel,
  // not board states. The Stage settings visual match to stages-settings.png stays open under #2278;
  // components.png has no capture yet.
  // Known remaining divergence from the reference (#2450, #2389 landed): the offline banner stays amber
  // while reconnecting on purpose (#2342, danger only once failed), and the Filter panel's second active
  // filter is Overdue, not the reference's APAC lane rule. Column names truncate on one line with the
  // collapse chevron shown on hover or focus, as the reference draws them. Known baseline limit: bold lead-ins
  // ("View only.", "The board didn't load.", the no-match line) and font-semibold column names render at regular
  // weight, because the CI image's `system-ui` resolves to WenQuanYi Zen Hei, which has no bold face
  // (`fc-match 'system-ui:bold'`). Bold is asserted by unit tests; the baselines cannot show it.
  test.describe('desktop 1440 board states', () => {
    test.use({ viewport: { width: 1440, height: 900 } })

    async function prime(page: Page) {
      await page.clock.setFixedTime(new Date(REDESIGN_NOW))
      await page.addInitScript(() => {
        window.localStorage.setItem('user:prefs:theme', 'dark')
      })
      await routeAuth(page)
    }

    test('loading skeleton', async ({ page }) => {
      await prime(page)
      await routeBoard(page, REDESIGN_BOARD as unknown as Parameters<typeof routeBoard>[1])
      // Held: the board request is never answered, so the skeleton stays.
      await page.route(`**/api/v1/boards/${REDESIGN_BOARD.id}/full/`, () => new Promise(() => {}))
      await page.goto(`/boards/${REDESIGN_BOARD.id}`)
      await expect(page.getByTestId('board-skeleton')).toBeVisible({ timeout: 15_000 })
      await expectShot(page, 'board-state-loading.png', SHOT)
    })

    test('filter matches nothing', async ({ page }) => {
      await prime(page)
      await routeBoard(page, { ...REDESIGN_BOARD, cards: REDESIGN_BOARD.cards.map((c) => ({ ...c, due_date: null })) } as unknown as Parameters<typeof routeBoard>[1])
      await page.goto(`/boards/${REDESIGN_BOARD.id}?show=due_soon`)
      await expect(page.getByTestId('board-no-match')).toContainText('No cards are due soon', { timeout: 15_000 })
      await page.evaluate(() => document.fonts.ready)
      await expectShot(page, 'board-state-no-match.png', SHOT)
    })

    test('offline', async ({ page }) => {
      await prime(page)
      await routeBoard(page, REDESIGN_BOARD as unknown as Parameters<typeof routeBoard>[1])
      // Every connection closes abnormally, so the status stays "reconnecting" (the retry never lands).
      await page.routeWebSocket(`**/ws/boards/${REDESIGN_BOARD.id}/`, (ws) => { ws.close({ code: 1006 }) })
      await page.goto(`/boards/${REDESIGN_BOARD.id}`)
      await expect(page.getByTestId('board-offline-banner')).toBeVisible({ timeout: 15_000 })
      await page.evaluate(() => document.fonts.ready)
      await expectShot(page, 'board-state-offline.png', SHOT)
    })

    test('load error', async ({ page }) => {
      await prime(page)
      await routeBoard(page, REDESIGN_BOARD as unknown as Parameters<typeof routeBoard>[1])
      await page.route(`**/api/v1/boards/${REDESIGN_BOARD.id}/full/`, (route) =>
        route.fulfill({ status: 500, contentType: 'application/json', body: '{}' }),
      )
      await page.goto(`/boards/${REDESIGN_BOARD.id}`)
      await expect(page.getByTestId('board-load-error')).toBeVisible({ timeout: 15_000 })
      await expectShot(page, 'board-state-error.png', SHOT)
    })

    test('view only', async ({ page }) => {
      await prime(page)
      await routeBoard(page, { ...REDESIGN_BOARD, current_user_role: 'viewer' } as unknown as Parameters<typeof routeBoard>[1])
      await page.goto(`/boards/${REDESIGN_BOARD.id}`)
      await expect(page.getByTestId('board-view-only')).toBeVisible({ timeout: 15_000 })
      await expect(page.locator('[data-card-id]').first()).toBeVisible()
      await page.evaluate(() => document.fonts.ready)
      await expectShot(page, 'board-state-view-only.png', SHOT)
    })
  })

  test.describe('phone 390', () => {
    test.use({ viewport: { width: 390, height: 844 } })

    test('board phone', async ({ page }) => {
      await openBoard(page, 'dark')
      // The reference shows the gated stage (Discovery) with its sub-column control.
      await page.getByRole('tab', { name: /^Discovery,/ }).click()
      await expect(page.getByTestId('phone-sub-column-switcher')).toBeVisible()
      await expectShot(page, 'board-phone.png', { ...SHOT, fullPage: true })
    })
  })
})
