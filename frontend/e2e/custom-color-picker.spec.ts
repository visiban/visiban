import { test, expect, type Page } from '@playwright/test'
import { routeAuth, routeBoard } from './helpers'
import { BOARD_FULL, CARD, SWIMLANE } from './fixtures/board'

// #2095 — the custom color panel inside a real modal. jsdom has no layout and no
// real click targeting, so these cover what Vitest cannot: the panel placed on screen,
// keyboard-only use in a focus trap, and a drag released past the modal's edge.

const trigger = (page: Page, name: 'Choose custom color' | 'Custom color, selected' = 'Choose custom color') =>
  page.getByRole('button', { name, exact: true })
const panel = (page: Page) => page.getByRole('dialog', { name: 'Custom color' })
const modalName = (page: Page) => page.getByRole('dialog', { name: 'Edit Swimlane' }).locator('input').first()

async function openEditModal(page: Page) {
  const board = { ...BOARD_FULL, swimlanes: [{ ...SWIMLANE, custom_field_values: [] }] }
  await routeAuth(page)
  await routeBoard(page, board as unknown as typeof BOARD_FULL)
  await page.goto(`/boards/${BOARD_FULL.id}`)
  await expect(page.getByText(CARD.title).first()).toBeVisible({ timeout: 10_000 })
  await page.getByRole('button', { name: 'Edit swimlane' }).click({ force: true })
  await expect(page.getByRole('dialog', { name: 'Edit Swimlane' })).toBeVisible()
}

test.describe('Custom color picker in a modal (#2095)', () => {
  test('keyboard only: open, set, save, with the form state intact', async ({ page }) => {
    await openEditModal(page)
    const sent: { body?: { name?: string; color?: string } } = {}
    await page.route(`**/api/v1/boards/${BOARD_FULL.id}/swimlanes/${SWIMLANE.id}/`, (route) => {
      sent.body = route.request().postDataJSON()
      return route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({ ...SWIMLANE, ...sent.body, custom_field_values: [] }),
      })
    })

    await modalName(page).fill('Renamed lane')
    await trigger(page).focus()
    await page.keyboard.press('Enter')
    await expect(panel(page)).toBeVisible()
    await expect(page.getByRole('slider', { name: 'Saturation and brightness' })).toBeFocused()

    await page.keyboard.press('Tab')
    await expect(page.getByRole('slider', { name: 'Hue' })).toBeFocused()
    await page.keyboard.press('Tab')
    await expect(page.getByRole('textbox', { name: 'Hex value' })).toBeFocused()
    await page.keyboard.press('ControlOrMeta+a')
    await page.keyboard.type('a0c')
    await expect(page.getByTestId('custom-color-preview')).toHaveCSS('background-color', 'rgb(170, 0, 204)')

    await page.keyboard.press('Enter')
    await expect(panel(page)).toHaveCount(0)
    await expect(trigger(page, 'Custom color, selected')).toBeFocused()
    await expect(trigger(page, 'Custom color, selected')).toHaveCSS('background-color', 'rgb(170, 0, 204)')
    await expect(modalName(page)).toHaveValue('Renamed lane')

    await page.getByRole('button', { name: 'Save', exact: true }).click()
    await expect.poll(() => sent.body?.color).toBe('#AA00CC')
    expect(sent.body?.name).toBe('Renamed lane')
  })

  test('Escape discards the draft and closes only the picker, then the modal', async ({ page }) => {
    await openEditModal(page)
    await modalName(page).fill('Keep me')
    await trigger(page).click()
    await page.getByRole('textbox', { name: 'Hex value' }).fill('#11')
    const apply = page.getByRole('button', { name: 'Apply' })
    await expect(apply).toHaveAttribute('aria-disabled', 'true')
    await expect(apply).toHaveCSS('opacity', '0.4')
    await page.getByRole('textbox', { name: 'Hex value' }).fill('#112233')
    await expect(apply).toHaveCSS('opacity', '1')

    await page.keyboard.press('Escape')
    await expect(panel(page)).toHaveCount(0)
    await expect(trigger(page)).toBeFocused()
    await expect(modalName(page)).toHaveValue('Keep me')

    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog', { name: 'Edit Swimlane' })).toHaveCount(0)
  })

  test('the panel sits on screen with every control hit-testable, at phone width', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 640 })
    await openEditModal(page)
    await trigger(page).click()
    const box = await panel(page).boundingBox()
    expect(box).not.toBeNull()
    expect(box!.x).toBeGreaterThanOrEqual(8)
    expect(box!.x + box!.width).toBeLessThanOrEqual(312)

    const grid = page.locator('.custom-color-panel .grid-cols-3 input')
    const tops = await grid.evaluateAll((els) => els.map((el) => el.getBoundingClientRect().top))
    expect(new Set(tops).size).toBe(1)

    for (const control of [
      page.getByRole('slider', { name: 'Saturation and brightness' }),
      page.getByRole('slider', { name: 'Hue' }),
      page.getByRole('textbox', { name: 'Blue' }),
      page.getByRole('button', { name: 'Apply' }),
    ]) {
      const hit = await control.evaluate((el) => {
        const r = el.getBoundingClientRect()
        const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
        return top !== null && (el.contains(top) || top.contains(el))
      })
      expect(hit).toBe(true)
    }
  })

  test('a square drag released on the backdrop keeps the modal and the panel open', async ({ page }) => {
    await openEditModal(page)
    await trigger(page).click()
    const square = page.getByRole('slider', { name: 'Saturation and brightness' })
    const box = await square.boundingBox()
    expect(box).not.toBeNull()
    const hexBefore = await page.getByRole('textbox', { name: 'Hex value' }).inputValue()

    await page.mouse.move(box!.x + 20, box!.y + 20)
    await page.mouse.down()
    await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2, { steps: 4 })
    await page.mouse.move(2, 2, { steps: 4 })
    await page.mouse.up()

    await expect(page.getByRole('dialog', { name: 'Edit Swimlane' })).toBeVisible()
    await expect(panel(page)).toBeVisible()
    await expect(page.getByRole('textbox', { name: 'Hex value' })).not.toHaveValue(hexBefore)
  })
})

test.describe('Custom color trigger on a touch screen (#2095)', () => {
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 320, height: 640 } })

  test('its larger hit area leaves the neighboring swatch its own taps', async ({ page }) => {
    await openEditModal(page)
    const target = trigger(page)
    const swatch = page.getByRole('button', { name: 'Select color Purple' })
    const swatchEdgeHit = await swatch.evaluate((el) => {
      const r = el.getBoundingClientRect()
      const hits = [r.right - 1, r.left + 1].map((x) => document.elementFromPoint(x, r.top + r.height / 2))
      return hits.every((hit) => hit === el)
    })
    expect(swatchEdgeHit).toBe(true)
    const size = await target.evaluate((el) => {
      const s = getComputedStyle(el, '::before')
      return { position: s.position, height: parseFloat(s.height), width: parseFloat(s.width) }
    })
    expect(size.position).toBe('absolute')
    expect(size.height).toBeGreaterThanOrEqual(44)
    expect(size.width).toBeGreaterThanOrEqual(44)
  })
})
