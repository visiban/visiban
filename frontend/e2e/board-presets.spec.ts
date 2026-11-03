import { test, expect, type Page } from '@playwright/test'
import { routeAuth, routeBoard } from './helpers'
import { BOARD_FULL, CARD } from './fixtures/board'

// Board presets (#1146): the Row 2 picker, a `?preset=` link, Modified, Reset and
// Undo, in a real browser. The menu is portaled out of Row 2's `overflow-x-auto`
// strip, which would otherwise clip it to 40px; that is checked here because jsdom
// does no layout.

const DENSITY_KEY = `board:${BOARD_FULL.id}:card-density-override`
const OVERLAY_KEY = `board:${BOARD_FULL.id}:grid-overlay`

async function openBoard(page: Page, search = '') {
  await routeAuth(page)
  await routeBoard(page, BOARD_FULL)
  await page.goto(`/boards/${BOARD_FULL.id}${search}`)
  await expect(page.locator('[data-card-id]').filter({ hasText: CARD.title })).toBeVisible({ timeout: 10_000 })
}

function toolbar(page: Page) {
  return page.getByRole('navigation', { name: 'Board toolbar' })
}

function presetTrigger(page: Page) {
  return toolbar(page).getByRole('button', { name: /^Preset(:|$)/ })
}

function stored(page: Page, key: string) {
  return page.evaluate((k) => localStorage.getItem(k), key)
}

test('choosing a preset applies it, links it, and can be undone', async ({ page }) => {
  await openBoard(page)
  await expect(presetTrigger(page)).toHaveAccessibleName('Preset')

  await presetTrigger(page).click()
  const menu = page.getByRole('menu')
  await expect(menu).toBeVisible()
  // Not clipped by the 40px Row 2 strip.
  expect((await menu.boundingBox())!.height).toBeGreaterThan(60)
  await menu.getByRole('menuitemradio', { name: /^Default/ }).click()

  await expect(presetTrigger(page)).toHaveAccessibleName('Preset: Default')
  await expect(page).toHaveURL(/[?&]preset=default/)
  expect(await stored(page, DENSITY_KEY)).toBe('standard')
  const notice = page.getByTestId('preset-notice')
  await expect(notice).toContainText('Applied “Default”')

  await notice.getByRole('button', { name: 'Undo' }).click()
  await expect(presetTrigger(page)).toHaveAccessibleName('Preset')
  expect(await stored(page, DENSITY_KEY)).toBeNull()
  await expect(page).not.toHaveURL(/preset=/)
})

test('changing the overlay marks the preset Modified, and Reset restores it', async ({ page }) => {
  await openBoard(page)
  await presetTrigger(page).click()
  await page.getByRole('menuitemradio', { name: /^Default/ }).click()

  await toolbar(page).getByRole('button', { name: 'Overlay' }).click()
  await page.getByRole('menuitem', { name: 'Card count' }).click()

  await expect(presetTrigger(page)).toHaveAccessibleName('Preset: Default, modified')
  await expect(page.getByTestId('preset-modified-tag')).toBeVisible()
  await expect(page).not.toHaveURL(/preset=/)

  await presetTrigger(page).click()
  await expect(page.getByText('Overlay: Card count (preset: No overlay)')).toBeVisible()
  await page.getByRole('menuitem', { name: 'Reset to “Default”' }).click()

  await expect(presetTrigger(page)).toHaveAccessibleName('Preset: Default')
  await expect(page.getByTestId('preset-modified-tag')).toHaveCount(0)
  await expect(page.getByTestId('preset-notice')).toContainText('Reset to “Default”')
  expect(await stored(page, OVERLAY_KEY)).toBe('none')
})

test('a ?preset= link overrides the member’s own settings', async ({ page }) => {
  await page.addInitScript(([d, o]) => {
    // Only seed on the first load, so the assertions below read what the link wrote.
    if (!sessionStorage.getItem('seeded')) {
      localStorage.setItem(d, 'dense')
      localStorage.setItem(o, 'card-count')
      sessionStorage.setItem('seeded', '1')
    }
  }, [DENSITY_KEY, OVERLAY_KEY])
  await openBoard(page, '?preset=classic')
  await expect(presetTrigger(page)).toHaveAccessibleName('Preset: Classic')
  await expect.poll(() => stored(page, OVERLAY_KEY)).toBe('none')
  expect(await stored(page, DENSITY_KEY)).toBeNull()
  // No overlay legend: Classic shows no overlay.
  await expect(page.getByRole('group', { name: /overlay scale/ })).toHaveCount(0)
})

test('the picker is reachable by keyboard and its menu roves with the arrow keys', async ({ page }) => {
  await openBoard(page)
  await presetTrigger(page).focus()
  await page.keyboard.press('Enter')
  await page.keyboard.press('ArrowDown')
  await expect(page.getByRole('menuitemradio', { name: /^Classic/ })).toBeFocused()
  await page.keyboard.press('End')
  await expect(page.getByRole('menuitemradio', { name: /^Default/ })).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(presetTrigger(page)).toHaveAccessibleName('Preset: Default')
  await expect(presetTrigger(page)).toBeFocused()
})

test('a ?preset= link shows the Undo notice, and Undo restores the member settings', async ({ page }) => {
  await page.addInitScript(([d, o]) => {
    if (!sessionStorage.getItem('seeded')) {
      localStorage.setItem(d, 'dense')
      localStorage.setItem(o, 'card-count')
      sessionStorage.setItem('seeded', '1')
    }
  }, [DENSITY_KEY, OVERLAY_KEY])
  await openBoard(page, '?preset=default')
  const notice = page.getByTestId('preset-notice')
  await expect(notice).toContainText('Applied “Default” from the link')
  await notice.getByRole('button', { name: 'Undo' }).click()
  await expect(presetTrigger(page)).toHaveAccessibleName('Preset')
  expect(await stored(page, DENSITY_KEY)).toBe('dense')
  expect(await stored(page, OVERLAY_KEY)).toBe('card-count')
  await expect(page).not.toHaveURL(/preset=/)
})

test('the command palette applies a preset with the same Undo notice', async ({ page }) => {
  await openBoard(page)
  await page.keyboard.press('ControlOrMeta+k')
  const input = page.getByPlaceholder(/search cards/i)
  await input.fill('apply preset: default')
  await page.keyboard.press('Enter')
  await expect(presetTrigger(page)).toHaveAccessibleName('Preset: Default')
  await expect(page.getByTestId('preset-notice')).toContainText('Applied “Default”')
  expect(await stored(page, DENSITY_KEY)).toBe('standard')
})
