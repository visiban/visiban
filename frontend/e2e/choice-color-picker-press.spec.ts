import { test, expect, type Page } from '@playwright/test'
import { routeAuth, routeBoard } from './helpers'
import { BOARD_FULL, CARD } from './fixtures/board'

// #2240 — the choice color popover in the field editor closed on its own onBlur when
// a press landed on a non-focusable part of it (the padding, the "Automatic" label):
// the browser moved focus to the nearest focusable ancestor, the settings modal's
// tabIndex=-1 dialog, which is outside the picker. Same class as #2223/#2224. jsdom
// does not move focus on a mousedown, so this runs in a real browser.

const defBase = {
  field_type: 'dropdown', choices: ['Red', 'Green'], is_required: false, help_text: '',
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

async function openColorPopover(page: Page, tab: string, fieldName: string) {
  await routeAuth(page)
  await routeBoard(page, board)
  await page.goto(`/boards/${BOARD_FULL.id}`)
  await expect(page.getByText(CARD.title).first()).toBeVisible({ timeout: 10_000 })
  await page.keyboard.press('Control+,')
  await page.getByRole('button', { name: tab }).click()
  await page.getByRole('button', { name: `Edit ${fieldName}` }).click()
  await page.getByRole('button', { name: /^Color for Red/ }).click()
  const popover = page.getByRole('dialog', { name: 'Color for Red' })
  await expect(popover).toBeVisible()
  return popover
}

for (const [tab, fieldName] of [['Card fields', 'Priority'], ['Swimlane fields', 'Region']] as const) {
  test(`${tab}: a press on the color popover's label or padding keeps it open (#2240)`, async ({ page }) => {
    const popover = await openColorPopover(page, tab, fieldName)
    const inside = () => popover.evaluate((n) => n.closest('.relative')!.contains(document.activeElement))

    await popover.getByText('Automatic', { exact: true }).click()
    await expect(popover).toBeVisible()
    expect(await inside()).toBe(true)

    await popover.click({ position: { x: 3, y: 3 } })
    await expect(popover).toBeVisible()
    expect(await inside()).toBe(true)

    // A swatch still picks and closes, and a press outside the picker still closes it.
    await popover.getByRole('radio', { name: /green/i }).click()
    await expect(popover).toBeHidden()

    await page.getByRole('button', { name: /^Color for Red/ }).click()
    await expect(popover).toBeVisible()
    await page.getByRole('button', { name: tab }).click()
    await expect(popover).toBeHidden()
  })
}
