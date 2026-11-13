import { test, expect } from '@playwright/test'
import { routeAuth, routeBoard } from './helpers'
import { BOARD_FULL, CARD } from './fixtures/board'

// #1122 — threshold marks on number card fields. The chip carries a chevron
// (aria-hidden) plus an sr-only phrase; the hover peek shows the phrase visibly.
// Vitest covers the evaluation rules; this pins the real-browser wiring.

const spend = {
  id: 910, uid: 'cfuid0000910', name: 'Spend', field_type: 'number', choices: [], position: 0, show_on_card: true,
  is_required: false, help_text: '', number_prefix: '$', number_suffix: '', number_decimals: null, choice_colors: {},
  threshold_direction: 'above', threshold_warn: 5000, threshold_alert: 6000,
  threshold_warn_days: null, threshold_alert_days: null,
  created_at: '2026-01-01T00:00:00Z',
}

test.describe('Threshold marks on number fields (#1122)', () => {
  test('alert chip shows the chevron and words, and the peek states the phrase', async ({ page }) => {
    const card = { ...CARD, custom_field_values: [{ field_definition: spend.id, value: '6500' }] }
    await routeAuth(page)
    await routeBoard(page, { ...BOARD_FULL, cards: [card], custom_field_definitions: [spend] } as unknown as typeof BOARD_FULL)
    await page.goto(`/boards/${BOARD_FULL.id}`)
    await expect(page.getByText(CARD.title).first()).toBeVisible({ timeout: 10_000 })

    const chip = page.locator('[data-threshold-level="alert"]').first()
    await expect(chip).toBeVisible()
    await expect(chip.locator('svg[aria-hidden="true"]')).toHaveCount(1)
    await expect(chip.locator('.sr-only')).toContainText('Alert: at or above $6000')
    await expect(chip).toHaveAttribute('title', /Alert: at or above \$6000/)

    await page.getByText(CARD.title).first().hover()
    const peek = page.getByRole('tooltip').filter({ hasText: CARD.description })
    await expect(peek).toBeVisible({ timeout: 3_000 })
    await expect(peek.getByTestId('card-peek-thresholds')).toContainText('Alert: at or above $6000')
  })

  test('configuring a threshold in Card fields sends it and marks the chip', async ({ page }) => {
    const off = { ...spend, threshold_direction: '', threshold_warn: null, threshold_alert: null }
    const card = { ...CARD, custom_field_values: [{ field_definition: spend.id, value: '6500' }] }
    let sent: Record<string, unknown> | null = null
    await page.route(`**/custom-fields/${spend.id}/`, (route) => {
      if (route.request().method() !== 'PATCH') return route.fallback()
      sent = route.request().postDataJSON()
      return route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({ ...off, ...sent }),
      })
    })
    await routeAuth(page)
    await routeBoard(page, { ...BOARD_FULL, cards: [card], custom_field_definitions: [off] } as unknown as typeof BOARD_FULL)
    await page.goto(`/boards/${BOARD_FULL.id}`)
    await expect(page.getByText(CARD.title).first()).toBeVisible({ timeout: 10_000 })
    await expect(page.locator('[data-threshold-level]')).toHaveCount(0)

    await page.keyboard.press('Control+,')
    await page.getByRole('button', { name: 'Card fields' }).click()
    await page.getByRole('button', { name: `Edit ${spend.name}` }).click()
    await page.getByRole('radiogroup', { name: 'Mark values' }).getByRole('radio', { name: 'Above' }).check()
    await page.getByLabel('Alert at').fill('6000')
    await page.getByRole('button', { name: 'Save field' }).click()

    await expect.poll(() => sent).toMatchObject({ threshold_direction: 'above', threshold_alert: 6000 })
    await page.keyboard.press('Escape')
    const chip = page.locator('[data-threshold-level="alert"]').first()
    await expect(chip).toBeVisible()
    await expect(chip.locator('svg[data-threshold-mark="alert"]')).toHaveCount(1)
  })

  test('a value below every threshold gets no mark', async ({ page }) => {
    const card = { ...CARD, custom_field_values: [{ field_definition: spend.id, value: '100' }] }
    await routeAuth(page)
    await routeBoard(page, { ...BOARD_FULL, cards: [card], custom_field_definitions: [spend] } as unknown as typeof BOARD_FULL)
    await page.goto(`/boards/${BOARD_FULL.id}`)
    await expect(page.getByText(CARD.title).first()).toBeVisible({ timeout: 10_000 })
    await expect(page.locator('[data-threshold-level]')).toHaveCount(0)
  })
})
