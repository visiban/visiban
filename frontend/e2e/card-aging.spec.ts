import { test, expect, type Page } from '@playwright/test'
import { routeAuth } from './helpers'
import { BOARD_FULL, CARD, CARD_STALE } from './fixtures/board'

// Custom board fixture: include both a fresh card and a stale one so we can
// assert the overlay appears on the stale card only.
async function openBoard(page: Page, cards: unknown[]) {
  await routeAuth(page)
  const board = { ...BOARD_FULL, cards }
  await page.route(`**/api/v1/boards/${BOARD_FULL.id}/full/`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(board) }),
  )
  await page.route(`**/api/v1/boards/${BOARD_FULL.id}/cards/`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ count: cards.length, results: cards }) }),
  )
  await page.route(`**/api/v1/boards/${BOARD_FULL.id}/saved-filters/`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) }),
  )
  await page.routeWebSocket(`**/ws/boards/${BOARD_FULL.id}/`, (ws) => {
    ws.send(JSON.stringify({ event: 'connected', data: {} }))
  })
  await page.goto(`/boards/${BOARD_FULL.id}`)
}

test.describe('card aging indicator', () => {
  test('long-idle card renders the darkest aging stage with idle days', async ({ page }) => {
    await openBoard(page, [CARD, CARD_STALE])
    await expect(page.getByText(CARD_STALE.title).first()).toBeVisible({ timeout: 10_000 })

    // Locate the stale card's container and assert the overlay element exists.
    // CARD_STALE last moved 2026-04-01 against a 7-day threshold, so it is far
    // past 3x and sits in the darkest stage of the ramp (#1841): a
    // `div[aria-hidden="true"]` carrying `bg-stale-severe/20` plus an inset
    // ring, inside the card root (the card's outer wrapper uses `rounded-md`).
    // The ratio only grows with the wall clock, so the stage cannot drift down.
    const staleCard = page.getByText(CARD_STALE.title).first().locator('xpath=ancestor::div[contains(@class, "rounded-md")][1]')
    await expect(staleCard.locator('div.bg-stale-severe\\/20.ring-inset').first()).toBeVisible()

    // The status line states the idle days, not just "Stale" (#2272).
    await expect(staleCard.getByTestId('card-status-line')).toHaveText(/^Stale \d+d$/)

    // Regression guard: the fresh card has no aging overlay at all.
    const freshCard = page.getByText(CARD.title).first().locator('xpath=ancestor::div[contains(@class, "rounded-md")][1]')
    await expect(freshCard.locator('div.pointer-events-none.inset-0')).toHaveCount(0)
  })

  // #1844: on a tinted card the metadata row rescopes fg-tertiary (and the other
  // metadata tokens) to on-tint values via `.card-aging-meta`. jsdom cannot
  // resolve CSS custom properties, so this is the only check that the rescope
  // reaches the rendered color. The untinted card must keep plain fg-tertiary.
  for (const scheme of ['light', 'dark'] as const) {
    test(`${scheme}: tinted card metadata uses the on-tint tone, untinted keeps fg-tertiary`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme })
      await openBoard(page, [
        { ...CARD, checklist_total: 3, checklist_done: 1 },
        { ...CARD_STALE, checklist_total: 2, checklist_done: 1 },
      ])
      await expect(page.getByText('✓1/2').first()).toBeVisible({ timeout: 10_000 })
      await expect(page.locator('html')).toHaveAttribute('data-theme', scheme)
      const rootVar = (name: string) =>
        page.evaluate((n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim(), name)
      const asRgb = (v: string) => `rgb(${v.split(/\s+/).join(', ')})`
      await expect(page.getByText('✓1/2').first()).toHaveCSS('color', asRgb(await rootVar('--muted-on-tint')))
      await expect(page.getByText('✓1/3').first()).toHaveCSS('color', asRgb(await rootVar('--fg-tertiary')))
    })
  }
})
