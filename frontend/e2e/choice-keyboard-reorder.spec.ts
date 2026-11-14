import { test, expect, type Page } from '@playwright/test'
import { routeAuth, routeBoard } from './helpers'
import { BOARD_FULL, CARD } from './fixtures/board'

// #2190 — the choice rows inside the card-field and swimlane-field editors reorder
// from the keyboard, like the field lists (#1739, e2e/field-keyboard-reorder.spec.ts).
// jsdom reports 0-sized rects, so Vitest cannot show that an arrow press moves a
// choice by one row; this runs in a real browser: Tab-reachable handle, Space to
// lift, ArrowDown twice, Space to drop, then the new order, focus on the moved
// choice, and the saved choices. Escape cancels the drag without closing the modal.

const defBase = {
  field_type: 'dropdown', choices: ['Red', 'Green', 'Blue'], is_required: false, help_text: '',
  number_prefix: '', number_suffix: '', number_decimals: null, choice_colors: {},
  created_at: '2026-01-01T00:00:00Z',
}
const cardField = { ...defBase, id: 1, uid: 'cfuid000001', name: 'Priority', position: 0, show_on_card: false }
const swimlaneField = { ...defBase, id: 1, uid: 'sfuid000001', name: 'Region', position: 0, show_on_row: false, is_admin_only: false }

const board = {
  ...BOARD_FULL,
  custom_field_definitions: [cardField],
  swimlane_custom_field_definitions: [swimlaneField],
} as unknown as typeof BOARD_FULL

async function openFieldEditor(page: Page, tab: string, fieldName: string) {
  await routeAuth(page)
  await routeBoard(page, board)
  await page.goto(`/boards/${BOARD_FULL.id}`)
  await expect(page.getByText(CARD.title).first()).toBeVisible({ timeout: 10_000 })
  await page.keyboard.press('Control+,')
  await page.getByRole('button', { name: tab }).click()
  await page.getByRole('button', { name: `Edit ${fieldName}` }).click()
  await expect(page.getByRole('button', { name: 'Drag to reorder choice Red' })).toBeVisible()
}

const handleNames = (page: Page) =>
  page.getByRole('button', { name: /^Drag to reorder choice / }).evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')))

async function moveRedToEnd(page: Page) {
  const handle = page.getByRole('button', { name: 'Drag to reorder choice Red' })
  await handle.focus()
  await expect(handle).toBeFocused()
  await page.keyboard.press('Space')
  // KeyboardSensor attaches its arrow-key listener on a later tick than the pick-up,
  // so wait for the pick-up, and allow the first arrow one retry (the same budget as
  // #1739): one press per neighbor proves sortableKeyboardCoordinates. The pick-up is
  // followed at once by an over-itself announcement in the same live region, so gate
  // on that (as #1739 does) rather than on the pick-up text it replaces.
  await expect(handle).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByText('choice Red moved to position 1 of 3.')).toBeAttached()
  let presses = 0
  await expect(async () => {
    presses += 1
    await page.keyboard.press('ArrowDown')
    await expect(page.getByText('choice Red moved to position 2 of 3.')).toBeAttached({ timeout: 1_000 })
  }).toPass({ timeout: 15_000 })
  expect(presses, 'one ArrowDown must move over the next choice (a dropped first key allows one retry)').toBeLessThanOrEqual(2)
  await page.keyboard.press('ArrowDown')
  await expect(page.getByText('choice Red moved to position 3 of 3.')).toBeAttached()
  await page.keyboard.press('Space')
  await expect(page.getByText('choice Red dropped at position 3 of 3.')).toBeAttached()
  await expect.poll(() => handleNames(page)).toEqual([
    'Drag to reorder choice Green', 'Drag to reorder choice Blue', 'Drag to reorder choice Red',
  ])
  // Focus follows the moved choice, not the row it left.
  await expect(page.getByRole('button', { name: 'Drag to reorder choice Red' })).toBeFocused()
}

test.describe('custom-field choice keyboard reorder (#2190)', () => {
  test.use({ viewport: { width: 1600, height: 900 } })

  test('Card fields: Space, ArrowDown twice, Space moves a choice to the end and saves', async ({ page }) => {
    let sent: { choices?: string[] } | null = null
    await page.route(`**/api/v1/boards/${BOARD_FULL.id}/custom-fields/1/`, (route) => {
      sent = route.request().postDataJSON()
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ...cardField, ...sent }) })
    })
    await openFieldEditor(page, 'Card fields', 'Priority')
    await moveRedToEnd(page)
    await page.getByRole('button', { name: 'Save field' }).click()
    await expect.poll(() => sent?.choices).toEqual(['Green', 'Blue', 'Red'])
  })

  test('Swimlane fields: Space, ArrowDown twice, Space moves a choice to the end and saves', async ({ page }) => {
    let sent: { choices?: string[] } | null = null
    await page.route(`**/api/v1/boards/${BOARD_FULL.id}/swimlane-custom-fields/1/`, (route) => {
      sent = route.request().postDataJSON()
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ...swimlaneField, ...sent }) })
    })
    await openFieldEditor(page, 'Swimlane fields', 'Region')
    await moveRedToEnd(page)
    await page.getByRole('button', { name: 'Save field' }).click()
    await expect.poll(() => sent?.choices).toEqual(['Green', 'Blue', 'Red'])
  })

  test('Escape cancels the drag and leaves Board Settings and the draft open', async ({ page }) => {
    await openFieldEditor(page, 'Card fields', 'Priority')
    const handle = page.getByRole('button', { name: 'Drag to reorder choice Red' })
    await handle.focus()
    await page.keyboard.press('Space')
    await expect(page.getByText('choice Red moved to position 1 of 3.')).toBeAttached()
    await page.keyboard.press('Escape')
    await expect(page.getByText(/Reorder canceled\. choice Red returned to position 1 of 3\./)).toBeAttached()
    await expect(page.getByRole('button', { name: 'Save field' })).toBeVisible()
    expect(await handleNames(page)).toEqual([
      'Drag to reorder choice Red', 'Drag to reorder choice Green', 'Drag to reorder choice Blue',
    ])
  })
})
