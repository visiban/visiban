import { test, expect } from '@playwright/test'
import { routeAuth, routeBoard } from './helpers'
import { BOARD_FULL } from './fixtures/board'

// #2213 — first e2e that saves a filter and loads it back. The saved-filters
// endpoint is stubbed statefully (a POST is stored and returned by the next
// GET) and the posted body is asserted to be the full FilterState shape the
// SPA sends, including customFields / visibleCustomFieldFilterIds.
test.describe('saved filters', () => {
  test('saves the current filter and loads it back', async ({ page }) => {
    await routeAuth(page)
    await routeBoard(page)

    const stored: unknown[] = []
    let posted: { name: string; state_json: Record<string, unknown> } | null = null
    // Registered after routeBoard so it takes precedence for this URL.
    await page.route(`**/api/v1/boards/${BOARD_FULL.id}/saved-filters/`, async (route) => {
      const req = route.request()
      if (req.method() === 'POST') {
        posted = req.postDataJSON()
        const created = { id: 99, state_version: 1, created_at: '2026-11-13T00:00:00Z', ...posted }
        stored.push(created)
        await route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify(created) })
        return
      }
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(stored) })
    })

    await page.goto(`/boards/${BOARD_FULL.id}`)
    await page.getByRole('button', { name: /^filters/i }).click()
    await page.locator('[data-board-search="true"]').fill('task')

    await page.getByRole('button', { name: 'Saved filters' }).click()
    await page.getByRole('button', { name: /save current filters/i }).click()
    await page.getByPlaceholder('Filter name…').fill('My preset')
    await page.getByRole('button', { name: 'Save', exact: true }).click()

    await expect(page.getByRole('button', { name: /my preset/i })).toBeVisible()
    expect(posted).not.toBeNull()
    const state = posted!.state_json
    expect(state.search).toBe('task')
    expect(state).toHaveProperty('customFields')
    expect(state).toHaveProperty('visibleCustomFieldFilterIds')

    // Load it back: clear the search, then apply the preset.
    await page.locator('[data-board-search="true"]').fill('')
    await page.getByRole('button', { name: /my preset/i }).click()
    await expect(page.locator('[data-board-search="true"]')).toHaveValue('task')
  })
})
