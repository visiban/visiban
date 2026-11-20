import { test, expect } from '@playwright/test'
import { routeAuth, routeBoard } from './helpers'
import { BOARD_FULL, CARD, SWIMLANE } from './fixtures/board'

// #2439 — a lane field set to Hidden sits under "Hidden on band" in the lane details,
// for a non-admin as well as an admin.
const def = (id: number, name: string, position: number, band_visibility: string) => ({
  id, uid: `sfuid0000${id}`, name, field_type: 'text', choices: [], position,
  show_on_row: false, is_admin_only: false, is_required: false, help_text: '', band_visibility,
  number_prefix: '', number_suffix: '', number_decimals: null, choice_colors: {}, created_at: '2026-01-01T00:00:00Z',
})

for (const role of ['admin', 'member'] as const) {
  test(`a Hidden lane field is listed under Hidden on band for a ${role} (#2439)`, async ({ page }) => {
    const board = {
      ...BOARD_FULL,
      current_user_role: role,
      lane_details_cap: 6,
      swimlane_custom_field_definitions: [def(71, 'Owner', 0, 'band'), def(72, 'Region', 1, 'details'), def(73, 'Budget code', 2, 'hidden')],
      swimlanes: [{ ...SWIMLANE, custom_field_values: [
        { field_definition: 71, value: 'Ada' }, { field_definition: 72, value: 'EMEA' }, { field_definition: 73, value: 'B-42' },
      ] }],
    }
    await routeAuth(page)
    await routeBoard(page, board as unknown as typeof BOARD_FULL)
    await page.goto(`/boards/${BOARD_FULL.id}`)
    await expect(page.getByText(CARD.title).first()).toBeVisible({ timeout: 10_000 })

    // Band shows only the Band field; the Hidden one is not on the band itself.
    await expect(page.getByText('Ada').first()).toBeVisible()
    await expect(page.getByText('B-42')).toHaveCount(0)

    await page.getByRole('button', { name: /^Show 2 more fields for General/ }).click()
    const hidden = page.getByRole('region', { name: 'Hidden on band' })
    await expect(hidden).toBeVisible()
    await expect(hidden.getByText('Budget code')).toBeVisible()
    await expect(hidden.getByText('B-42')).toBeVisible()
  })
}
