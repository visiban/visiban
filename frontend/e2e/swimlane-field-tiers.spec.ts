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

// #2663 — six Band fields marked, as many shown as the width fits. Past two shown the band uses the
// one-line layout; the 1440px case shows two, so it uses the wrapping layout and this fixture fits.
const SIX = ['Account owner', 'Region', 'Annual value', 'Renewal date', 'Support tier', 'Industry']
const VALUES = ['Ada Lovelace', 'Europe and Africa', '1,250,000', 'December 2026', 'Premium support', 'Manufacturing']

for (const [width, fit] of [[1440, 2], [1920, 5], [2560, 6]] as const) {
  test(`a lane with 6 Band fields shows ${fit} of them on one line at ${width}px (#2663)`, async ({ page }) => {
    const board = {
      ...BOARD_FULL,
      current_user_role: 'admin',
      lane_details_cap: 6,
      enforce_wip_limits: true,
      swimlane_custom_field_definitions: SIX.map((name, i) => def(81 + i, name, i, 'band')),
      swimlanes: [{
        ...SWIMLANE,
        name: 'Northern Hemisphere Strategic Enterprise Accounts and Partnerships',
        health_status: 'at_risk', effective_health_status: 'at_risk', wip_limit: 1,
        custom_field_values: VALUES.map((value, i) => ({ field_definition: 81 + i, value })),
      }],
    }
    await page.setViewportSize({ width, height: 900 })
    await routeAuth(page)
    await routeBoard(page, board as unknown as typeof BOARD_FULL)
    await page.goto(`/boards/${BOARD_FULL.id}`)
    await expect(page.getByText(CARD.title).first()).toBeVisible({ timeout: 10_000 })

    const band = page.getByTestId('swimlane-band')
    const fields = band.getByTestId('swimlane-band-fields').locator(':scope > span')
    await expect(fields).toHaveCount(fit)
    if (fit < 6) await expect(band.getByRole('button', { name: new RegExp(`^Show ${6 - fit} more fields`) })).toBeVisible()
    else await expect(band.getByTestId('swimlane-fields-toggle')).toHaveCount(0)

    const stats = band.getByTestId('swimlane-band-stats')
    await expect(stats).toBeVisible()
    await expect(band.getByRole('button', { name: /health/i }).first()).toBeVisible()
    const bandBox = (await band.boundingBox())!
    const statsBox = (await stats.boundingBox())!
    const nameBox = (await band.getByTestId('swimlane-name').boundingBox())!
    // One line: a wrapped band is at least two rows (over 60px) tall.
    expect(bandBox.height).toBeLessThan(56)
    expect(Math.abs(statsBox.y + statsBox.height / 2 - (nameBox.y + nameBox.height / 2))).toBeLessThan(8)
    expect(statsBox.x + statsBox.width).toBeLessThanOrEqual(bandBox.x + bandBox.width)
    // Each field keeps enough room to read, which is what the slot formula promises.
    const widths: number[] = []
    for (let i = 0; i < fit; i++) widths.push(Math.round((await fields.nth(i).boundingBox())!.width))
    for (const w of widths) expect(w).toBeGreaterThan(90)
  })
}

// #2663 audit — two shown Band fields wrap with the band; they are never squeezed into a clipped line.
test('two Band fields are shown in full at 1280px beside a long lane name (#2663)', async ({ page }) => {
  // Long enough that the pair cannot share the first line with the capped name and the stats.
  const names = ['Primary account owner', 'Sales operating region']
  const values = ['Alexandra Lovelace', 'Europe and Africa']
  const board = {
    ...BOARD_FULL,
    current_user_role: 'admin',
    lane_details_cap: 6,
    enforce_wip_limits: true,
    swimlane_custom_field_definitions: names.map((name, i) => def(81 + i, name, i, 'band')),
    swimlanes: [{
      ...SWIMLANE,
      name: 'Northern Hemisphere Strategic Enterprise Accounts and Partnerships',
      health_status: 'at_risk', effective_health_status: 'at_risk', wip_limit: 1,
      custom_field_values: values.map((value, i) => ({ field_definition: 81 + i, value })),
    }],
  }
  await page.setViewportSize({ width: 1280, height: 900 })
  await routeAuth(page)
  await routeBoard(page, board as unknown as typeof BOARD_FULL)
  await page.goto(`/boards/${BOARD_FULL.id}`)
  await expect(page.getByText(CARD.title).first()).toBeVisible({ timeout: 10_000 })

  const band = page.getByTestId('swimlane-band')
  for (const text of [...names, ...values]) {
    const el = band.getByText(text, { exact: true })
    await expect(el).toBeVisible()
    // Not ellipsized, and not cut off by a clipping ancestor inside the band.
    expect(await el.evaluate((node) => {
      const box = node.getBoundingClientRect()
      if (node.scrollWidth > node.clientWidth) return false
      for (let up = node.parentElement; up; up = up.parentElement) {
        const style = getComputedStyle(up)
        if (style.display !== 'contents' && style.overflowX !== 'visible') {
          const clip = up.getBoundingClientRect()
          if (box.left < clip.left - 0.5 || box.right > clip.right + 0.5) return false
        }
        if (up.getAttribute('data-testid') === 'swimlane-band') break
      }
      return true
    }), `${text} is clipped`).toBe(true)
  }
})
