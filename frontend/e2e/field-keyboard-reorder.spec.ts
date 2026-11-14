import { test, expect, type Page } from '@playwright/test'
import { routeAuth, routeBoard } from './helpers'
import { BOARD_FULL, CARD } from './fixtures/board'

// #1739 — the custom-field drag handle must reorder from the keyboard. jsdom
// reports 0-sized rects, so Vitest cannot show that an arrow press moves the
// row by one item (dnd-kit's default keyboard coordinates move a fixed ~25px
// and never cross a neighbor). This runs in a real browser: Tab to the handle,
// Space to lift, ArrowDown twice, Space to drop, then assert the new order and the
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

async function reorderFirstToLast(page: Page, names: [string, string, string]) {
  const [first, second, third] = names
  const handle = page.getByRole('button', { name: `Drag to reorder ${first}` })
  await handle.focus()
  await expect(handle).toBeFocused()
  await page.keyboard.press('Space')
  // KeyboardSensor attaches its arrow-key listener on a later tick than the
  // pick-up, so an arrow pressed before the pick-up announcement is dropped.
  await expect(page.getByText(`Field ${first} moved to position 1 of 3.`)).toBeAttached()
  // Each press is gated on its own announcement (never on timing). With
  // dnd-kit's default ~25px coordinate getter the item moves a fixed distance
  // and needs many presses to cross a neighbor, so the press budget below is
  // what proves `sortableKeyboardCoordinates` is wired (#1739): one press per
  // neighbor. Only the FIRST press may be dropped: dnd-kit ignores an arrow
  // pressed before its keyboard listener and droppable rects are ready (the
  // pick-up announcement lands first), so that one press is retried once.
  let presses = 0
  await expect(async () => {
    presses += 1
    await page.keyboard.press('ArrowDown')
    await expect(page.getByText(`Field ${first} moved to position 2 of 3.`)).toBeAttached({ timeout: 1_000 })
  }).toPass({ timeout: 15_000 })
  expect(presses, 'one ArrowDown must move over the next item (a dropped first key allows one retry)').toBeLessThanOrEqual(2)
  // The listener is live by now, so the second neighbor takes exactly one press.
  await page.keyboard.press('ArrowDown')
  await expect(page.getByText(`Field ${first} moved to position 3 of 3.`)).toBeAttached()
  await page.keyboard.press('Space')
  await expect(page.getByText(`Field ${first} dropped at position 3 of 3.`)).toBeAttached()
  const handles = page.getByRole('button', { name: /^Drag to reorder / })
  await expect(handles.nth(0)).toHaveAccessibleName(`Drag to reorder ${second}`)
  await expect(handles.nth(1)).toHaveAccessibleName(`Drag to reorder ${third}`)
  await expect(handles.nth(2)).toHaveAccessibleName(`Drag to reorder ${first}`)
}

test.describe('custom-field keyboard reorder (#1739)', () => {
  test.use({ viewport: { width: 1600, height: 900 } })

  test('Card fields: Space, ArrowDown twice, Space moves the row to the end', async ({ page }) => {
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
    await reorderFirstToLast(page, ['Alpha', 'Bravo', 'Charlie'])
    await expect.poll(() => sent).toEqual({ order: [2, 3, 1] })
  })

  test('Swimlane fields: Space, ArrowDown twice, Space moves the row to the end', async ({ page }) => {
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
    await reorderFirstToLast(page, ['Owner', 'Region', 'Team'])
    await expect.poll(() => sent).toEqual({ order: [2, 3, 1] })
  })
})
