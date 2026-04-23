import { test, expect } from '@playwright/test'
import { routeAuth, routeBoard } from './helpers'
import { BOARD_FULL, CARD, LABEL_BUG } from './fixtures/board'

test.describe('filter bar', () => {
  test.beforeEach(async ({ page }) => {
    await routeAuth(page)
    await routeBoard(page)
  })

  test('applies a label filter and renders a chip', async ({ page }) => {
    await page.goto(`/boards/${BOARD_FULL.id}`)
    await expect(page.getByText(CARD.title).first()).toBeVisible({ timeout: 10_000 })

    // Filter row is hidden by default; pressing "f" toggles it.
    await page.keyboard.press('f')

    // Open the "Label" CheckboxDropdown and pick the "bug" label.
    await page.getByRole('button', { name: /^Label/ }).click()
    await page.getByRole('checkbox', { name: LABEL_BUG.name }).click()
    // Click outside to close the dropdown and commit the selection.
    await page.keyboard.press('Escape')

    const chips = page.getByRole('group', { name: 'Active filters' })
    await expect(chips).toBeVisible()
    await expect(chips.getByText(LABEL_BUG.name)).toBeVisible()
  })

  test('clears all filters via the Clear all button', async ({ page }) => {
    await page.goto(`/boards/${BOARD_FULL.id}`)
    await expect(page.getByText(CARD.title).first()).toBeVisible({ timeout: 10_000 })

    await page.keyboard.press('f')
    await page.getByRole('button', { name: /^Label/ }).click()
    await page.getByRole('checkbox', { name: LABEL_BUG.name }).click()
    await page.keyboard.press('Escape')

    await expect(page.getByRole('group', { name: 'Active filters' })).toBeVisible()
    await page.getByRole('button', { name: 'Clear all' }).click()
    await expect(page.getByRole('group', { name: 'Active filters' })).toHaveCount(0)
  })

  test('saved filter tabs row appears after a preset is saved', async ({ page }) => {
    // Override the saved-filters route to return one preset. The endpoint
    // returns a bare array (not paginated) and the row shape uses state_json /
    // state_version (see backend SavedFilterSerializer).
    await page.route(`**/api/v1/boards/${BOARD_FULL.id}/saved-filters/`, (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([
          {
            id: 11,
            name: 'My open bugs',
            state_json: { search: '', assigneeIds: [], labelIds: [LABEL_BUG.id], priorities: [], dueDate: null },
            state_version: 1,
            created_at: '2026-04-01T00:00:00Z',
          },
        ]),
      }),
    )
    await page.goto(`/boards/${BOARD_FULL.id}`)
    await expect(page.getByText(CARD.title).first()).toBeVisible({ timeout: 10_000 })

    // Saved filter tabs only render when the filter row is open.
    await page.keyboard.press('f')

    await expect(page.getByRole('button', { name: /My open bugs/ })).toBeVisible()
  })
})
