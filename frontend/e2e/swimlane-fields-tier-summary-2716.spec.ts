import { test, expect } from '@playwright/test'
import { routeAuth, routeBoard } from './helpers'
import { BOARD_FULL, CARD } from './fixtures/board'

// #2716: the tier summary's cap row (label, select, counter) must stay on one line inside its
// column. A native <select> sizes to its widest <option>, and the disabled options read
// "12 (below the 13 in Details)", so jsdom class checks cannot see the wrap; measure it here.

function field(id: number) {
  return {
    id, uid: `sfuid00000${id}`, name: `Field ${id}`, field_type: 'text', choices: [], position: id,
    show_on_row: false, is_admin_only: false, is_required: false, help_text: '',
    number_prefix: '', number_suffix: '', number_decimals: null, choice_colors: {},
    band_visibility: 'details', created_at: '2026-01-01T00:00:00Z',
  }
}

test('tier summary cap row stays on one line within its column at desktop width (#2716)', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 })
  const board = {
    ...BOARD_FULL,
    lane_details_cap: 16,
    swimlane_custom_field_definitions: Array.from({ length: 13 }, (_, i) => field(i + 1)),
  } as unknown as typeof BOARD_FULL
  await routeAuth(page)
  await routeBoard(page, board)
  await page.goto(`/boards/${BOARD_FULL.id}`)
  await expect(page.getByText(CARD.title).first()).toBeVisible({ timeout: 10_000 })
  await page.keyboard.press('Control+,')
  await page.getByRole('tab', { name: /^Swimlane fields/ }).click()
  await expect(page.getByTestId('swimlane-details-counter')).toHaveText('13 / 16')

  const r = await page.getByTestId('swimlane-tier-summary').evaluate((box) => {
    const rect = (el: Element) => el.getBoundingClientRect()
    const label = box.querySelector('label[for="lane-details-cap"]')!
    const select = box.querySelector('#lane-details-cap')!
    const counter = box.querySelector('[data-testid="swimlane-details-counter"]')!
    const search = box.querySelector('#swimlane-field-find')!
    const column = select.closest('div.min-w-0')!.parentElement!.children[1]
    return {
      label: rect(label).toJSON(), select: rect(select).toJSON(), counter: rect(counter).toJSON(),
      search: rect(search).toJSON(), column: rect(column).toJSON(),
    }
  })
  console.log('2716 rects', JSON.stringify(r))
  const mid = (x: { top: number; height: number }) => x.top + x.height / 2
  expect(Math.abs(mid(r.label) - mid(r.select))).toBeLessThanOrEqual(2)
  expect(Math.abs(mid(r.counter) - mid(r.select))).toBeLessThanOrEqual(2)
  expect(r.select.right).toBeLessThanOrEqual(r.column.right + 0.5)
  expect(r.counter.right).toBeLessThanOrEqual(r.column.right + 0.5)
  expect(r.counter.right).toBeLessThanOrEqual(r.search.left)
  // One line: the row is no taller than the select.
  expect(r.counter.height).toBeLessThanOrEqual(r.select.height)
})
