import { test, expect, type Page, type Locator } from '@playwright/test'
import { routeAuth, routeBoard } from './helpers'
import { BOARD_FULL, CARD } from './fixtures/board'
import { borderColor, contrastRatio, effectiveBackground, textColor } from './contrast'

// #2441 — the child-side card link UI in a browser: Parent row, parent picker
// (desktop dialog and phone sheet), card-face parent line and the lock row,
// in light and dark, with #2206 rule 8 contrast measured (text 4.5:1, non-text 3:1).

const VISIBLE_PARENT = {
  hidden: false, id: 301, title: 'Launch epic', board_id: 9, board_name: 'Roadmap', column_id: 4, column_name: 'Doing',
  swimlane_id: 2, swimlane_name: 'Lane', archived: false, board_parent_name_singular: '',
}
const HIDDEN_PARENT = { hidden: true }
const PARENT_BOARDS = [{ id: 9, name: 'Roadmap', parent_name_singular: '', parent_name_plural: '' }]
const CANDIDATES = [
  { id: 301, title: 'Launch epic', column_id: 4, column_name: 'Doing', swimlane_id: 2, swimlane_name: 'Lane', assignee: null, disabled_reason: null, children_board_name: null },
  { id: 302, title: 'Full epic', column_id: 4, column_name: 'Doing', swimlane_id: 2, swimlane_name: 'Lane', assignee: null, disabled_reason: 'children_limit', children_board_name: null },
]

type Parent = typeof VISIBLE_PARENT | typeof HIDDEN_PARENT | null

async function openCard(page: Page, theme: 'light' | 'dark', parent: Parent) {
  const board = { ...BOARD_FULL, current_user_role: 'admin' as const, cards_can_have_children: false, cards: [{ ...CARD, parent }] }
  await routeAuth(page)
  await page.addInitScript((t) => localStorage.setItem('user:prefs:theme', t), theme)
  await routeBoard(page, board)
  await page.route(`**/api/v1/boards/${board.id}/parent-boards/`, (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ results: PARENT_BOARDS }) }))
  await page.route(`**/api/v1/boards/${board.id}/cards/${CARD.id}/parent-candidates/**`, (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ results: CANDIDATES }) }))
  await page.goto(`/boards/${board.id}`)
  if (parent) await expect(page.getByTestId('card-parent-line')).toBeVisible({ timeout: 10_000 })
  else await expect(page.getByText(CARD.title).first()).toBeVisible({ timeout: 10_000 })
}

const ratio = async (el: Locator, pick: 'text' | 'border' = 'text') =>
  contrastRatio(pick === 'text' ? await textColor(el) : await borderColor(el), await effectiveBackground(el))

const log = (theme: string, name: string, r: number) => {
  // eslint-disable-next-line no-console
  console.log(`CONTRAST ${theme} ${name} ${r.toFixed(2)}`)
}

for (const theme of ['light', 'dark'] as const) {
  test.describe(`child-side card link (${theme})`, () => {
    test('card-face line and Parent row for a visible parent', async ({ page }) => {
      await openCard(page, theme, VISIBLE_PARENT)
      const faceLine = page.getByTestId('card-parent-line')
      await expect(faceLine).toContainText('Launch epic')
      const face = await ratio(faceLine)
      log(theme, 'card-face parent line (text-info)', face)
      expect(face).toBeGreaterThanOrEqual(4.5)
      await page.getByText(CARD.title).first().click()
      const section = page.getByTestId('card-parent-section')
      await expect(section.getByRole('heading', { name: 'Parent' })).toBeVisible()
      const link = section.getByRole('link', { name: 'Launch epic' })
      await expect(link).toHaveAttribute('href', '/boards/9?card=301')
      const rowLink = await ratio(link)
      const sub = await ratio(section.getByText('Roadmap › Doing'))
      log(theme, 'Parent row link (text-info)', rowLink)
      log(theme, 'Parent row board › column (text-fg-muted)', sub)
      expect(rowLink).toBeGreaterThanOrEqual(4.5)
      expect(sub).toBeGreaterThanOrEqual(4.5)
      await expect(section.getByRole('button', { name: 'Unlink parent Launch epic' })).toBeVisible()
    })

    test('lock row for a parent the viewer cannot open', async ({ page }) => {
      await openCard(page, theme, HIDDEN_PARENT)
      const faceLine = page.getByTestId('card-parent-line')
      await expect(faceLine).toContainText("Linked card you can't open")
      const face = await ratio(faceLine)
      log(theme, 'card-face hidden line (text-fg-tertiary)', face)
      expect(face).toBeGreaterThanOrEqual(4.5)
      await page.getByText(CARD.title).first().click()
      const row = page.getByTestId('card-parent-hidden')
      await expect(row).toBeVisible()
      const dashed = await ratio(row, 'border')
      const main = await ratio(row.getByText("Linked card you can't open"))
      const detail = await ratio(row.getByText("It is on a board you don't have access to."))
      log(theme, 'lock row dashed border (border-fg-tertiary, non-text)', dashed)
      log(theme, 'lock row text (text-fg-secondary)', main)
      log(theme, 'lock row detail (text-fg-muted)', detail)
      expect(dashed, 'dashed lock border').toBeGreaterThanOrEqual(3)
      expect(main).toBeGreaterThanOrEqual(4.5)
      expect(detail).toBeGreaterThanOrEqual(4.5)
    })

    test('picker dialog: options, disabled and selected row contrast', async ({ page }) => {
      await openCard(page, theme, null)
      await page.getByText(CARD.title).first().click()
      await page.getByRole('button', { name: 'Link a parent' }).click()
      const picker = page.getByRole('dialog', { name: /parent/i }).last()
      await expect(picker).toBeVisible()
      await picker.getByPlaceholder('Search cards…').fill('epic')
      const enabled = picker.getByRole('option', { name: /Launch epic/ })
      const disabled = picker.getByRole('option', { name: /Full epic/ })
      await expect(disabled).toHaveAttribute('aria-disabled', 'true')
      await enabled.dispatchEvent('mousedown')
      await expect(enabled).toHaveAttribute('aria-selected', 'true')
      const disabledText = await ratio(disabled.getByText('Full epic'))
      const disabledSub = await ratio(disabled.getByText(/Has 100 children/))
      const selectedTitle = await ratio(enabled.getByText('Launch epic'))
      const selectedMark = contrastRatio(await textColor(enabled.locator('span').first()), await effectiveBackground(enabled))
      log(theme, 'disabled option title (text-fg-muted on surface)', disabledText)
      log(theme, 'disabled option reason (text-fg-muted)', disabledSub)
      log(theme, 'selected row title on bg-primary-emphasis/10', selectedTitle)
      log(theme, 'selected row check mark (non-text, primary-emphasis)', selectedMark)
      expect(disabledText).toBeGreaterThanOrEqual(4.5)
      expect(disabledSub).toBeGreaterThanOrEqual(4.5)
      expect(selectedTitle).toBeGreaterThanOrEqual(4.5)
      expect(selectedMark).toBeGreaterThanOrEqual(3)
    })
  })
}

