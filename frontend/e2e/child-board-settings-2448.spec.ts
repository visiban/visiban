import { test, expect, type Page } from '@playwright/test'
import { routeAuth, routeBoard } from './helpers'
import { BOARD_FULL, CARD } from './fixtures/board'
import { contrastRatio, effectiveBackground, surfaceColor, textColor } from './contrast'

// #2448 — child-board settings (Rules > Child cards) and the Add child chooser:
// router navigation from "Change on X", the blockers-read failure line, the
// chooser Retry; verified at desktop and 390px, light and dark, with the text
// and link contrast measured (4.5:1, #2206 rule 8).

const ADMIN_BOARD = { ...BOARD_FULL, current_user_role: 'admin' as const, cards_can_have_children: false }
const OTHER_BOARD = { ...BOARD_FULL, id: 12, name: 'Pipeline', current_user_role: 'admin' as const, cards_can_have_children: true }

async function openRules(page: Page, theme: 'light' | 'dark', blockers: 'ok' | 'default-of' | 'fail') {
  await routeAuth(page)
  await page.addInitScript((t) => localStorage.setItem('user:prefs:theme', t), theme)
  await routeBoard(page, ADMIN_BOARD)
  await page.route(`**/api/v1/boards/${ADMIN_BOARD.id}/children-setting-blockers/`, (route) => {
    if (blockers === 'fail') return route.fulfill({ status: 500, contentType: 'application/json', body: '{}' })
    const body = blockers === 'default-of'
      ? { child_cards: 0, parent_cards: 0, default_of: [{ hidden: false, id: 12, name: 'Pipeline', can_change: true }] }
      : { child_cards: 0, parent_cards: 0, default_of: [] }
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
  })
  await page.route(`**/api/v1/boards/${ADMIN_BOARD.id}/default-child-board-options/`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ boards: [] }) }))
  await page.goto(`/boards/${ADMIN_BOARD.id}`)
  await expect(page.getByText(CARD.title).first()).toBeVisible({ timeout: 10_000 })
  await page.getByRole('button', { name: 'Settings' }).click()
  const dialog = page.getByRole('dialog', { name: 'Board settings' })
  // Phone: a Section select replaces the sidebar tabs.
  if (page.viewportSize()!.width < 640) await dialog.getByLabel('Section').selectOption({ label: 'Rules & limits' })
  else await dialog.getByRole('tab', { name: /^Rules & limits/ }).click()
  return dialog
}

for (const theme of ['light', 'dark'] as const) {
  test.describe(`child board settings (${theme})`, () => {
    test('a failed blockers read explains itself on the switch', async ({ page }) => {
      const dialog = await openRules(page, theme, 'fail')
      const note = dialog.getByTestId('children-blockers-unavailable')
      await expect(note).toContainText("Couldn't check whether this can change")
      const ratio = contrastRatio(await textColor(note), await surfaceColor(note))
      // eslint-disable-next-line no-console
      console.log(`CONTRAST ${theme} blockers-unavailable ${ratio.toFixed(2)}`)
      expect(ratio).toBeGreaterThanOrEqual(4.5)
    })

    test('"Change on X" navigates in the router (no page load) and opens that board\'s Rules', async ({ page }) => {
      const dialog = await openRules(page, theme, 'default-of')
      const link = dialog.getByRole('link', { name: 'Change on Pipeline' })
      await expect(link).toHaveAttribute('href', '/boards/12?settings=rules')
      const ratio = contrastRatio(await textColor(link), await surfaceColor(link))
      // eslint-disable-next-line no-console
      console.log(`CONTRAST ${theme} change-link ${ratio.toFixed(2)}`)
      expect(ratio).toBeGreaterThanOrEqual(4.5)
      await routeBoard(page, OTHER_BOARD)
      await page.route(`**/api/v1/boards/12/children-setting-blockers/`, (route) =>
        route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ child_cards: 0, parent_cards: 0, default_of: [] }) }))
      await page.route(`**/api/v1/boards/12/default-child-board-options/`, (route) =>
        route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ boards: [] }) }))
      await page.evaluate(() => { (window as unknown as { __spa: number }).__spa = 1 })
      await link.click()
      await expect(page).toHaveURL(/\/boards\/12/)
      await expect(page.getByRole('dialog', { name: 'Board settings' }).getByRole('tab', { name: /^Rules & limits/ })).toHaveAttribute('aria-selected', 'true')
      // A full page load would have reset the window.
      expect(await page.evaluate(() => (window as unknown as { __spa?: number }).__spa)).toBe(1)
    })
  })
}

