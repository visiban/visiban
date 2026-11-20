import { test, expect } from '@playwright/test'
import { routeAuth, routeBoard } from './helpers'
import { BOARD_FULL, CARD, SWIMLANE } from './fixtures/board'

// #2437 — the Filter panel searches field names and values across card and swimlane fields.
const TIER = {
  id: 61, uid: 'sfuid000061', name: 'Tier', field_type: 'dropdown', choices: ['gold', 'silver'], position: 0,
  show_on_row: false, is_admin_only: false, is_required: false, help_text: '', band_visibility: 'hidden',
  number_prefix: '', number_suffix: '', number_decimals: null, choice_colors: {}, created_at: '2026-01-01T00:00:00Z',
}

test.describe('Filter panel field and value search (#2437)', () => {
  test('type, select a value, and the chip appears', async ({ page }) => {
    const board = {
      ...BOARD_FULL,
      swimlane_custom_field_definitions: [TIER],
      swimlanes: [{ ...SWIMLANE, custom_field_values: [{ field_definition: TIER.id, value: 'gold' }] }],
    }
    await routeAuth(page)
    await routeBoard(page, board as unknown as typeof BOARD_FULL)
    await page.goto(`/boards/${BOARD_FULL.id}`)
    await expect(page.getByText(CARD.title).first()).toBeVisible({ timeout: 10_000 })

    await page.getByRole('button', { name: /^Filters/ }).click()
    const panel = page.getByRole('dialog', { name: 'Filter' })
    const search = panel.getByRole('textbox', { name: 'Search fields and values to filter' })
    await expect(search).toBeFocused()

    await search.fill('gol')
    const hit = panel.getByRole('button', { name: /Tier is gold/ })
    await expect(hit).toContainText('(hidden on band)')
    await expect(hit).toContainText('1 lane')
    await hit.click()

    const chips = panel.getByRole('group', { name: 'Filtered by' })
    await expect(chips.getByText(/Tier is gold/)).toBeVisible()

    // Escape clears the query first, then closes the panel.
    await page.keyboard.press('Escape')
    await expect(panel).toBeVisible()
    await expect(search).toHaveValue('')
    await page.keyboard.press('Escape')
    await expect(panel).toHaveCount(0)
  })
})
