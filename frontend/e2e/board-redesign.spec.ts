import { test, expect, type Page } from '@playwright/test'
import { routeAuth, routeBoard } from './helpers'
import { REDESIGN_BOARD, REDESIGN_NOW } from './fixtures/redesign-board'

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
  await page.goto(`/boards/${REDESIGN_BOARD.id}${search}`)
  await expect(page.locator('[data-card-id]').first()).toBeVisible({ timeout: 15_000 })
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme)
  await page.evaluate(() => document.fonts.ready)
}

test.describe('board redesign baseline', () => {
  test.describe('desktop 1440', () => {
    test.use({ viewport: { width: 1440, height: 900 } })

    for (const theme of ['light', 'dark'] as const) {
      test(`board ${theme}`, async ({ page }) => {
        await openBoard(page, theme, '?preset=classic')
        await expect(page).toHaveScreenshot(`board-${theme}.png`, { ...SHOT, fullPage: true })
      })
    }

    test('a ?preset=classic link loads the redesigned board', async ({ page }) => {
      await openBoard(page, 'light', '?preset=classic')
      await expect(page.getByRole('button', { name: /^Preset: Classic/ })).toHaveCount(0) // picker lives in the View menu
      await expect(page.getByTestId('board-header-row')).toBeVisible()
      await expect(page.locator('[data-card-id]').first()).toBeVisible()
    })

    test('collapsed lane', async ({ page }) => {
      await openBoard(page, 'light')
      await page.getByRole('button', { name: /Collapse .*North America/ }).first().click()
      await expect(page).toHaveScreenshot('board-collapsed.png', SHOT)
    })

    test('hover peek', async ({ page }) => {
      await openBoard(page, 'light')
      await page.locator('[data-card-id]').first().hover()
      await expect(page.getByRole('tooltip').first()).toBeVisible({ timeout: 3_000 })
      await expect(page).toHaveScreenshot('board-peek.png', SHOT)
    })

    test('activity drawer', async ({ page }) => {
      await openBoard(page, 'light')
      await page.getByRole('button', { name: 'Open activity drawer' }).click()
      await expect(page.getByRole('complementary', { name: 'Activity' })).toBeVisible()
      await expect(page).toHaveScreenshot('board-activity.png', SHOT)
    })

    test('view menu', async ({ page }) => {
      await openBoard(page, 'light')
      await page.getByRole('button', { name: /^View/ }).first().click()
      await expect(page.getByText('Preset', { exact: true }).first()).toBeVisible()
      await expect(page).toHaveScreenshot('board-menu-view.png', SHOT)
    })

    test('empty board state', async ({ page }) => {
      await page.clock.setFixedTime(new Date(REDESIGN_NOW))
      await routeAuth(page)
      await routeBoard(page, { ...REDESIGN_BOARD, cards: [] } as unknown as Parameters<typeof routeBoard>[1])
      await page.goto(`/boards/${REDESIGN_BOARD.id}`)
      await expect(page.getByTestId('board-empty-state')).toBeVisible({ timeout: 15_000 })
      await expect(page).toHaveScreenshot('board-state-empty.png', SHOT)
    })
  })

  test.describe('phone 390', () => {
    test.use({ viewport: { width: 390, height: 844 } })

    test('board phone', async ({ page }) => {
      await openBoard(page, 'light')
      await expect(page).toHaveScreenshot('board-phone.png', { ...SHOT, fullPage: true })
    })
  })
})
