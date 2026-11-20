import { test, expect } from '@playwright/test'
import { routeAuth, routeBoard } from './helpers'
import { BOARD_FULL, CARD } from './fixtures/board'

// #2387 — on a narrow card, two pinned number chips must keep the number whole
// and ellipsize the field NAME. jsdom has no layout, so the Vitest class
// assertions cannot tell "the name yields first" from "both shrink at once";
// this measures the real flex layout. Flexbox shrinks every shrinkable item in
// proportion to shrink factor x base size, so a shrinkable value loses a few
// pixels alongside the name ("$3…") — the value span must not shrink at all.

const base = {
  choices: [], show_on_card: true, is_required: false, help_text: '', number_decimals: null, choice_colors: {},
  threshold_direction: '', threshold_warn: null, threshold_alert: null,
  threshold_warn_days: null, threshold_alert_days: null, created_at: '2026-01-01T00:00:00Z',
}
const deal = { ...base, id: 920, uid: 'cfuid0000920', name: 'Deal value', field_type: 'number', position: 0, number_prefix: '$', number_suffix: '' }
const prob = { ...base, id: 921, uid: 'cfuid0000921', name: 'Probability', field_type: 'number', position: 1, number_prefix: '', number_suffix: '%' }

test('a 165px card keeps both compact numbers whole and ellipsizes the field names (#2387)', async ({ page }) => {
  const card = {
    ...CARD,
    custom_field_values: [{ field_definition: deal.id, value: '33000' }, { field_definition: prob.id, value: '25' }],
  }
  await routeAuth(page)
  await routeBoard(page, { ...BOARD_FULL, cards: [card], custom_field_definitions: [deal, prob] } as unknown as typeof BOARD_FULL)
  await page.goto(`/boards/${BOARD_FULL.id}`)
  await expect(page.getByText(CARD.title).first()).toBeVisible({ timeout: 10_000 })

  const cardEl = page.locator(`[data-card-id="${CARD.id}"]`).first()
  // Narrow the card itself to the redesign's narrowest column width; the chips'
  // flex layout is all that is under test, not the column sizing.
  await cardEl.evaluate((el) => {
    const s = (el as HTMLElement).style
    s.width = '165px'; s.minWidth = '165px'; s.maxWidth = '165px'
  })
  await expect.poll(async () => (await cardEl.boundingBox())?.width).toBe(165)

  const values = cardEl.getByTestId('card-field-number')
  await expect(values).toHaveText(['$33k', '25%'])
  const overflow = (el: Element) => ({ scroll: el.scrollWidth, client: el.clientWidth })
  for (const v of await values.all()) {
    const m = await v.evaluate(overflow)
    expect(m.client, 'number value is laid out').toBeGreaterThan(0)
    expect(m.scroll, 'number value is not truncated').toBeLessThanOrEqual(m.client)
  }
  // The squeeze is real: the names are the ones that give up width.
  for (const name of ['Deal value:', 'Probability:']) {
    const m = await cardEl.getByText(name, { exact: true }).evaluate(overflow)
    expect(m.scroll, `${name} is the truncated item`).toBeGreaterThan(m.client)
  }
})
