import { test, expect, type Page } from '@playwright/test'
import { routeAuth, routeBoard } from './helpers'
import { BOARD_FULL, CARD } from './fixtures/board'
import { contrastRatio, effectiveBackground, surfaceColor, textColor } from './contrast'

// #2448 — browser verification of the #2208 part 2 UI that shipped with jsdom tests only: the Default child
// board select, the Add child chooser's working states (desktop dialog, phone sheet), the board
// delete-impact warning, "Show the N cards", and the narrowest-card child progress bar. Desktop and 390px,
// light and dark; text contrast measured at 4.5:1 (#2206 rule 8).

const SIZES = [{ name: 'desktop', width: 1280, height: 800 }, { name: '390px', width: 390, height: 844 }]
const THEMES = ['light', 'dark'] as const
const json = (body: unknown) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
const noOverflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)

async function openSettings(page: Page, theme: 'light' | 'dark', board: typeof BOARD_FULL & Record<string, unknown>, section: RegExp, sectionLabel: string) {
  await routeAuth(page)
  await page.addInitScript((t) => localStorage.setItem('user:prefs:theme', t), theme)
  await routeBoard(page, board as typeof BOARD_FULL)
  await page.goto(`/boards/${board.id}`)
  await expect(page.getByText(CARD.title).first()).toBeVisible({ timeout: 10_000 })
  await page.getByRole('button', { name: 'Settings' }).click()
  const dialog = page.getByRole('dialog', { name: 'Board settings' })
  if (page.viewportSize()!.width < 640) await dialog.getByLabel('Section').selectOption({ label: sectionLabel })
  else await dialog.getByRole('tab', { name: section }).click()
  return dialog
}

const ADMIN_ON = { ...BOARD_FULL, current_user_role: 'admin' as const, cards_can_have_children: true }

