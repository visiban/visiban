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

  // #2508: opening the filter row with F pushes the board down under a still
  // pointer, so the card never gets a mouseleave; the peek must close anyway
  // and must not sit over the filter row it just opened.
  test('pressing F to open the filter row dismisses a visible peek', async ({ page }) => {
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
