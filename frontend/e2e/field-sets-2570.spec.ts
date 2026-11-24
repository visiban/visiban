import { test, expect } from '@playwright/test'
import type { Page } from '@playwright/test'
import { routeAuth, routeBoard } from './helpers'
import { BOARD_FULL, CARD } from './fixtures/board'

// #2570 — field set blocks on the card detail. Real layout is the point: jsdom
// reports 0 widths, so only a browser can prove summary chips are whole and
// the overflow goes behind "+N".

const field = (id: number, name: string) => ({
  id, uid: `cfuid00000${id}`, name, field_type: 'text', choices: [], position: id, show_on_card: false,
  is_required: false, help_text: '', number_prefix: '', number_suffix: '', number_decimals: null, choice_colors: {},
  threshold_direction: '', threshold_warn: null, threshold_alert: null, threshold_warn_days: null,
  threshold_alert_days: null, created_at: '2026-01-01T00:00:00Z',
})
const fields = Array.from({ length: 12 }, (_, i) => field(i + 1, `Qualification item ${i + 1}`))
const fieldSet = {
  id: 1, uid: 'fsuid000001', name: 'MEDDIC', description: null, position: 0, default_size: 'summary', scope: 'all',
  swimlanes: [], field_ids: fields.map((f) => f.id), created_at: '2026-01-01T00:00:00Z',
}
const card = { ...CARD, custom_field_values: [{ field_definition: 1, value: 'Budget approved' }] }

async function openCard(page: Page, role = 'admin') {
  const board = {
    ...BOARD_FULL, current_user_role: role, custom_field_definitions: fields, custom_field_sets: [fieldSet],
    cards: [card],
  }
  await routeAuth(page)
  await routeBoard(page, board as unknown as typeof BOARD_FULL)
  await page.route(`**/api/v1/boards/${BOARD_FULL.id}/cards/${CARD.id}/**`, (route) => {
    const url = route.request().url()
    const body = url.endsWith(`/cards/${CARD.id}/`) ? card : url.includes('/timeline/') ? { count: 0, next: null, previous: null, results: [] } : []
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
  })
  await page.goto(`/boards/${BOARD_FULL.id}`)
  await page.getByText(CARD.title).first().click()
  await expect(page.getByTestId('field-set-blocks')).toBeVisible({ timeout: 10_000 })
}

