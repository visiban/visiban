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

  // #2508: a hover must end on a key press even though the pointer never
  // moves and no layout shifts. Browsers send no leave event for a key, so
  // only the keydown guard can close the peek; this fails without it
  // (verified red with the listener removed). Not Escape: an app-level Escape
  // handler closes the peek on its own, so Escape would pass without the guard.
  test('a non-modifier key with a still pointer dismisses a visible peek', async ({ page }) => {
    await page.goto(`/boards/${BOARD_FULL.id}`)
    const cardText = page.getByText(CARD.title).first()
    await expect(cardText).toBeVisible({ timeout: 10_000 })

    await cardText.hover()
    const peek = page.getByRole('tooltip').filter({ hasText: CARD.description })
    await expect(peek).toBeVisible({ timeout: 3_000 })

    await page.keyboard.press('q')
    await expect(peek).toHaveCount(0, { timeout: 2_000 })
  })

  // #2508 regression guard for the reported filter-row path (F opens the
  // filter row and pushes the board down under a still pointer). Chromium
  // usually self-heals after a layout shift, so this does NOT prove the
  // mechanism; the Escape test above and the Vitest guard tests do.
  test('regression guard: pressing F to open the filter row leaves no peek over it', async ({ page }) => {
    await page.goto(`/boards/${BOARD_FULL.id}`)
    const cardText = page.getByText(CARD.title).first()
    await expect(cardText).toBeVisible({ timeout: 10_000 })

    await cardText.hover()
    const peek = page.getByRole('tooltip').filter({ hasText: CARD.description })
    await expect(peek).toBeVisible({ timeout: 3_000 })

    await page.keyboard.press('f')
    await expect(peek).toHaveCount(0, { timeout: 2_000 })
    // The filter row opened and is usable with the pointer still in place.
    await expect(page.getByRole('button', { name: '+ Filter' })).toBeVisible()
    await page.getByRole('button', { name: '+ Filter' }).click()
    await expect(page.getByRole('checkbox', { name: 'Label' })).toBeVisible()
    await expect(peek).toHaveCount(0)
  })
})
