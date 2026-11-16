import { test, expect } from '@playwright/test'
import { routeAuth, routeBoard } from './helpers'
import { BOARD_FULL, CARD } from './fixtures/board'

// Phone layout (#2277): one column at a time, lanes stacked, 44px targets.
test.describe('board phone layout', () => {
  test.use({ viewport: { width: 390, height: 844 } })

  test.beforeEach(async ({ page }) => {
    await routeAuth(page)
    await routeBoard(page)
    await page.goto(`/boards/${BOARD_FULL.id}`)
    await expect(page.getByTestId('phone-board')).toBeVisible({ timeout: 10_000 })
  })

  test('switches columns and shows only the selected column\'s cards', async ({ page }) => {
    const switcher = page.getByTestId('phone-column-switcher')
    const todo = switcher.getByRole('tab', { name: /To Do/ })
    const done = switcher.getByRole('tab', { name: /Done/ })
    await expect(todo).toHaveAttribute('aria-selected', 'true')
    await expect(page.locator(`[data-card-id="${CARD.id}"]`)).toBeVisible()
    await done.click()
    await expect(done).toHaveAttribute('aria-selected', 'true')
    await expect(page.locator(`[data-card-id="${CARD.id}"]`)).toHaveCount(0)
  })

  test('collapses and expands a lane', async ({ page }) => {
    const lane = page.getByRole('button', { name: /Collapse lane/ })
    await expect(page.locator(`[data-card-id="${CARD.id}"]`)).toBeVisible()
    await lane.click()
    await expect(page.locator(`[data-card-id="${CARD.id}"]`)).toHaveCount(0)
    await page.getByRole('button', { name: /Expand lane/ }).click()
    await expect(page.locator(`[data-card-id="${CARD.id}"]`)).toBeVisible()
  })

  test('has no sideways page scroll and 44px targets', async ({ page }) => {
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
    expect(overflow).toBeLessThanOrEqual(0)
    for (const loc of [
      page.getByTestId('phone-column-switcher').getByRole('tab').first(),
      page.getByRole('button', { name: /Collapse lane/ }),
      page.locator('[data-show-chip="all"]'),
    ]) {
      const box = await loc.boundingBox()
      expect(Math.min(box!.width, box!.height)).toBeGreaterThanOrEqual(44)
    }
  })

  test('tapping a card opens the peek sheet, which carries the Move action', async ({ page }) => {
    await page.route(/\/api\/v1\/boards\/\d+\/cards\/\d+\/movements\/(\?.*)?$/, (r) =>
      r.fulfill({ status: 200, contentType: 'application/json', body: '[]' }))
    await page.locator(`[data-card-id="${CARD.id}"]`).click()
    await expect(page.getByTestId('card-peek-sheet')).toBeVisible()
    await expect(page.getByRole('button', { name: /^Move/ }).first()).toBeVisible()
  })
})
