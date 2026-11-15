import { test, expect, type Page } from '@playwright/test'
import { routeAuth } from './helpers'
import { BOARD_FULL, USER } from './fixtures/board'

// #2302: the Lens tab uses the Board tab's wrapping toolbar. #2308: the Show row
// carries a Collapse all lanes button that drives the same lane state as the View menu.
const LENS_CONNECTION = {
  id: 1,
  provider: 'gitlab',
  repo_slug: 'a/b',
  column_dim: 'status',
  swimlane_dim: 'milestone',
  created_by: { id: 1, username: 'u', display_name: 'U', avatar_url: '' },
  created_at: '',
  updated_at: '',
}

async function setup(page: Page) {
  await routeAuth(page)
  const lensUser = { ...USER, git_lens_enabled: true }
  for (const path of ['auth/user', 'auth/me']) {
    await page.route(`**/api/v1/${path}/`, (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(lensUser) }),
    )
  }
  await page.route(`**/api/v1/boards/${BOARD_FULL.id}/full/`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(BOARD_FULL) }),
  )
  await page.route(`**/api/v1/boards/${BOARD_FULL.id}/saved-filters/`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) }),
  )
  await page.route(`**/api/v1/git-lens/connections/${BOARD_FULL.id}/`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(LENS_CONNECTION) }),
  )
  await page.route(`**/api/v1/git-lens/board/${BOARD_FULL.id}/**`, (route) =>
    route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ code: 'lens_error' }) }),
  )
  await page.routeWebSocket(`**/ws/boards/${BOARD_FULL.id}/`, (ws) => {
    ws.send(JSON.stringify({ event: 'connected', data: {} }))
  })
}

test.describe('Lens toolbar', () => {
  test('Board to Lens does not move the tabs, and the 390px page never scrolls sideways', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 800 })
    await setup(page)
    await page.goto(`/boards/${BOARD_FULL.id}?view=board`, { timeout: 60_000 })
    const tab = page.getByRole('button', { name: 'Lens', exact: true })
    await expect(tab).toBeVisible({ timeout: 30_000 })
    const boardTabY = (await page.getByRole('button', { name: 'Board', exact: true }).boundingBox())!
    await tab.click()
    await expect(page.getByRole('button', { name: 'Filters' })).toBeVisible()
    const after = (await page.getByRole('button', { name: 'Board', exact: true }).boundingBox())!
    expect(Math.abs(after.x - boardTabY.x)).toBeLessThan(1)
    expect(Math.abs(after.y - boardTabY.y)).toBeLessThan(1)
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    )
    expect(overflow).toBeLessThanOrEqual(0)
    await expect(page.getByRole('button', { name: /card layout/i })).toBeVisible()
  })

  test('pivot dropdown menu is not clipped', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 800 })
    await setup(page)
    await page.goto(`/boards/${BOARD_FULL.id}?view=board`)
    await page.getByRole('button', { name: 'Lens', exact: true }).click()
    await page.getByText('Columns: Status').click()
    const menu = page.getByRole('menu')
    await expect(menu).toBeVisible()
    const box = (await menu.boundingBox())!
    expect(box.height).toBeGreaterThan(60)
  })
})

test.describe('Lens toolbar at 1440px', () => {
  test('the tabs do not move between Board and Lens, and the controls share their row band', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await setup(page)
    await page.goto(`/boards/${BOARD_FULL.id}?view=board`, { timeout: 60_000 })
    const names = ['Board', 'Lens', 'Summary', 'History']
    const tabBox = async (name: string) =>
      (await page.getByRole('button', { name, exact: true }).boundingBox())!
    await expect(page.getByRole('button', { name: 'Lens', exact: true })).toBeVisible({ timeout: 30_000 })
    const before = await Promise.all(names.map(tabBox))
    await page.getByRole('button', { name: 'Lens', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Filters' })).toBeVisible()
    const after = await Promise.all(names.map(tabBox))
    // The active tab's weight changes its own width, so tabs are compared on
    // their origin row (y and height); the first tab also keeps its x.
    expect(after[0].x).toBe(before[0].x)
    after.forEach((box, i) => {
      expect(box.y).toBe(before[i].y)
      expect(box.height).toBe(before[i].height)
    })
    const filters = (await page.getByRole('button', { name: 'Filters' }).boundingBox())!
    const pivot = (await page.getByText('Columns: Status').boundingBox())!
    const tabs = after[0]
    for (const box of [filters, pivot]) {
      const mid = box.y + box.height / 2
      expect(mid).toBeGreaterThan(tabs.y)
      expect(mid).toBeLessThan(tabs.y + tabs.height)
    }
  })
})

test.describe('Collapse all lanes button', () => {
  test('toggles every lane and flips its label', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await setup(page)
    await page.goto(`/boards/${BOARD_FULL.id}?view=board`)
    const collapse = page.getByRole('button', { name: 'Collapse all lanes' })
    await expect(collapse).toBeVisible({ timeout: 10_000 })
    await collapse.click()
    await expect(page.getByRole('button', { name: 'Expand all lanes' })).toBeVisible()
    await page.getByRole('button', { name: 'Expand all lanes' }).click()
    await expect(page.getByRole('button', { name: 'Collapse all lanes' })).toBeVisible()
  })
})