test.describe('child-side card link at 390px', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true })

  test('the picker is a full-width sheet with 44px targets, and stays reachable with the keyboard up', async ({ page }) => {
    await openCard(page, 'light', null)
    await page.getByText(CARD.title).first().click()
    await page.getByRole('button', { name: 'Link a parent' }).click()
    const picker = page.getByTestId('parent-card-picker')
    await expect(picker).toBeVisible()
    const box = (await picker.boundingBox())!
    expect(box.width).toBeGreaterThanOrEqual(389)
    for (const name of ['Back to card', 'Close']) {
      expect((await picker.getByRole('button', { name }).boundingBox())!.height).toBeGreaterThanOrEqual(43.5)
    }
    // The on-screen keyboard shrinks only `visualViewport`; the layout viewport stays 844px, so an
    // `h-full` sheet would still be 844px tall with its footer under the keyboard. Shrinking the
    // layout viewport (setViewportSize) would let that sheet pass too, so only visualViewport moves.
    await page.evaluate(() => {
      const vv = window.visualViewport!
      Object.defineProperty(vv, 'height', { configurable: true, get: () => 420 })
      vv.dispatchEvent(new Event('resize'))
    })
    expect(await page.evaluate(() => window.innerHeight)).toBe(844)
    await expect.poll(async () => (await picker.boundingBox())!.height).toBeLessThanOrEqual(420)
    await expect(picker.getByPlaceholder('Search cards…')).toBeVisible()
    // The footer stays above the keyboard: inside the 420px the user can see, not merely in the layout viewport.
    const linkButton = (await picker.getByRole('button', { name: /^Link/ }).last().boundingBox())!
    expect(linkButton.y + linkButton.height).toBeLessThanOrEqual(420)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  })

  test('Parent row controls are 44px and the card face line stays on one line', async ({ page }) => {
    await openCard(page, 'dark', VISIBLE_PARENT)
    await page.getByText(CARD.title).first().click()
    const unlink = page.getByRole('button', { name: 'Unlink parent Launch epic' })
    expect((await unlink.boundingBox())!.height).toBeGreaterThanOrEqual(43.5)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  })
})

test.describe('parent link navigation', () => {
  test('the Parent row link opens the parent on its board in-app, without a full page load', async ({ page }) => {
    await openCard(page, 'light', VISIBLE_PARENT)
    const parentBoard = { ...BOARD_FULL, id: 9, name: 'Roadmap', cards: [{ ...CARD, id: 301, uid: 'card000301c', title: 'Launch epic', parent: null }] }
    await routeBoard(page, parentBoard)
    await page.evaluate(() => { (window as unknown as { __noReload2441?: boolean }).__noReload2441 = true })
    await page.getByText(CARD.title).first().click()
    await page.getByTestId('card-parent-section').getByRole('link', { name: 'Launch epic' }).click()
    await expect(page).toHaveURL(/\/boards\/9(\?|$)/)
    // The parent's own detail opens on its board: the child's dialog (which also names
    // "Launch epic" in its Parent row) is gone, and the ?card= deep link was consumed.
    const dialog = page.getByRole('dialog')
    await expect(dialog).toHaveCount(1, { timeout: 10_000 })
    await expect(dialog.getByText(CARD.title)).toHaveCount(0)
    await expect(dialog.getByTestId('card-parent-section')).toHaveCount(0)
    await expect(dialog.locator('input').first()).toHaveValue('Launch epic')
    await expect(page).not.toHaveURL(/card=/)
    expect(await page.evaluate(() => (window as unknown as { __noReload2441?: boolean }).__noReload2441)).toBe(true)
  })
})
