import { test, expect } from '@playwright/test'
import { routeAuth, routeBoard } from './helpers'
import { BOARD_FULL, CARD } from './fixtures/board'

test.describe('card peek popover', () => {
  test.beforeEach(async ({ page }) => {
    await routeAuth(page)
    await routeBoard(page)
  })

  test('600ms hover reveals a tooltip-role popover', async ({ page }) => {
    await page.goto(`/boards/${BOARD_FULL.id}`)
    const cardText = page.getByText(CARD.title).first()
    await expect(cardText).toBeVisible({ timeout: 10_000 })

    await cardText.hover()
    // The peek popover has role="tooltip" and renders the card description.
    // A 600ms timer drives the reveal, so give the locator enough slack.
    const peek = page.getByRole('tooltip').filter({ hasText: CARD.description })
    await expect(peek).toBeVisible({ timeout: 3_000 })
  })

  test('moving the mouse away dismisses the peek popover', async ({ page }) => {
    await page.goto(`/boards/${BOARD_FULL.id}`)
    const cardText = page.getByText(CARD.title).first()
    await expect(cardText).toBeVisible({ timeout: 10_000 })

    await cardText.hover()
    const peek = page.getByRole('tooltip').filter({ hasText: CARD.description })
    await expect(peek).toBeVisible({ timeout: 3_000 })

    await page.mouse.move(0, 0)
    await expect(peek).toHaveCount(0, { timeout: 2_000 })
  })
})
