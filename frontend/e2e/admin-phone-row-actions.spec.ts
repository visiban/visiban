import { test, expect, type Page } from '@playwright/test'
import { routeAuth } from './helpers'
import { BOARD_USER } from './fixtures/board'

// #2476 — Site admin → Users at 390px: every row action is reachable from the row's ⋯ bottom
// sheet, the sheet sits inside the viewport, nothing scrolls sideways, and Transfer opens full
// screen. jsdom has no layout, so this measures in a real browser.

const W = 390
const H = 844

const owned = [{ id: 40, uid: 'boarduid00040', name: 'Ops' }, { id: 41, uid: 'boarduid00041', name: 'Web' }]
const adminUser = (id: number, username: string, ownedBoards: typeof owned) => ({
  id, username, email: `${username}@example.com`, display_name: username, first_name: username, last_name: '', avatar_url: '',
  is_active: true, is_site_admin: id === 1, can_access_all_content: false, is_superuser: false, must_change_password: false,
  has_completed_tour: true, date_joined: '2024-01-01T00:00:00Z', owned_boards: ownedBoards,
})

async function openUsers(page: Page) {
  await page.setViewportSize({ width: W, height: H })
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
      body: JSON.stringify({ count: 3, offset: 0, page_size: 50, results: [adminUser(1, 'testuser', []), adminUser(5, 'bob', owned), adminUser(6, 'carol', [])] }),
    }),
  )
  await page.goto('/admin?tab=users')
  await expect(page.getByRole('button', { name: 'More actions for carol' })).toBeVisible()
}

test.describe('Site admin phone row actions (#2476)', () => {
  test('the sheet holds every row action, fits the viewport, and the page never scrolls sideways', async ({ page }) => {
    await openUsers(page)
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(W)
    await page.getByRole('button', { name: 'More actions for carol' }).click()
    const sheet = page.getByRole('dialog', { name: 'carol' })
    await expect(sheet).toBeVisible()
    for (const name of ['Make admin', 'Deactivate', 'Force password reset', 'Clear lockout', 'Restart onboarding tour', 'Cancel']) {
      const b = sheet.getByRole('button', { name, exact: true })
      await expect(b).toBeVisible()
      expect((await b.boundingBox())!.height).toBeGreaterThanOrEqual(44)
    }
    const box = (await sheet.boundingBox())!
    expect(box.x).toBeGreaterThanOrEqual(0)
    expect(box.x + box.width).toBeLessThanOrEqual(W)
    expect(Math.round(box.y + box.height)).toBeLessThanOrEqual(H)
    // The destructive confirm replaces the list inside the sheet.
    await sheet.getByRole('button', { name: 'Deactivate', exact: true }).click()
    await expect(sheet.getByText('Deactivate carol? They will no longer be able to log in.')).toBeVisible()
    await page.keyboard.press('Escape')
    await page.keyboard.press('Escape')
    await expect(sheet).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'More actions for carol' })).toBeFocused()
  })

  test('Transfer boards and deactivate… opens the transfer dialog full screen', async ({ page }) => {
    await openUsers(page)
    await page.getByRole('button', { name: 'More actions for bob' }).click()
    const sheet = page.getByRole('dialog', { name: 'bob' })
    await expect(sheet.getByText('Choose a new owner for each of their 2 boards first')).toBeVisible()
    await sheet.getByRole('button', { name: /Transfer boards and deactivate…/ }).click()
    const modal = page.getByRole('dialog', { name: 'Transfer boards & deactivate' })
    await expect(modal).toBeVisible()
    const box = (await modal.boundingBox())!
    expect(Math.round(box.width)).toBe(W)
    expect(Math.round(box.x)).toBe(0)
  })
})
