import { test, expect, type Page } from '@playwright/test'
import { routeAuth, routeBoard } from './helpers'
import { BOARD_FULL, CARD } from './fixtures/board'

// #1739 — the custom-field drag handle must reorder from the keyboard. jsdom
// reports 0-sized rects, so Vitest cannot show that an arrow press moves the
// row by one item (dnd-kit's default keyboard coordinates move a fixed ~25px
// and never cross a neighbor). This runs in a real browser: Tab to the handle,
// Space to lift, ArrowDown, Space to drop, then assert the new order and the
// reorder request.

const defBase = {
  field_type: 'text', choices: [], is_required: false, help_text: '',
  number_prefix: '', number_suffix: '', number_decimals: null, choice_colors: {},
  created_at: '2026-01-01T00:00:00Z',
}
const cardFields = ['Alpha', 'Bravo', 'Charlie'].map((name, i) => ({
  ...defBase, id: i + 1, uid: `cfuid00000${i + 1}`, name, position: i, show_on_card: false,
}))
const swimlaneFields = ['Owner', 'Region', 'Team'].map((name, i) => ({
  ...defBase, id: i + 1, uid: `sfuid00000${i + 1}`, name, position: i, show_on_row: false, is_admin_only: false,
}))

const board = {
  ...BOARD_FULL,
  custom_field_definitions: cardFields,
  swimlane_custom_field_definitions: swimlaneFields,
} as unknown as typeof BOARD_FULL

async function openSettingsTab(page: Page, tab: string) {
  await routeAuth(page)
  await routeBoard(page, board)
  await page.goto(`/boards/${BOARD_FULL.id}`)
  await expect(page.getByText(CARD.title).first()).toBeVisible({ timeout: 10_000 })
  await page.keyboard.press('Control+,')
  await page.getByRole('button', { name: tab }).click()
}

async function reorderFirstDown(page: Page, firstName: string, secondName: string) {
  const handle = page.getByRole('button', { name: `Drag to reorder ${firstName}` })
  await handle.focus()
  await expect(handle).toBeFocused()
  await page.keyboard.press('Space')
  // KeyboardSensor attaches its arrow-key listener on a later tick than the
  // pick-up, so an arrow pressed before the first "moved over" announcement is dropped.
  await expect(page.getByText(/Draggable item 1 was moved over droppable area 1/)).toBeAttached()
  await page.keyboard.press('ArrowDown')
  // dnd-kit announces the target it is hovering; dropping before that lands
  // would drop on the origin.
  await expect(page.getByText(new RegExp(`over droppable area 2`))).toBeAttached()
  await page.keyboard.press('Space')
  // The second row's handle is now first in DOM order.
  const handles = page.getByRole('button', { name: /^Drag to reorder / })
  await expect(handles.first()).toHaveAccessibleName(`Drag to reorder ${secondName}`)
}

test.describe('custom-field keyboard reorder (#1739)', () => {
  test.use({ viewport: { width: 1600, height: 900 } })

  test('Card fields: Space, ArrowDown, Space moves the row down one place', async ({ page }) => {
    let sent: { order: number[] } | null = null
    await page.route('**/custom-fields/reorder/', (route) => {
      sent = route.request().postDataJSON()
      const byId = new Map(cardFields.map((f) => [f.id, f]))
      return route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify(sent!.order.map((id, position) => ({ ...byId.get(id), position }))),
      })
    })
    await openSettingsTab(page, 'Card fields')
    await reorderFirstDown(page, 'Alpha', 'Bravo')
    await expect.poll(() => sent).toEqual({ order: [2, 1, 3] })
  })

  test('Swimlane fields: Space, ArrowDown, Space moves the row down one place', async ({ page }) => {
    let sent: { order: number[] } | null = null
    await page.route('**/swimlane-custom-fields/reorder/', (route) => {
      sent = route.request().postDataJSON()
      const byId = new Map(swimlaneFields.map((f) => [f.id, f]))
      return route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify(sent!.order.map((id, position) => ({ ...byId.get(id), position }))),
      })
    })
    await openSettingsTab(page, 'Swimlane fields')
    await reorderFirstDown(page, 'Owner', 'Region')
    await expect.poll(() => sent).toEqual({ order: [2, 1, 3] })
  })
})
