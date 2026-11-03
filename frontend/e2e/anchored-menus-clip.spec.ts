import { test, expect, type Page, type Locator } from '@playwright/test'
import { routeAuth, routeBoard } from './helpers'
import { BOARD_FULL, BOARD_USER, CARD } from './fixtures/board'

// #1482 — CheckboxDropdown, ActivityFilterDropdown and SavedFiltersDropdown
// rendered `absolute top-full`, so a scroll region or `overflow-hidden`
// ancestor (the card sheet's Activity tab) clipped them, and a long list ran
// off the viewport. jsdom does not clip, so this hit-tests in a real browser.

const VIEWPORT_H = 480

async function topmostAtCenter(el: Locator): Promise<boolean> {
  return el.evaluate((node) => {
    const r = node.getBoundingClientRect()
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
    return hit !== null && node.contains(hit)
  })
}

async function expectInViewport(el: Locator) {
  const box = await el.boundingBox()
  expect(box!.y).toBeGreaterThanOrEqual(0)
  expect(box!.y + box!.height).toBeLessThanOrEqual(VIEWPORT_H)
}

async function openBoard(page: Page, board = BOARD_FULL, width = 1440) {
  await page.setViewportSize({ width, height: VIEWPORT_H })
  await routeAuth(page)
  await routeBoard(page, board as unknown as typeof BOARD_FULL)
  await page.goto(`/boards/${BOARD_FULL.id}`)
  await expect(page.getByText((board.cards[0] as { title: string }).title).first()).toBeVisible({ timeout: 10_000 })
}

test.describe('anchored filter menus (#1482)', () => {
  test('Activity tab filter menu is fully visible and hit-testable inside the card sheet', async ({ page }) => {
    // Every per-card fetch needs a mock: an unmocked one reaches the dev backend,
    // 401s and bounces the page to sign-in (see card-detail.spec.ts).
    for (const path of ['movements', 'comments', 'activity', 'checklist', 'attachments', 'relations', 'blocks']) {
      await page.route(`**/api/v1/boards/${BOARD_FULL.id}/cards/${CARD.id}/${path}/`, (route) =>
        route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) }),
      )
    }
    await page.route(`**/api/v1/boards/${BOARD_FULL.id}/cards/${CARD.id}/timeline/**`, (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ count: 0, next: null, results: [] }) }),
    )
    await openBoard(page, BOARD_FULL, 1600)
    await page.getByText(CARD.title).first().click()
    await expect(page.locator('[role="dialog"]')).toBeVisible({ timeout: 5_000 })
    await page.getByRole('tab', { name: /activity/i }).click()
    await page.locator('[role="dialog"]').getByRole('button', { name: /^filter/i }).click()
    const menu = page.getByRole('group', { name: 'Filter' })
    await expect(menu).toBeVisible()
    const reset = menu.getByRole('button', { name: /reset to default/i })
    await expect(reset).toBeVisible()
    expect(await topmostAtCenter(reset)).toBe(true)
    await expectInViewport(menu)
    // Escape closes the menu, not the card sheet.
    await page.keyboard.press('Escape')
    await expect(menu).toHaveCount(0)
    await expect(page.locator('[role="dialog"]')).toBeVisible()
  })

  test('a long Assignee list is capped to the viewport, scrolls, and stays hit-testable', async ({ page }) => {
    const members = Array.from({ length: 60 }, (_, i) => ({
      id: i + 1,
      user: i === 0 ? BOARD_USER : { id: i + 1, username: `member${i}`, display_name: `Member ${i}`, avatar_url: '' },
      role: i === 0 ? ('admin' as const) : ('member' as const),
      is_moderator: false,
      joined_at: '2026-01-01T00:00:00Z',
    }))
    const cards = members.map((m, i) => ({ ...CARD, id: 100 + i, title: `Card ${i}`, assignee: m.user }))
    await openBoard(page, { ...BOARD_FULL, members, cards } as unknown as typeof BOARD_FULL)
    await page.getByRole('button', { name: /^filters/i }).click()
    await page.getByRole('button', { name: /\+ filter/i }).click()
    await page.getByRole('checkbox', { name: /assignee/i }).check()
    await page.keyboard.press('Escape')
    await page.getByRole('button', { name: /^assignee/i }).click()
    const menu = page.locator('[role="group"][aria-label="Assignee"]')
    await expect(menu).toBeVisible()
    await expectInViewport(menu)
    const first = menu.getByRole('checkbox').first()
    expect(await topmostAtCenter(first)).toBe(true)
    // The last option is reachable by scrolling inside the capped panel.
    const last = menu.getByRole('checkbox').last()
    await last.scrollIntoViewIfNeeded()
    expect(await topmostAtCenter(last)).toBe(true)
  })

  test('Saved filters menu opens as a fixed, topmost panel', async ({ page }) => {
    await openBoard(page)
    await page.getByRole('button', { name: /^filters/i }).click()
    await page.getByRole('button', { name: 'Saved filters' }).click()
    const empty = page.getByText(/no saved filters yet/i)
    await expect(empty).toBeVisible()
    expect(await topmostAtCenter(empty)).toBe(true)
    await expectInViewport(empty)
  })
})
