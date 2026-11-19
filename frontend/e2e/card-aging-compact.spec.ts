import { test, expect, type Page, type Locator } from '@playwright/test'
import { routeAuth } from './helpers'
import { BOARD_FULL, CARD, CARD_STALE } from './fixtures/board'

// #1843 — where a stale card has no `Stale Nd` status line (every compact card), its
// title starts with the AgingCue stage glyph instead. It
// must not change the card's height (the issue's constraint), so the title's
// line box is measured, not just the glyph's presence.
// #1863 — the yellow warning stage never shows the badge, so it gets the same
// glyph with a hollow shortest bar, under the same height constraint.

// Idle 10 days against BOARD_FULL's 7-day threshold: the 1–2x stage. Relative
// to now so the stage cannot drift with the wall clock.
const CARD_STALE_1X = {
  ...CARD,
  id: 3,
  uid: 'card000003c',
  title: 'Aging task',
  position: 2,
  is_stale: true,
  last_moved_at: new Date(Date.now() - 10 * 86_400_000).toISOString(),
}

// Idle 5 days against the 7-day threshold at 50%: the warning stage (3.5 to
// under 7 days). Not near either edge, so the relative fixture cannot drift out.
const CARD_WARNING = {
  ...CARD,
  id: 4,
  uid: 'card000004c',
  title: 'Warning task',
  position: 3,
  is_stale: false,
  last_moved_at: new Date(Date.now() - 5 * 86_400_000).toISOString(),
}

const WARNING_CUE_NAME = 'Idle 5 days, approaching the stale threshold'

const CARDS = [CARD, CARD_STALE, CARD_STALE_1X, CARD_WARNING]

async function openBoard(page: Page, { compact, density }: { compact: boolean; density: 'comfortable' | 'standard' | 'dense' }) {
  await routeAuth(page)
  if (compact) {
    await page.addInitScript(() => {
      localStorage.setItem('user:prefs:card-layout', 'compact')
    })
  }
  const board = { ...BOARD_FULL, card_density: density, cards: CARDS }
  await page.route(`**/api/v1/boards/${BOARD_FULL.id}/full/`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(board) }),
  )
  await page.route(`**/api/v1/boards/${BOARD_FULL.id}/cards/`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ count: CARDS.length, results: CARDS }) }),
  )
  await page.route(`**/api/v1/boards/${BOARD_FULL.id}/saved-filters/`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) }),
  )
  await page.routeWebSocket(`**/ws/boards/${BOARD_FULL.id}/`, (ws) => {
    ws.send(JSON.stringify({ event: 'connected', data: {} }))
  })
  await page.goto(`/boards/${BOARD_FULL.id}`)
}

const titleOf = (page: Page, title: string) => page.locator('p', { hasText: title }).first()

/** The glyph sits inside the single title line box: same height as the fresh title and as its own line-height. */
async function expectNoHeightChange(stale: Locator, fresh: Locator) {
  const staleBox = await stale.boundingBox()
  const freshBox = await fresh.boundingBox()
  const lineHeight = await stale.evaluate((el) => parseFloat(getComputedStyle(el).lineHeight))
  expect(staleBox!.height).toBeCloseTo(freshBox!.height, 1)
  expect(staleBox!.height).toBeCloseTo(lineHeight, 1)
}

test.describe('card aging cue where no stale status line is shown', () => {
  test('compact cards show the stage glyph without growing the title line', async ({ page }) => {
    await openBoard(page, { compact: true, density: 'comfortable' })
    const fresh = titleOf(page, CARD.title)
    const severe = titleOf(page, CARD_STALE.title)
    const aging = titleOf(page, CARD_STALE_1X.title)
    const warning = titleOf(page, CARD_WARNING.title)
    await expect(severe).toBeVisible({ timeout: 10_000 })

    // CARD_STALE last moved 2026-04-01 against a 7-day threshold: far past 3x.
    await expect(severe.getByRole('img', { name: /^Idle \d+ days, at least 3 times the stale threshold$/ })).toBeVisible()
    await expect(aging.getByRole('img', { name: 'Idle 10 days, past the stale threshold' })).toBeVisible()
    // Compact has no status line; the glyph is the at-a-glance cue.
    await expect(page.getByTestId('card-status-line')).toHaveCount(0)
    await expect(fresh.locator('svg[data-aging-cue]')).toHaveCount(0)

    await expect(warning.getByRole('img', { name: WARNING_CUE_NAME })).toBeVisible()
    await expect(warning.locator('svg[data-aging-cue="warning"] rect[fill="none"]')).toHaveCount(1)

    await expectNoHeightChange(severe, fresh)
    await expectNoHeightChange(aging, fresh)
    await expectNoHeightChange(warning, fresh)
  })

  test('non-compact dense cards show the stage glyph without growing the title line', async ({ page }) => {
    await openBoard(page, { compact: false, density: 'dense' })
    const fresh = titleOf(page, CARD.title)
    const severe = titleOf(page, CARD_STALE.title)
    const warning = titleOf(page, CARD_WARNING.title)
    await expect(severe).toBeVisible({ timeout: 10_000 })

    // The one-row dense face carries a stale card's stage in its short status ("41d", with
    // "Stale " as screen-reader text) in place of the title glyph, so the cue is not doubled
    // (#2272, #2279). The warning stage has no status, so it keeps the title glyph.
    const severeCard = page.locator('[data-card-id]').filter({ hasText: CARD_STALE.title })
    await expect(severeCard.getByTestId('card-status-line')).toHaveText(/^Stale \d+d$/)
    await expect(severe.locator('svg[data-aging-cue]')).toHaveCount(0)
    await expect(warning.getByRole('img', { name: WARNING_CUE_NAME })).toBeVisible()
    const warningCard = page.locator('[data-card-id]').filter({ hasText: CARD_WARNING.title })
    await expect(warningCard.getByTestId('card-status-line')).toHaveCount(0)
    await expectNoHeightChange(severe, fresh)
    await expectNoHeightChange(warning, fresh)
  })

  // #1863: a warning card never gets the stale status line, so the glyph shows on
  // non-compact comfortable and standard cards too, where stale cards show the status line.
  for (const density of ['comfortable', 'standard'] as const) {
    test(`non-compact ${density} warning cards show the hollow-bar glyph without growing the title line`, async ({ page }) => {
      await openBoard(page, { compact: false, density })
      const fresh = titleOf(page, CARD.title)
      const warning = titleOf(page, CARD_WARNING.title)
      await expect(warning).toBeVisible({ timeout: 10_000 })

      await expect(warning.getByRole('img', { name: WARNING_CUE_NAME })).toBeVisible()
      await expect(fresh.locator('svg[data-aging-cue]')).toHaveCount(0)
      await expectNoHeightChange(warning, fresh)
    })
  }
})
