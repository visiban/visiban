import { test, expect } from '@playwright/test'
import { routeAuth, routeBoard } from './helpers'
import { BOARD_FULL, CARD } from './fixtures/board'

test.describe('command palette', () => {
  test.beforeEach(async ({ page }) => {
    await routeAuth(page)
    await routeBoard(page)
  })

  test('⌘K opens the palette with the search input focused', async ({ page }) => {
    await page.goto(`/boards/${BOARD_FULL.id}`)
    await expect(page.getByText(CARD.title).first()).toBeVisible({ timeout: 10_000 })

    const modifier = process.platform === 'darwin' ? 'Meta' : 'Control'
    await page.keyboard.press(`${modifier}+k`)

    const input = page.getByRole('combobox', { name: 'Command palette search' })
    await expect(input).toBeVisible({ timeout: 2_000 })
    await expect(input).toBeFocused()
  })

  test('typing a card title filters to a single matching result', async ({ page }) => {
    await page.goto(`/boards/${BOARD_FULL.id}`)
    await expect(page.getByText(CARD.title).first()).toBeVisible({ timeout: 10_000 })

    const modifier = process.platform === 'darwin' ? 'Meta' : 'Control'
    await page.keyboard.press(`${modifier}+k`)

    const input = page.getByRole('combobox', { name: 'Command palette search' })
    await input.fill(CARD.title.slice(0, 4))

    // The results list is role="listbox" and each result is role="option".
    const listbox = page.getByRole('listbox', { name: 'Results' })
    await expect(listbox).toBeVisible()
    await expect(listbox.getByRole('option').filter({ hasText: CARD.title })).toBeVisible()
  })

  test('Esc closes the palette', async ({ page }) => {
    await page.goto(`/boards/${BOARD_FULL.id}`)
    await expect(page.getByText(CARD.title).first()).toBeVisible({ timeout: 10_000 })

    const modifier = process.platform === 'darwin' ? 'Meta' : 'Control'
    await page.keyboard.press(`${modifier}+k`)
    const input = page.getByRole('combobox', { name: 'Command palette search' })
    await expect(input).toBeVisible()

    await page.keyboard.press('Escape')
    await expect(input).toHaveCount(0)
  })
})
