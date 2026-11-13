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
    // Structural check that fails on the old in-flow menu: the panel is a
    // `fixed` child of <body>, so no scroll region can clip it.
    const panel = page.getByRole('group', { name: 'Saved filters' })
    expect(await panel.evaluate((n) => getComputedStyle(n).position)).toBe('fixed')
    expect(await panel.evaluate((n) => n.parentElement === document.body)).toBe(true)
  })

  // Marks the control that follows `trigger` in document order (outside any
  // anchored panel), so the test can assert focus lands on the real next control.
  async function markNextControl(page: Page, trigger: Locator) {
    await trigger.evaluate((node) => {
      const sel = 'button:not([disabled]),input:not([disabled]):not([type="hidden"]),a[href],select,textarea,[tabindex]:not([tabindex="-1"])'
      const all = Array.from(document.querySelectorAll<HTMLElement>(sel)).filter(
        (el) => !el.closest('[data-anchored-menu]') && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden',
      )
      const next = all[all.indexOf(node as HTMLElement) + 1]
      next.setAttribute('data-e2e-next', '1')
    })
    return page.locator('[data-e2e-next="1"]')
  }

  test('Saved filters: Shift+Tab off the first control returns to the trigger; Tab off the last lands on the next toolbar control', async ({ page }) => {
    await openBoard(page)
    await page.getByRole('button', { name: /^filters/i }).click()
    // An active filter enables "Save current filters", the panel's first control.
    await page.locator('[data-board-search="true"]').fill('task')
    const trigger = page.getByRole('button', { name: 'Saved filters' })
    const next = await markNextControl(page, trigger)
    await trigger.click()
    const panel = page.getByRole('group', { name: 'Saved filters' })
    await expect(panel).toBeVisible()
    await expect(page.getByRole('button', { name: /save current filters/i })).toBeFocused()
    await page.keyboard.press('Shift+Tab')
    await expect(panel).toHaveCount(0)
    await expect(trigger).toBeFocused()
    await trigger.click()
    await expect(panel).toBeVisible()
    const count = await panel.evaluate((n) => n.querySelectorAll('button:not([disabled]),input').length)
    for (let i = 0; i < count; i++) await page.keyboard.press('Tab')
    await expect(panel).toHaveCount(0)
    await expect(next).toBeFocused()
  })

  test('Facet menu: Tab-out keeps the facet mounted, so Shift+Tab lands on its trigger and Tab on the next control', async ({ page }) => {
    await openBoard(page)
    await page.getByRole('button', { name: /^filters/i }).click()
    await page.getByRole('button', { name: /\+ filter/i }).click()
    await page.getByRole('checkbox', { name: /label/i }).check()
    await page.keyboard.press('Escape')
    const trigger = page.getByRole('button', { name: /^label/i })
    await expect(trigger).toBeVisible()
    const next = await markNextControl(page, trigger)
    const panel = page.getByRole('group', { name: 'Label' })
    await trigger.click()
    await expect(panel).toBeVisible()
    await page.keyboard.press('Shift+Tab')
    await expect(panel).toHaveCount(0)
    await expect(trigger).toBeVisible()
    await expect(trigger).toBeFocused()
    await trigger.click()
    await expect(panel).toBeVisible()
    const count = await panel.evaluate((n) => n.querySelectorAll('input').length)
    for (let i = 0; i < count; i++) await page.keyboard.press('Tab')
    await expect(panel).toHaveCount(0)
    await expect(trigger).toBeVisible()
    await expect(next).toBeFocused()
  })

  test('History filters: the User list (board members) is not clipped by the view panel and stays hit-testable', async ({ page }) => {
    const members = Array.from({ length: 40 }, (_, i) => ({
      id: i + 1,
      user: i === 0 ? BOARD_USER : { id: i + 1, username: `member${i}`, display_name: `Member ${i}`, avatar_url: '' },
      role: i === 0 ? ('admin' as const) : ('member' as const),
      is_moderator: false,
      joined_at: '2026-01-01T00:00:00Z',
    }))
    await page.route(`**/api/v1/boards/${BOARD_FULL.id}/movements/**`, (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ results: [], count: 0, offset: 0, page_size: 50 }) }),
    )
    await openBoard(page, { ...BOARD_FULL, members } as unknown as typeof BOARD_FULL)
    await page.getByRole('button', { name: /history/i }).first().click()
    await page.getByRole('button', { name: /^user/i }).click()
    const menu = page.getByRole('menu')
    await expect(menu).toBeVisible()
    await expectInViewport(menu)
    const items = menu.getByRole('menuitem')
    await items.last().scrollIntoViewIfNeeded()
    expect(await topmostAtCenter(items.last())).toBe(true)
    expect(await menu.evaluate((n) => n.parentElement === document.body)).toBe(true)
  })

  test('Offboarding transfer-owner results are not clipped by the overflow-hidden board list and stay hit-testable', async ({ page }) => {
    const owned = Array.from({ length: 3 }, (_, i) => ({ id: 40 + i, uid: `boarduid0004${i}`, name: `Owned ${i}` }))
    const adminUser = (id: number, username: string, ownedBoards: typeof owned) => ({
      id, username, email: `${username}@example.com`, display_name: username, first_name: username, last_name: '', avatar_url: '',
      is_active: true, is_site_admin: id === 1, can_access_all_content: false, is_superuser: false, must_change_password: false,
      date_joined: '2024-01-01T00:00:00Z', owned_boards: ownedBoards,
    })
    await page.setViewportSize({ width: 1280, height: VIEWPORT_H })
    await routeAuth(page)
    await page.route('**/api/v1/auth/user/', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ...BOARD_USER, is_site_admin: true }) }),
    )
    await page.route('**/api/v1/admin/**', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ count: 0, offset: 0, page_size: 50, results: [] }) }),
    )
    await page.route('**/api/v1/admin/users/**', (route) =>
      route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({ count: 2, offset: 0, page_size: 50, results: [adminUser(1, 'testuser', []), adminUser(5, 'bob', owned)] }),
      }),
    )
    await page.route('**/api/users/**', (route) =>
      route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify(Array.from({ length: 8 }, (_, i) => ({ id: 100 + i, username: `cand${i}`, display_name: `Candidate ${i}`, avatar_url: '' }))),
      }),
    )
    await page.goto('/admin?tab=users')
    await page.getByRole('button', { name: /deactivate/i }).first().click()
    const inputs = page.getByPlaceholder('Search for a member…')
    await inputs.last().scrollIntoViewIfNeeded()
    await inputs.last().fill('ca')
    const results = page.getByRole('button', { name: /candidate/i })
    await expect(results).toHaveCount(8)
    const panel = results.first().locator('xpath=ancestor::*[@data-anchored-menu]')
    await expectInViewport(panel)
    await results.last().scrollIntoViewIfNeeded()
    expect(await topmostAtCenter(results.last())).toBe(true)
    expect(await panel.evaluate((n) => getComputedStyle(n).position)).toBe('fixed')
  })
})
