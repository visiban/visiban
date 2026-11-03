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

// Below `lg`, BoardView auto-opens its overflow menu once per browser, 600ms after load
// (#971). Mark it seen, or that menu takes focus from the picker mid-test on a slow runner.
async function skipFirstRunMenu(page: Page) {
  await page.addInitScript(() => localStorage.setItem('user:prefs:overflow-seen', 'true'))
}

async function openEditModal(page: Page) {
  await skipFirstRunMenu(page)
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

  test('one press dismisses one layer: the first on the backdrop closes the picker, the second the modal', async ({ page }) => {
    await openEditModal(page)
    await modalName(page).fill('Keep me')
    await trigger(page).click()
    await page.getByRole('textbox', { name: 'Hex value' }).fill('#112233')

    await page.mouse.click(4, 400)
    await expect(panel(page)).toHaveCount(0)
    await expect(page.getByRole('dialog', { name: 'Edit Swimlane' })).toBeVisible()
    await expect(modalName(page)).toHaveValue('Keep me')
    await expect(trigger(page)).toBeVisible()

    await page.mouse.click(4, 400)
    await expect(page.getByRole('dialog', { name: 'Edit Swimlane' })).toHaveCount(0)
  })

  test('a press on a preset swatch or a field closes the picker and still does what it does', async ({ page }) => {
    await openEditModal(page)
    await trigger(page).click()
    await page.getByRole('button', { name: 'Select color Red' }).click()
    await expect(panel(page)).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Select color Red' })).toHaveAttribute('aria-pressed', 'true')

    await trigger(page).click()
    await modalName(page).click()
    await expect(panel(page)).toHaveCount(0)
    await expect(modalName(page)).toBeFocused()
    await expect(page.getByRole('dialog', { name: 'Edit Swimlane' })).toBeVisible()
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

async function openLabelRow(page: Page, name: string) {
  await skipFirstRunMenu(page)
  await routeAuth(page)
  await routeBoard(page)
  await page.route(`**/api/v1/boards/${BOARD_FULL.id}/cards/${CARD.id}/`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(CARD) }),
  )
  await page.route(`**/api/v1/boards/${BOARD_FULL.id}/cards/${CARD.id}/movements/`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) }),
  )
  await page.goto(`/boards/${BOARD_FULL.id}`)
  await page.locator(`[data-card-id="${CARD.id}"]`).first().click()
  await page.getByRole('button', { name: '+ New label' }).click()
  await page.getByRole('textbox', { name: 'New label name' }).fill(name)
}

test.describe('Custom color picker in the card sheet (#2095)', () => {
  test('one press dismisses one layer: the first outside closes the picker, the second the sheet', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 })
    await openLabelRow(page, 'Half typed')
    const sheet = page.getByRole('dialog').filter({ has: page.getByRole('textbox', { name: 'New label name' }) })
    await trigger(page).click()
    await expect(panel(page)).toBeVisible()
    const outside = { x: 500, y: 700 }

    await page.mouse.click(outside.x, outside.y)
    await expect(panel(page)).toHaveCount(0)
    await expect(sheet).toBeVisible()
    await expect(page.getByRole('textbox', { name: 'New label name' })).toHaveValue('Half typed')

    await page.mouse.click(outside.x, outside.y)
    await expect(page.getByRole('textbox', { name: 'New label name' })).toHaveCount(0)
    await expect(sheet).toHaveCount(0)
  })
})