test.describe('?settings=rules deep link', () => {
  // A fresh page load (not the in-app navigation above, where the Rules tab is
  // already selected) must itself open Board settings on Rules & limits.
  test('a fresh load of /boards/12?settings=rules opens the Rules tab and strips the param', async ({ page }) => {
    await routeAuth(page)
    await routeBoard(page, OTHER_BOARD)
    await page.route(`**/api/v1/boards/12/children-setting-blockers/`, (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ child_cards: 0, parent_cards: 0, default_of: [] }) }))
    await page.route(`**/api/v1/boards/12/default-child-board-options/`, (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ boards: [] }) }))
    await page.goto('/boards/12?settings=rules')
    const dialog = page.getByRole('dialog', { name: 'Board settings' })
    await expect(dialog).toBeVisible({ timeout: 10_000 })
    await expect(dialog.getByRole('tab', { name: /^Rules & limits/ })).toHaveAttribute('aria-selected', 'true')
    await expect(page).not.toHaveURL(/settings=/)
  })
})

test.describe('child board settings at 390px', () => {
  test.use({ viewport: { width: 390, height: 844 } })
  test('the reason link is a 44px target and the page does not scroll sideways', async ({ page }) => {
    const dialog = await openRules(page, 'light', 'default-of')
    const link = dialog.getByRole('link', { name: 'Change on Pipeline' })
    await expect(link).toBeVisible()
    expect((await link.boundingBox())!.height).toBeGreaterThanOrEqual(43.5)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  })

  test('a failed blockers read stays readable at 390px', async ({ page }) => {
    const dialog = await openRules(page, 'dark', 'fail')
    await expect(dialog.getByTestId('children-blockers-unavailable')).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  })
})

for (const theme of ['light', 'dark'] as const) for (const size of [{ name: 'desktop', width: 1280, height: 800 }, { name: '390px', width: 390, height: 844 }]) {
  test.describe(`Add child chooser (${theme}, ${size.name})`, () => {
    test.use({ viewport: { width: size.width, height: size.height } })
    test('a failed boards read shows Retry, which recovers', async ({ page }) => {
      const board = { ...BOARD_FULL, current_user_role: 'admin' as const, cards_can_have_children: true }
      await routeAuth(page)
      await page.addInitScript((t) => localStorage.setItem('user:prefs:theme', t), theme)
      await routeBoard(page, board)
      await page.route(`**/api/v1/boards/${board.id}/cards/${CARD.id}/children/`, (route) =>
        route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ count: 0, visible: true, offset: 0, limit: 50, results: [] }) }))
      let reads = 0
      await page.route(`**/api/v1/boards/${board.id}/cards/${CARD.id}/child-board-options/`, (route) => {
        reads += 1
        // The Children tab reads once for its button label; the dialog's own read is the next one.
        if (reads === 2) return route.fulfill({ status: 500, contentType: 'application/json', body: '{}' })
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ boards: [{ id: 12, name: 'Pipeline' }], default: { id: 12, name: 'Pipeline' }, fixed_board: null }) })
      })
      await page.goto(`/boards/${board.id}`)
      await page.getByText(CARD.title).first().click()
      await page.getByRole('tab', { name: /^Children/ }).click()
      await page.getByRole('button', { name: /^Add child/ }).first().click()
      const dialog = page.getByRole('dialog', { name: /^Add child/ })
      await expect(dialog.getByRole('alert')).toContainText("Couldn't load the boards")
      const retry = dialog.getByRole('button', { name: 'Retry' })
      if (size.width < 640) expect((await retry.boundingBox())!.height).toBeGreaterThanOrEqual(43.5)
      const alert = dialog.getByRole('alert')
      const ratios = {
        alert: contrastRatio(await textColor(alert), await effectiveBackground(alert)),
        retry: contrastRatio(await textColor(retry), await effectiveBackground(retry)),
      }
      // eslint-disable-next-line no-console
      console.log(`CONTRAST ${theme} ${size.name} add-child-retry ${JSON.stringify(ratios)}`)
      for (const [name, r] of Object.entries(ratios)) expect(r, name).toBeGreaterThanOrEqual(4.5)
      await retry.click()
      // Retry unmounts on click; focus goes to the dialog heading, not <body>.
      await expect(dialog.getByRole('heading', { level: 2 })).toBeFocused()
      await expect(dialog.getByLabel('Title')).toBeVisible()
      expect(reads).toBe(3)
    })
  })
}
