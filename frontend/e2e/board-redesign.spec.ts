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
 * frontend/CLAUDE.md § Board redesign baseline for how to update them.
 */
const SHOT = { animations: 'disabled' as const, maxDiffPixelRatio: 0.01 }

async function openBoard(page: Page, theme: 'light' | 'dark', search = '') {
  await page.clock.setFixedTime(new Date(REDESIGN_NOW))
  await page.addInitScript((t) => {
    window.localStorage.setItem('user:prefs:theme', t)
    // The reference mocks show the board alone; collapse the app sidebar to match.
    window.localStorage.setItem('user:prefs:sidebar-collapsed', 'true')
  }, theme)
  await routeAuth(page)
  await routeBoard(page, REDESIGN_BOARD as unknown as Parameters<typeof routeBoard>[1])
  // The activity drawer lists live `card.moved` events (it keeps no history of its own), so
  // replay the sample's moves over the socket after it connects: the reference shows seven.
  // Each event carries the card as it already is on the board, so the board does not change.
  await page.routeWebSocket(`**/ws/boards/${REDESIGN_BOARD.id}/`, (ws) => {
    ws.send(JSON.stringify({ event: 'connected', data: {} }))
    setTimeout(() => {
      for (const m of REDESIGN_MOVEMENTS) {
        const card = REDESIGN_BOARD.cards.find((c) => c.uid === m.card_uid)
        ws.send(JSON.stringify({
          event: 'card.moved',
          data: { card, movement: { from_column_name: m.from_column_name, to_column_name: m.to_column_name, user: m.moved_by } },
        }))
      }
    }, 1_000)
  })
  // The peek panel's history and time-in-column read the card's own movements.
  await page.route(`**/api/v1/boards/${REDESIGN_BOARD.id}/cards/*/movements/`, (route) => {
    const id = Number(route.request().url().match(/cards\/(\d+)\/movements/)?.[1])
    const uid = REDESIGN_BOARD.cards.find((c) => c.id === id)?.uid
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(REDESIGN_MOVEMENTS.filter((m) => m.card_uid === uid)),
    })
  })
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
        await expect(page).toHaveScreenshot(`board-${theme}.png`, { ...SHOT, fullPage: true })
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
      await expect(page).toHaveScreenshot('board-collapsed.png', SHOT)
    })

    test('hover peek is a tooltip, not a panel', async ({ page }) => {
      await openBoard(page, 'dark')
      await page.locator('[data-card-id]').first().hover()
      await expect(page.getByRole('tooltip').first()).toBeVisible({ timeout: 3_000 })
    })

    test('peek panel', async ({ page }) => {
      await openBoard(page, 'dark')
      // Shift+click opens the read-only peek panel the reference draws (#2358).
      await page.locator('[data-card-id]').first().click({ modifiers: ['Shift'] })
      await expect(page.getByRole('dialog', { name: /./ }).first()).toBeVisible()
      await expect(page.getByRole('button', { name: 'Close card peek' })).toBeVisible()
      await page.mouse.move(0, 0)
      await expect(page).toHaveScreenshot('board-peek.png', SHOT)
    })

    test('activity drawer', async ({ page }) => {
      await openBoard(page, 'dark')
      await page.getByRole('button', { name: 'Open activity drawer' }).click()
      await expect(page.getByRole('complementary', { name: 'Activity' })).toBeVisible()
      await expect(page.getByRole('complementary', { name: 'Activity' }).getByText(REDESIGN_MOVEMENTS[0].card_title)).toBeVisible()
      await page.mouse.move(720, 890) // off the toolbar, so no tooltip draws over the board
      await expect(page).toHaveScreenshot('board-activity.png', SHOT)
    })

    test('view menu', async ({ page }) => {
      await openBoard(page, 'dark')
      await page.getByRole('button', { name: /^View/ }).first().click()
      await expect(page.getByText('Preset', { exact: true }).first()).toBeVisible()
      await expect(page).toHaveScreenshot('board-menu-view.png', SHOT)
    })

    test('empty board state', async ({ page }) => {
      await page.addInitScript(() => {
        window.localStorage.setItem('user:prefs:theme', 'dark')
        window.localStorage.setItem('user:prefs:sidebar-collapsed', 'true')
      })
      await page.clock.setFixedTime(new Date(REDESIGN_NOW))
      await routeAuth(page)
      await routeBoard(page, { ...REDESIGN_BOARD, cards: [] } as unknown as Parameters<typeof routeBoard>[1])
      await page.goto(`/boards/${REDESIGN_BOARD.id}`)
      await expect(page.getByTestId('board-empty-state')).toBeVisible({ timeout: 15_000 })
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
      await expect(page).toHaveScreenshot('board-state-empty.png', SHOT)
    })
  })

  test.describe('phone 390', () => {
    test.use({ viewport: { width: 390, height: 844 } })

    test('board phone', async ({ page }) => {
      await openBoard(page, 'dark')
      // The reference shows the gated stage (Discovery) with its sub-column control.
      await page.getByRole('tab', { name: /^Discovery,/ }).click()
      await expect(page.getByTestId('phone-sub-column-switcher')).toBeVisible()
      await expect(page).toHaveScreenshot('board-phone.png', { ...SHOT, fullPage: true })
    })
  })
})