for (const theme of THEMES) for (const size of SIZES) {
  test.describe(`child board verification (${theme}, ${size.name})`, () => {
    test.use({ viewport: { width: size.width, height: size.height } })

    test('Default child board select lists the options and sends the choice', async ({ page }) => {
      await page.route(`**/api/v1/boards/${ADMIN_ON.id}/children-setting-blockers/`, (r) => r.fulfill(json({ child_cards: 0, parent_cards: 0, default_of: [] })))
      await page.route(`**/api/v1/boards/${ADMIN_ON.id}/default-child-board-options/`, (r) => r.fulfill(json({ boards: [{ id: 12, name: 'Pipeline' }, { id: 13, name: 'Ops' }] })))
      let patched: Record<string, unknown> | null = null
      await page.route(`**/api/v1/boards/${ADMIN_ON.id}/`, (r) => {
        if (r.request().method() !== 'PATCH') return r.fallback()
        patched = r.request().postDataJSON()
        return r.fulfill(json({ ...ADMIN_ON, ...patched }))
      })
      const optionsRead = page.waitForResponse('**/default-child-board-options/')
      const dialog = await openSettings(page, theme, ADMIN_ON, /^Rules & limits/, 'Rules & limits')
      // Open the list only after the options read lands: it re-renders the select and would close an open list.
      await optionsRead
      const select = dialog.getByRole('combobox', { name: 'Default child board' })
      await expect(select).toHaveText(/None \(ask each time\)/)
      const ratios = {
        select: contrastRatio(await textColor(select), await effectiveBackground(select)),
        help: contrastRatio(await textColor(dialog.getByText(/^Add child on a card here creates/)), await surfaceColor(dialog.getByText(/^Add child on a card here creates/))),
      }
      console.log(`CONTRAST ${theme} ${size.name} default-child-select ${JSON.stringify(ratios)}`)
      for (const [n, r] of Object.entries(ratios)) expect(r, n).toBeGreaterThanOrEqual(4.5)
      // Settle the pane's scroll first: the list closes on any outside scroll, including the one a click's scroll-into-view causes.
      await select.scrollIntoViewIfNeeded()
      await select.click()
      // Scoped to the listbox: the phone's native Section select also exposes options.
      const list = page.getByRole('listbox')
      await expect(list.getByRole('option')).toHaveText(['None (ask each time)', 'Pipeline', 'Ops'])
      await list.getByRole('option', { name: 'Pipeline' }).click()
      await expect.poll(() => patched).toEqual({ default_child_board: 12 })
      expect(await noOverflow(page)).toBe(true)
    })

    test('the delete confirm names what deleting does to parent and child links', async ({ page }) => {
      await page.route(`**/api/v1/boards/${ADMIN_ON.id}/delete-impact/`, (r) => r.fulfill(json({ child_cards: 14, parent_boards: [{ id: 3, name: 'Pipeline' }], hidden_parent_boards: true, parent_cards: 2 })))
      const board = { ...ADMIN_ON, owner: { id: 1, username: 'testuser', display_name: 'Test User', avatar_url: '' } }
      const dialog = await openSettings(page, theme, board, /Danger zone/, 'Danger zone')
      const notice = dialog.getByTestId('board-delete-impact')
      await expect(notice).toContainText('14 cards here are children of cards on Pipeline and another board you can\'t open.')
      await expect(notice).toContainText('2 cards here have children on other boards.')
      const lead = notice.locator('span.text-danger')
      const ratios = {
        body: contrastRatio(await textColor(notice.locator('p').first()), await surfaceColor(notice)),
        lead: contrastRatio(await textColor(lead), await surfaceColor(notice)),
      }
      console.log(`CONTRAST ${theme} ${size.name} delete-impact ${JSON.stringify(ratios)}`)
      for (const [n, r] of Object.entries(ratios)) expect(r, n).toBeGreaterThanOrEqual(4.5)
      expect(await noOverflow(page)).toBe(true)
    })

    test('Add child chooser: working states, default checkbox, sheet on a phone', async ({ page }) => {
      await routeAuth(page)
      await page.addInitScript((t) => localStorage.setItem('user:prefs:theme', t), theme)
      await routeBoard(page, ADMIN_ON)
      await page.route(`**/api/v1/boards/${ADMIN_ON.id}/cards/${CARD.id}/children/`, (r) => r.fulfill(json({ count: 0, visible: true, offset: 0, limit: 50, results: [] })))
      await page.route(`**/api/v1/boards/${ADMIN_ON.id}/cards/${CARD.id}/child-board-options/`, (r) =>
        r.fulfill(json({ boards: [{ id: 12, name: 'Pipeline', can_set_default: true }, { id: 13, name: 'Ops', can_set_default: true }], default: null, fixed_board: null })))
      await page.goto(`/boards/${ADMIN_ON.id}`)
      await page.getByText(CARD.title).first().click()
      await page.getByRole('tab', { name: /^Children/ }).click()
      await page.getByRole('button', { name: /^Add child/ }).first().click()
      const dialog = page.getByRole('dialog', { name: /^Add child/ })
      await expect(dialog.getByText(/has no default child board yet/)).toBeVisible()
      const submit = dialog.getByRole('button', { name: 'Add child' })
      await expect(submit).toBeDisabled()
      await dialog.getByRole('combobox', { name: 'Child board' }).click()
      await page.getByRole('listbox').getByRole('option', { name: 'Pipeline' }).click()
      const makeDefault = dialog.getByLabel(/Use Pipeline as the default for/)
      await expect(makeDefault).toBeVisible()
      await dialog.getByLabel('Title').fill('A child')
      await expect(dialog.getByRole('button', { name: 'Add to Pipeline' })).toBeEnabled()
      const nodes = [dialog.getByText(/has no default child board yet/), dialog.getByText('Only boards you can add cards to are listed.'), dialog.getByText(/Use Pipeline as the default for/)]
      const ratios: number[] = []
      for (const n of nodes) ratios.push(contrastRatio(await textColor(n), await effectiveBackground(n)))
      console.log(`CONTRAST ${theme} ${size.name} chooser ${JSON.stringify(ratios)}`)
      for (const r of ratios) expect(r).toBeGreaterThanOrEqual(4.5)
      const box = (await dialog.boundingBox())!
      if (size.width < 640) {
        // Phone: a full-screen sheet, not a floating dialog.
        expect(box.width).toBeGreaterThanOrEqual(size.width - 1)
        expect(box.height).toBeGreaterThanOrEqual(size.height - 1)
        expect((await dialog.getByRole('button', { name: 'Cancel' }).boundingBox())!.height).toBeGreaterThanOrEqual(43.5)
      } else {
        expect(box.width).toBeLessThan(size.width)
      }
      expect(await noOverflow(page)).toBe(true)
    })
  })
}