test.describe('field sets on the card (#2570)', () => {
  test.use({ viewport: { width: 1600, height: 900 } })

  test('summary shows only whole chips and puts the rest behind "+N"', async ({ page }) => {
    await openCard(page)
    const row = page.getByTestId('field-set-summary')
    const more = row.getByRole('button', { name: /^\+\d+ · \d+ missing$/ })
    await expect(more).toBeVisible()
    const check = () => row.evaluate((el) => {
      const box = el.getBoundingClientRect()
      const chips = Array.from(el.querySelectorAll<HTMLElement>('[data-chip]'))
      const shown = chips.filter((c) => !c.hidden)
      const button = el.querySelector('button')!.getBoundingClientRect()
      return {
        shown: shown.length,
        hidden: chips.length - shown.length,
        fits: shown.every((c) => c.getBoundingClientRect().right <= box.right + 0.5 && c.scrollWidth <= c.clientWidth)
          && button.right <= box.right + 0.5,
      }
    })
    await expect.poll(async () => (await check()).fits).toBe(true)
    const state = await check()
    expect(state.shown).toBeGreaterThan(0)
    expect(state.hidden).toBeGreaterThan(0)
    await expect(more).toHaveText(new RegExp(`^\\+${state.hidden} `))
    // Still true after a resize forces a re-measure.
    await page.setViewportSize({ width: 390, height: 800 })
    await expect.poll(async () => { const s = await check(); return s.fits && s.hidden >= state.hidden }).toBe(true)
    // "+N" opens All fields and keeps focus in the block.
    await more.click()
    await expect(page.locator('[data-fact-section="field:1"] input')).toBeFocused()
  })

  test('change size, then Maximize and Restore with focus return', async ({ page }) => {
    await openCard(page)
    const all = page.getByRole('group', { name: 'MEDDIC size' }).getByRole('button', { name: 'All fields' })
    await all.click()
    await expect(all).toHaveAttribute('aria-pressed', 'true')
    await expect(page.locator('[data-fact-section="field:2"] input')).toBeVisible()
    const maximize = page.getByRole('button', { name: 'Maximize MEDDIC' })
    await maximize.click()
    const layer = page.getByTestId('field-set-maximized')
    await expect(layer).toBeVisible()
    await expect(layer.getByRole('button', { name: 'Restore' })).toBeFocused()
    await layer.getByRole('button', { name: 'Restore' }).click()
    await expect(layer).toBeHidden()
    await expect(maximize).toBeFocused()
    await maximize.click()
    await page.keyboard.press('Escape')
    await expect(layer).toBeHidden()
    await expect(maximize).toBeFocused()
  })

  test('"Manage field sets" opens Board settings on Field sets, and Escape closes only that', async ({ page }) => {
    await openCard(page)
    await page.getByRole('button', { name: 'Manage field sets' }).click()
    const settings = page.getByRole('dialog', { name: 'Board settings' })
    await expect(settings.getByTestId('field-sets-section')).toBeVisible()
    await settings.getByRole('button', { name: /^MEDDIC/ }).click()
    await expect(settings.getByLabel('Name', { exact: true })).toHaveValue('MEDDIC')
    await page.keyboard.press('Escape')
    await expect(settings).toBeHidden()
    await expect(page.getByTestId('field-set-blocks')).toBeVisible()
  })

  test('settings: each Escape closes only the top layer, with focus return; keyboard drag stays in the modal', async ({ page }) => {
    await openCard(page)
    await page.getByRole('button', { name: 'Manage field sets' }).click()
    const settings = page.getByRole('dialog', { name: 'Board settings' })
    const copy = settings.getByRole('button', { name: 'Copy from another board' })
    await copy.click()
    const dialog = page.getByRole('dialog', { name: 'Copy a field set' })
    await expect(dialog.getByLabel('Board')).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(dialog).toBeHidden()
    await expect(copy).toBeFocused()
    await expect(settings).toBeVisible()
    await settings.getByRole('button', { name: /^MEDDIC/ }).click()
    const add = settings.getByRole('button', { name: '+ Add field' })
    // The menu closes on any outside scroll, so let the scroll to the trigger finish first.
    await add.scrollIntoViewIfNeeded()
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
    await add.click()
    await expect(page.getByTestId('multiselect-menu')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('multiselect-menu')).toBeHidden()
    await expect(add).toBeFocused()
    // Keyboard drag: lift, move down, drop; the order is held in the draft.
    const handles = settings.getByRole('button', { name: /^Drag to reorder Qualification/ })
    const first = settings.getByRole('button', { name: 'Drag to reorder Qualification item 1', exact: true })
    await first.focus()
    await page.keyboard.press('Space')
    await expect(first).toHaveAttribute('aria-pressed', 'true')
    await page.keyboard.press('ArrowDown')
    await expect(page.getByText('Field Qualification item 1 moved to position 2 of 12.')).toBeAttached()
    await page.keyboard.press('Space')
    await expect(handles.first()).toHaveAccessibleName('Drag to reorder Qualification item 2')
    // Escape during a second drag cancels the drag and leaves the modal open.
    await first.focus()
    await page.keyboard.press('Space')
    await expect(first).toHaveAttribute('aria-pressed', 'true')
    // dnd-kit attaches its keydown listener in a setTimeout(0) at pick-up (#2396).
    await page.evaluate(() => new Promise<void>((resolve) => setTimeout(resolve, 0)))
    await page.keyboard.press('Escape')
    await expect(first).not.toHaveAttribute('aria-pressed', 'true')
    await expect(settings).toBeVisible()
  })
})
