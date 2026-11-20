import { test, expect } from '@playwright/test'
import { routeAuth, routeBoard } from './helpers'
import { BOARD_FULL, CARD } from './fixtures/board'

// #2436 / #2435: grouped Board settings sidebar, Find a setting, and the toolbar Export / Settings buttons.
test.describe('Board settings sidebar and toolbar (#2436, #2435)', () => {
  test.beforeEach(async ({ page }) => {
    await routeAuth(page)
    await routeBoard(page)
    await page.goto(`/boards/${BOARD_FULL.id}`)
    await expect(page.getByText(CARD.title).first()).toBeVisible({ timeout: 10_000 })
  })

  test('the toolbar Settings button opens Board settings; arrow keys walk the sidebar', async ({ page }) => {
    await page.getByRole('button', { name: 'Settings' }).click()
    const dialog = page.getByRole('dialog', { name: 'Board settings' })
    await expect(dialog).toBeVisible()
    const members = dialog.getByRole('tab', { name: /^Members/ })
    await members.focus()
    await page.keyboard.press('ArrowDown')
    await expect(dialog.getByRole('tab', { name: 'Sharing' })).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(dialog.getByRole('tab', { name: 'Sharing' })).toHaveAttribute('aria-selected', 'true')
    await page.keyboard.press('Tab')
    await expect(dialog.getByRole('tabpanel')).toBeFocused()
  })

  test('Find a setting jumps to the Export section', async ({ page }) => {
    await page.keyboard.press('Control+,')
    const dialog = page.getByRole('dialog', { name: 'Board settings' })
    const find = dialog.getByRole('searchbox', { name: 'Find a setting' })
    await find.fill('export history')
    await page.keyboard.press('Enter')
    await expect(dialog.getByRole('tab', { name: 'Export' })).toHaveAttribute('aria-selected', 'true')
    await expect(dialog.getByRole('heading', { name: 'Export history' })).toBeVisible()
    await find.fill('zzzz')
    await expect(dialog.getByText(/No setting matches/)).toBeVisible()
  })

  test('the toolbar Export button opens the export modal', async ({ page }) => {
    await page.getByRole('button', { name: 'Export' }).click()
    await expect(page.getByRole('button', { name: 'Export JSON' })).toBeVisible()
  })
})

test.describe('toolbar at 390px (#2435)', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true })

  test('Export and Settings fit without sideways scroll and keep their names', async ({ page }) => {
    await routeAuth(page)
    await routeBoard(page)
    await page.goto(`/boards/${BOARD_FULL.id}`)
    await expect(page.getByText(CARD.title).first()).toBeVisible({ timeout: 10_000 })
    const toolbar = page.getByRole('navigation', { name: 'Board toolbar' })
    for (const name of ['Export', 'Settings']) {
      const btn = toolbar.getByRole('button', { name })
      await expect(btn).toBeVisible()
      const box = await btn.boundingBox()
      expect(box!.width).toBeGreaterThanOrEqual(43.5)
      expect(box!.height).toBeGreaterThanOrEqual(43.5)
    }
    const overflowX = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
    expect(overflowX).toBeLessThanOrEqual(0)
    const toolbarScroll = await toolbar.evaluate((el) => el.scrollWidth - el.clientWidth)
    expect(toolbarScroll).toBeLessThanOrEqual(0)
  })
})
