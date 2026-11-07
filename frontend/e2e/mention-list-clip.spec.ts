import { test, expect } from '@playwright/test'
import { routeAuth, routeBoard } from './helpers'
import { BOARD_FULL, BOARD_USER, CARD } from './fixtures/board'

// #2092 — the @-mention suggestion list was `absolute bottom-full` inside the
// card sheet's scrolling body, so it clipped near the top of a short sheet.
// jsdom does not clip, so this hit-tests in a real browser at 480px high.

const VIEWPORT_H = 480

test('the @-mention list is fixed, in the viewport, topmost, and focus stays in the textarea', async ({ page }) => {
  const members = Array.from({ length: 8 }, (_, i) => ({
    id: i + 1,
    user: i === 0 ? BOARD_USER : { id: i + 1, username: `member${i}`, display_name: `Member ${i}`, avatar_url: '' },
    role: i === 0 ? ('admin' as const) : ('member' as const),
    is_moderator: false,
    joined_at: '2026-01-01T00:00:00Z',
  }))
  for (const path of ['movements', 'comments', 'activity', 'checklist', 'attachments', 'relations', 'blocks']) {
    await page.route(`**/api/v1/boards/${BOARD_FULL.id}/cards/${CARD.id}/${path}/`, (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) }),
    )
  }
  await page.route(`**/api/v1/boards/${BOARD_FULL.id}/cards/${CARD.id}/timeline/**`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ count: 0, next: null, results: [] }) }),
  )
  await page.setViewportSize({ width: 1600, height: VIEWPORT_H })
  await routeAuth(page)
  await routeBoard(page, { ...BOARD_FULL, members } as unknown as typeof BOARD_FULL)
  await page.goto(`/boards/${BOARD_FULL.id}`)
  await page.getByText(CARD.title).first().click()
  await expect(page.locator('[role="dialog"]')).toBeVisible({ timeout: 5_000 })

  const box = page.getByPlaceholder(/add a comment/i)
  await box.scrollIntoViewIfNeeded()
  await box.click()
  await box.pressSequentially('@')
  const first = page.getByText('@member1', { exact: true })
  await expect(first).toBeVisible()
  const list = first.locator('xpath=ancestor::div[contains(@class,"z-[60]")]')
  expect(await list.evaluate((n) => getComputedStyle(n).position)).toBe('fixed')

  const bb = await list.boundingBox()
  expect(bb!.y).toBeGreaterThanOrEqual(0)
  expect(bb!.y + bb!.height).toBeLessThanOrEqual(VIEWPORT_H)
  for (const el of [first, page.getByText('@member5', { exact: true })]) {
    const hit = await el.evaluate((node) => {
      const r = node.getBoundingClientRect()
      const h = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
      return h !== null && node.contains(h)
    })
    expect(hit).toBe(true)
  }
  await expect(box).toBeFocused()

  // Escape closes the list, not the sheet.
  await page.keyboard.press('Escape')
  await expect(list).toHaveCount(0)
  await expect(page.locator('[role="dialog"]')).toBeVisible()
})
