import { test, expect } from '@playwright/test'
import { routeAuth, routeBoard } from './helpers'
import { BOARD_DENSE, CARD } from './fixtures/board'

// jsdom cannot show paint order. CardItem's root is `relative z-0`, so a z-auto
// built-in count badge paints under the first card (#1162). elementFromPoint at
// the badge's center is the real proof it is on top.
for (const theme of ['light', 'dark'] as const) {
  test(`built-in card-count badge paints above the cards (${theme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: theme })
    await routeAuth(page)
    await routeBoard(page, BOARD_DENSE)
    await page.goto(`/boards/${BOARD_DENSE.id}`)
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme)
    await expect(page.locator('[data-card-id]').filter({ hasText: CARD.title })).toBeVisible({ timeout: 10_000 })
    const badge = page.getByTestId('cell-card-count').first()
    await expect(badge).toBeVisible()
    // The badge is pointer-events-none in production, which hides it from
    // elementFromPoint; enable hit-testing for the probe only.
    const hit = await badge.evaluate((el) => {
      const node = el as HTMLElement
      node.style.pointerEvents = 'auto'
      const r = node.getBoundingClientRect()
      const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
      return top === node
    })
    expect(hit).toBe(true)
  })
}
