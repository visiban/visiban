import { test, expect } from '@playwright/test'
import type { Page } from '@playwright/test'
import { routeAuth, routeBoard } from './helpers'
import { BOARD_FULL, CARD } from './fixtures/board'

// Card context menu and ⌘K card actions (#2059, 1.3 UI spec Part 9 § 2).

const cardFace = (page: Page) => page.locator(`[data-card-id="${CARD.id}"]`)
const modifier = process.platform === 'darwin' ? 'Meta' : 'Control'

test.describe('card context menu', () => {
  test.use({ viewport: { width: 1600, height: 900 } })

  test.beforeEach(async ({ page }) => {
    await routeAuth(page)
    await routeBoard(page)
    // The card sheet's own fetches (Block card… opens it), so nothing falls
    // through to a real backend and trips the logout-on-401 handling.
    for (const path of ['', 'movements/', 'comments/', 'activity/', 'activities/', 'checklist/', 'attachments/', 'relations/', 'blocks/']) {
      await page.route(`**/api/v1/boards/${BOARD_FULL.id}/cards/${CARD.id}/${path}`, (route) =>
        route.request().method() === 'GET'
          ? route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(path === '' ? CARD : []) })
          : route.fallback(),
      )
    }
    await page.goto(`/boards/${BOARD_FULL.id}`)
    await expect(cardFace(page)).toBeVisible({ timeout: 10_000 })
  })

  test('right-click on a card opens its menu, not the add-card input; Escape returns to the card', async ({ page }) => {
    await cardFace(page).click({ button: 'right' })
    const menu = page.getByRole('menu', { name: `Card actions: ${CARD.title}` })
    await expect(menu).toBeVisible()
    await expect(page.getByPlaceholder('Card title…')).toHaveCount(0)
    await expect(menu.getByRole('menuitem', { name: /Open card/ })).toBeFocused()
    await expect(menu.getByRole('menuitem').last()).toHaveText('Delete card…')
    // The target card carries the transient outline while the menu is open.
    await expect(cardFace(page)).toHaveClass(/ring-info/)

    await page.keyboard.press('Escape')
    await expect(menu).toHaveCount(0)
    await expect(cardFace(page)).toBeFocused()
  })

  test('right-click on empty cell space still opens the add-card input', async ({ page }) => {
    // The padding of the populated To Do cell, outside the card face.
    const cell = page.locator('[data-board-cell]').filter({ has: cardFace(page) })
    await cell.click({ button: 'right', position: { x: 3, y: 3 } })
    await expect(page.getByPlaceholder('Card title…')).toBeVisible()
    await expect(page.getByRole('menu')).toHaveCount(0)
  })

  test('Shift+F10 on the focused card opens the menu; a submenu sets the priority', async ({ page }) => {
    let patched: unknown = null
    await page.route(`**/api/v1/boards/${BOARD_FULL.id}/cards/${CARD.id}/`, async (route) => {
      if (route.request().method() !== 'PATCH') return route.fallback()
      patched = route.request().postDataJSON()
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ...CARD, priority: 'high', version: 2 }) })
    })

    await cardFace(page).focus()
    await page.keyboard.press('Shift+F10')
    const menu = page.getByRole('menu', { name: `Card actions: ${CARD.title}` })
    await expect(menu).toBeVisible()
    // Typeahead: "s" jumps to Set priority.
    await page.keyboard.press('s')
    await expect(menu.getByRole('menuitem', { name: /Set priority/ })).toBeFocused()
    // …and only the menu: the bare-letter S (Summary view) did not fire.
    await expect(page.getByText('Failed to load summary.')).toHaveCount(0)
    await expect(cardFace(page)).toBeVisible()
    await page.keyboard.press('ArrowRight')
    const sub = page.getByRole('menu', { name: 'Set priority' })
    await expect(sub.getByRole('menuitem', { name: 'Low' })).toBeFocused()
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('Enter')

    await expect.poll(() => patched).toEqual({ priority: 'high' })
    await expect(page.getByRole('menu')).toHaveCount(0)
    await expect(page.getByTestId('card-action-status')).toHaveText(`Set “${CARD.title}” to high priority.`)
    await expect(cardFace(page)).toBeFocused()
  })

  test('⌘K acts on the focused card: Block card… opens the sheet with Reason focused', async ({ page }) => {
    await cardFace(page).focus()
    await page.keyboard.press(`${modifier}+k`)
    await expect(page.getByTestId('palette-card-target')).toHaveText(`Acting on ${CARD.title}`)
    await page.getByRole('combobox', { name: 'Command palette search' }).fill('bl')
    const results = page.getByRole('listbox', { name: 'Results' })
    await expect(results.getByRole('option', { name: 'Block card…' })).toBeVisible()
    await expect(results.getByRole('option', { name: /Delete/ })).toHaveCount(0)
    await page.keyboard.press('Enter')

    await expect(page.getByRole('combobox', { name: 'Command palette search' })).toHaveCount(0)
    await expect(page.getByTestId('card-block-form')).toBeVisible()
    await expect(page.getByLabel(/Reason/)).toBeFocused()
  })

  test('⌘K with no target explains how to get one; → on a card result drills into its actions', async ({ page }) => {
    let archived = false
    await page.route(`**/api/v1/boards/${BOARD_FULL.id}/cards/${CARD.id}/archive/`, async (route) => {
      archived = true
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ...CARD, archived_at: '2026-11-02T00:00:00Z' }) })
    })

    await page.keyboard.press(`${modifier}+k`)
    const input = page.getByRole('combobox', { name: 'Command palette search' })
    await input.fill('archive')
    await expect(page.getByTestId('palette-no-card-target')).toContainText('Select, focus or open a card to act on it.')

    await input.fill(CARD.title)
    await page.keyboard.press('ArrowRight')
    await expect(page.getByTestId('palette-card-target')).toContainText(`Acting on ${CARD.title}`)
    await input.fill('arch')
    await page.keyboard.press('Enter')
    await expect.poll(() => archived).toBe(true)
  })
})