test.describe('A short viewport (#2095)', () => {
  test.use({ viewport: { width: 667, height: 375 } })

  test('the overflow fade never washes over the focused control and clears at the end', async ({ page }) => {
    await openEditModal(page)
    await trigger(page).focus()
    await page.keyboard.press('Enter')
    await expect(page.getByRole('slider', { name: 'Saturation and brightness' })).toBeFocused()
    const fade = panel(page).locator('.bg-gradient-to-t')
    const steps = ['Hue', 'Hex value', 'Red', 'Green', 'Blue', 'Cancel', 'Apply']
    for (const name of steps) {
      await page.keyboard.press('Tab')
      const control = panel(page).getByRole(name === 'Hue' ? 'slider' : name === 'Cancel' || name === 'Apply' ? 'button' : 'textbox', { name, exact: true })
      await expect(control).toBeFocused()
      await expect.poll(async () => {
        if (await fade.count() === 0) return true
        const [c, f] = await Promise.all([control.boundingBox(), fade.boundingBox()])
        return c !== null && f !== null && c.y + c.height <= f.y + 0.5
      }).toBe(true)
    }
    await expect(fade).toHaveCount(0)
    const atEnd = await panel(page).evaluate((el) => el.scrollTop + el.clientHeight >= el.scrollHeight - 1)
    expect(atEnd).toBe(true)
  })
})

test.describe('Custom color trigger on a touch screen (#2095)', () => {
  test.use({ hasTouch: true, isMobile: true })

  const hitArea = (target: ReturnType<typeof trigger>) => target.evaluate((el) => {
    const s = getComputedStyle(el, '::before')
    return { position: s.position, height: parseFloat(s.height), width: parseFloat(s.width) }
  })
  const ownsEdges = async (control: ReturnType<typeof trigger>) => {
    await control.scrollIntoViewIfNeeded()
    return control.evaluate((el) => {
      const r = el.getBoundingClientRect()
      const y = r.top + r.height / 2
      // 1px in: elementFromPoint rounds a fractional coordinate up to the shared edge.
      return [r.left + 1, r.right - 1].map((x) => {
        const hit = document.elementFromPoint(x, y)
        return hit === el ? 'own' : `${hit?.tagName}:${hit?.getAttribute('aria-label')}`
      }).join(',')
    })
  }

  test('md: 44x44, leaving the neighboring swatch its own taps, empty and selected', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 640 })
    await openEditModal(page)
    const purple = page.getByRole('button', { name: 'Select color Purple' })
    expect(await ownsEdges(purple)).toBe('own,own')
    const size = await hitArea(trigger(page))
    expect(size.position).toBe('absolute')
    expect(size).toMatchObject({ width: 44, height: 44 })

    await trigger(page).click()
    await page.getByRole('textbox', { name: 'Hex value' }).fill('#112233')
    await page.getByRole('button', { name: 'Apply' }).click()
    await expect(trigger(page, 'Custom color, selected')).toHaveCSS('transform', /matrix\(1\.1/)
    expect(await ownsEdges(purple)).toBe('own,own')
  })

  test('sm: 34x44 in the card sheet, leaving the swatch and the cancel button their taps', async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 768 })
    await openLabelRow(page, '')
    const swatch = page.getByRole('button', { name: /Select color Teal/ })
    const cancel = page.getByRole('button', { name: 'Cancel new label' })
    await page.getByRole('textbox', { name: 'New label name' }).fill('Plum')
    const named = page.getByRole('button', { name: /with color Teal/ })
    expect(await hitArea(trigger(page))).toMatchObject({ position: 'absolute', width: 34, height: 44 })
    expect(await ownsEdges(named)).toBe('own,own')
    expect(await ownsEdges(cancel)).toBe('own,own')
    await expect(swatch).toHaveCount(0)
  })

  test('sm: selected still leaves the cancel button its taps', async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 768 })
    await openLabelRow(page, '')
    await trigger(page).click()
    await page.getByRole('textbox', { name: 'Hex value' }).fill('#112233')
    await page.getByRole('button', { name: 'Apply' }).click()
    await expect(trigger(page, 'Custom color, selected')).toHaveCSS('transform', /matrix\(1\.1/)
    await page.getByRole('textbox', { name: 'New label name' }).fill('Plum')
    expect(await ownsEdges(page.getByRole('button', { name: 'Cancel new label' }))).toBe('own,own')
    expect(await ownsEdges(page.getByRole('button', { name: /with color Teal/ }))).toBe('own,own')
  })
})
