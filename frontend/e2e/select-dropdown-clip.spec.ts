import { test, expect } from '@playwright/test'
import { routeAuth, routeBoard } from './helpers'
import { BOARD_FULL, BOARD_USER, CARD } from './fixtures/board'

// #1480 — SelectDropdown's menu used to render `absolute` inside the Board
// Settings modal's `overflow-y-auto` body, so a role dropdown on the last
// Members row was clipped. jsdom does not clip, so this asserts, in a real
// browser, that the *last* option is the topmost element at its own center.

const members = Array.from({ length: 10 }, (_, i) => ({
  id: i + 1,
  user: i === 0 ? BOARD_USER : { id: i + 1, username: `member${i}`, display_name: `Member ${i}`, avatar_url: '' },
  role: i === 0 ? ('admin' as const) : ('member' as const),
  is_moderator: false,
  joined_at: '2026-01-01T00:00:00Z',
}))

async function openMembersTab(page: import('@playwright/test').Page) {
  await page.setViewportSize({ width: 1280, height: 480 })
  await routeAuth(page)
  await routeBoard(page, { ...BOARD_FULL, members } as unknown as typeof BOARD_FULL)
  await page.goto(`/boards/${BOARD_FULL.id}`)
  await expect(page.getByText(CARD.title).first()).toBeVisible({ timeout: 10_000 })
  await page.keyboard.press('Control+,')
  await expect(page.getByRole('button', { name: /^Members \(/ })).toHaveAttribute('aria-current', 'true')
}

test.describe('SelectDropdown inside a scrolling modal (#1480)', () => {
  test('the last Members row role dropdown shows every option, hit-testable', async ({ page }) => {
    await openMembersTab(page)
    const trigger = page.getByRole('combobox').last()
    await trigger.scrollIntoViewIfNeeded()
    await trigger.click()
    const options = page.getByRole('option')
    await expect(options).toHaveCount(4)
    const last = options.last()
    await expect(last).toBeVisible()
    const hit = await last.evaluate((el) => {
      const r = el.getBoundingClientRect()
      const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
      return top !== null && el.contains(top)
    })
    expect(hit).toBe(true)
    // Fully inside the viewport, not just topmost.
    const box = await last.boundingBox()
    expect(box!.y + box!.height).toBeLessThanOrEqual(480)
  })

  test('Escape closes only the menu, not the modal', async ({ page }) => {
    await openMembersTab(page)
    const trigger = page.getByRole('combobox').last()
    // Scroll first: a scroll after opening is an outside scroll and dismisses the menu.
    await trigger.scrollIntoViewIfNeeded()
    await trigger.click()
    await expect(page.getByRole('listbox')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByRole('listbox')).toHaveCount(0)
    await expect(page.getByRole('button', { name: /^Members \(/ })).toBeVisible()
  })
})
