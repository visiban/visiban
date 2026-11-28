import { test, expect, type Page } from '@playwright/test'
import { routeAuth, routeBoard } from './helpers'
import { BOARD_FULL, SWIMLANE } from './fixtures/board'

// #2698 — sorting lanes is a per-viewer view: apply a sort from the Lanes
// control, see the lanes reorder with no write request, reload into the same
// sort from the URL, and reset to the board order.
const PRIORITY = {
  id: 7, uid: 'slf0000007x', name: 'Priority', field_type: 'dropdown', choices: ['Critical', 'High', 'Low'], position: 0,
  show_on_row: true, is_admin_only: false, is_required: false, help_text: '', number_prefix: '', number_suffix: '',
  number_decimals: null, choice_colors: {}, created_at: '2026-01-01T00:00:00Z',
}
const lane = (id: number, name: string, priority: string | null) => ({
  ...SWIMLANE, id, uid: `swim00000${id}x`, name, position: id,
  custom_field_values: priority ? [{ field_definition: PRIORITY.id, value: priority }] : [],
})
const BOARD = {
  ...BOARD_FULL,
  swimlanes: [lane(1, 'Acme', 'Low'), lane(2, 'Globex', null), lane(3, 'Initech', 'Critical')],
  swimlane_custom_field_definitions: [PRIORITY],
}

const laneOrder = (page: Page) =>
  page.locator('[data-swimlane-id]:not([data-board-cell])').evaluateAll((els) => [...new Set(els.map((e) => e.getAttribute('data-swimlane-id')))])

test.describe('lane sort', () => {
  test('applies and resets a sort without writing, and survives a reload', async ({ page }) => {
    await routeAuth(page)
    await routeBoard(page, BOARD as unknown as typeof BOARD_FULL)
    const writes: string[] = []
    page.on('request', (req) => {
      if (req.method() !== 'GET' && req.url().includes('/swimlanes')) writes.push(`${req.method()} ${req.url()}`)
    })

    await page.goto(`/boards/${BOARD.id}`)
    const control = page.getByRole('button', { name: /^Lanes: Board order/ })
    await expect(control).toHaveText('Lanes: Board order')
    await expect.poll(() => laneOrder(page)).toEqual(['1', '2', '3'])

    await control.click()
    const dialog = page.getByRole('dialog', { name: 'Lane order' })
    // click, not check(): the URL update re-renders the radio a tick later.
    await dialog.getByRole('radio', { name: 'Priority' }).click()
    await expect(dialog.getByRole('radio', { name: 'Priority' })).toBeChecked()
    await expect.poll(() => laneOrder(page)).toEqual(['3', '1', '2'])
    await expect(page.getByRole('button', { name: /^Lanes: Sorted by Priority, Critical to Low/ })).toHaveText('Lanes: Sorted by Priority ↓')
    await expect(page.getByText('Not saved as board order. Only you see this sort.')).toBeVisible()
    await expect(page).toHaveURL(/lsort=f%3A7/)

    await page.keyboard.press('Escape')
    await expect(dialog).toBeHidden()

    await page.reload()
    await expect.poll(() => laneOrder(page)).toEqual(['3', '1', '2'])

    await page.getByRole('button', { name: 'Reset to board order' }).click()
    await expect.poll(() => laneOrder(page)).toEqual(['1', '2', '3'])
    await expect(page).not.toHaveURL(/lsort/)
    expect(writes).toEqual([])
  })
})