test.describe('"Show the N cards"', () => {
  test('closes settings and filters the board to its child cards (f_parent=any)', async ({ page }) => {
    const board = { ...BOARD_FULL, current_user_role: 'admin' as const, cards_can_have_children: false }
    await page.route(`**/api/v1/boards/${board.id}/children-setting-blockers/`, (r) => r.fulfill(json({ child_cards: 4, parent_cards: 0, default_of: [] })))
    await page.route(`**/api/v1/boards/${board.id}/default-child-board-options/`, (r) => r.fulfill(json({ boards: [] })))
    const dialog = await openSettings(page, 'light', board, /^Rules & limits/, 'Rules & limits')
    const show = dialog.getByRole('button', { name: 'Show the 4 cards' })
    const ratio = contrastRatio(await textColor(show), await surfaceColor(show))
    expect(ratio).toBeGreaterThanOrEqual(4.5)
    await show.click()
    await expect(dialog).toBeHidden()
    await expect(page).toHaveURL(/f_parent=any/)
  })
})

for (const theme of THEMES) {
  test.describe(`child progress bar on the narrowest card (${theme}, 390px)`, () => {
    test.use({ viewport: { width: 390, height: 844 } })
    test('an 8-child bar with a blocked chip stays inside the footer row and the card', async ({ page }) => {
      const rollup = { visible: true, total: 8, done: 2, doing: 2, todo: 3, blocked: 1, last_moved_at: new Date(Date.now() - 86_400_000).toISOString() }
      const parent = { ...CARD, id: 11, uid: 'card000011c', title: 'Parent epic', position: 5, children_rollup: rollup }
      await routeAuth(page)
      await page.addInitScript((t) => localStorage.setItem('user:prefs:theme', t), theme)
      const board = { ...BOARD_FULL, card_density: 'comfortable', cards_can_have_children: true, cards: [parent] }
      await routeBoard(page, board as typeof BOARD_FULL)
      await page.goto(`/boards/${board.id}`)
      const footer = page.getByTestId('card-children-rollup').first()
      await expect(footer).toBeVisible()
      const bar = (await footer.getByTestId('rollup-segments').boundingBox())!
      const row = (await footer.locator('> div').first().boundingBox())!
      const segs = footer.locator('[data-segment]')
      await expect(segs).toHaveCount(8)
      const last = (await segs.last().boundingBox())!
      const card = (await footer.locator('xpath=ancestor::*[@data-card-id][1]').boundingBox())!
      console.log(`BAR ${theme} bar=${bar.width.toFixed(1)} lastRight=${(last.x + last.width).toFixed(1)} rowRight=${(row.x + row.width).toFixed(1)} cardRight=${(card.x + card.width).toFixed(1)}`)
      expect(last.x + last.width).toBeLessThanOrEqual(row.x + row.width + 0.5)
      expect(last.x + last.width).toBeLessThanOrEqual(card.x + card.width + 0.5)
      expect(await noOverflow(page)).toBe(true)
    })
  })
}
