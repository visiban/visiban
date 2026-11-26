import { test, expect, type Page, type Locator } from '@playwright/test'
import { routeAuth } from './helpers'
import { BOARD_FULL, USER } from './fixtures/board'
import { ANALYTICS, FLOW_OVERVIEW, LONG_CARD, LONG_LANE, MOVEMENTS, SUMMARY } from './fixtures/toolbar-views'

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
  for (const [path, body] of [
    ['summary/', SUMMARY],
    ['movements/', MOVEMENTS],
    ['analytics/', ANALYTICS],
    ['metrics/overview/', FLOW_OVERVIEW],
  ] as const) {
    // A trailing * covers the query string these reads carry.
    await page.route(`**/api/v1/boards/${BOARD_FULL.id}/${path}*`, (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) }),
    )
  }
  await page.routeWebSocket(`**/ws/boards/${BOARD_FULL.id}/`, (ws) => {
    ws.send(JSON.stringify({ event: 'connected', data: {} }))
  })
}

// A control's box, waiting out the frame where the toolbar is between renders: right after
// Board to Lens (and on first paint) boundingBox() can return null for a tab that exists.
async function boxOf(locator: Locator): Promise<{ x: number; y: number; width: number; height: number }> {
  // Return the box the poll saw: a second boundingBox() call can land in the next remount frame and be null.
  let box: { x: number; y: number; width: number; height: number } | null = null
  await expect.poll(async () => {
    box = await locator.boundingBox()
    return box !== null
  }).toBe(true)
  return box!
}

// Wait until the named view's toolbar is the one on screen, so an "after" box is read from it and not from
// the outgoing view (#2486). The wait must be on a signal only the new view has: the Board view also has a
// button whose name contains "Filters" ("Filters and view options"), so waiting on `name: 'Filters'` passed
// before the Lens toolbar mounted. In that outgoing frame the Board tab sat 1px left, because the click's
// own actionability step scrolled the 122px-wide strip by 1px to show the Lens tab, which was clipped by
// 1.45px. A user's press does not scroll the strip, and the Lens view mounts a fresh strip at scrollLeft 0.
async function showsView(page: Page, name: string) {
  // Matched by text prefix: the Analytics tab's name carries its "Beta" chip.
  await expect(page.getByTestId('view-tab-strip').locator('[aria-current="page"]')).toHaveText(new RegExp(`^${name}`), { timeout: 30_000 })
  if (name === 'Lens') await expect(page.getByText('Columns: Status')).toBeVisible({ timeout: 30_000 })
}

// Wait for content that only a successful load renders: the 390px width check passes trivially on an
// error or loading screen (#2486).
async function showsContent(page: Page, view: 'Summary' | 'History' | 'Analytics') {
  const content = {
    Summary: page.getByRole('cell', { name: LONG_LANE }),
    History: page.getByTestId('history-row').filter({ hasText: LONG_CARD }).first(),
    Analytics: page.getByTestId('flow-wip-age'),
  }[view]
  await expect(content).toBeVisible({ timeout: 30_000 })
}

test.describe('Lens toolbar', () => {
  test('Summary, History and Analytics do not shift the tabs or scroll sideways at 390px (#2321)', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 800 })
    await setup(page)
    await page.goto(`/boards/${BOARD_FULL.id}?view=board`, { timeout: 60_000 })
    const boardTab = page.getByRole('button', { name: 'Board', exact: true })
    await expect(boardTab).toBeVisible({ timeout: 30_000 })
    await showsView(page, 'Board')
    const base = await boxOf(boardTab)
    for (const view of ['Summary', 'History', 'Analytics'] as const) {
      await page.goto(`/boards/${BOARD_FULL.id}?view=${view.toLowerCase()}`, { timeout: 60_000 })
      await showsView(page, view)
      await showsContent(page, view)
      const box = await boxOf(page.getByRole('button', { name: 'Board', exact: true }))
      expect(Math.abs(box.y - base.y), `${view} tab y`).toBeLessThanOrEqual(1)
      expect(Math.abs(box.x - base.x), `${view} tab x`).toBeLessThanOrEqual(1)
      const noSideScroll = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)
      expect(noSideScroll, `${view} no sideways scroll`).toBe(true)
      // The app shell is overflow-hidden, so the page check above cannot see view content that is too
      // wide: it is clipped, not scrolled. The view's own box must fit the viewport too (#2486).
      const root = {
        Summary: page.getByRole('table').locator('..'),
        History: page.getByTestId('movement-history-view'),
        Analytics: page.getByTestId('analytics-page'),
      }[view]
      const rootBox = await boxOf(root)
      expect(rootBox.x + rootBox.width, `${view} view fits the viewport`).toBeLessThanOrEqual(390)
      // Summary and History scroll their tables sideways inside the view; Analytics has no such table.
      if (view === 'Analytics') {
        expect(await root.evaluate((el) => el.scrollWidth - el.clientWidth), 'Analytics inner sideways scroll').toBeLessThanOrEqual(0)
      }
    }
  })

  test('Board to Lens does not move the tabs, and the 390px page never scrolls sideways', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 800 })
    await setup(page)
    await page.goto(`/boards/${BOARD_FULL.id}?view=board`, { timeout: 60_000 })
    const tab = page.getByRole('button', { name: 'Lens', exact: true })
    await expect(tab).toBeVisible({ timeout: 30_000 })
    await showsView(page, 'Board')
    const boardTabY = await boxOf(page.getByRole('button', { name: 'Board', exact: true }))
    await tab.click()
    await showsView(page, 'Lens')
    const after = await boxOf(page.getByRole('button', { name: 'Board', exact: true }))
    expect(Math.abs(after.x - boardTabY.x)).toBeLessThan(1)
    expect(Math.abs(after.y - boardTabY.y)).toBeLessThan(1)
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    )
    expect(overflow).toBeLessThanOrEqual(0)
    await expect(page.getByRole('button', { name: /card layout/i })).toBeVisible()
    // The page check alone cannot catch the old bug (the row scrolled inside its own box).
    const toolbar = await page.getByTestId('board-toolbar').evaluate((el) => {
      const nav = el.closest('nav') ?? el
      return { scroll: nav.scrollWidth, client: nav.clientWidth }
    })
    expect(toolbar.scroll).toBeLessThanOrEqual(toolbar.client)
    const controls = [
      page.getByRole('button', { name: /^Filters/ }),
      page.getByRole('button', { name: /card layout/i }),
      page.getByText('Columns: Status'),
      page.getByText('Swimlanes: Milestone'),
    ]
    for (const c of controls) {
      const b = (await c.first().boundingBox())!
      expect(b.x + b.width).toBeLessThanOrEqual(390)
    }
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
    // Portaled out of the toolbar nav, so no ancestor overflow box can clip it.
    expect(await menu.evaluate((el) => !el.closest('nav'))).toBe(true)
    const hit = await menu.evaluate((el) => {
      const r = el.getBoundingClientRect()
      const top = document.elementFromPoint(r.left + r.width / 2, r.bottom - 2)
      return !!top && el.contains(top)
    })
    expect(hit).toBe(true)
  })
})

test.describe('Lens toolbar at 1440px', () => {
  test('the tabs do not move between Board and Lens, and the controls share their row band', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await setup(page)
    await page.goto(`/boards/${BOARD_FULL.id}?view=board`, { timeout: 60_000 })
    const names = ['Board', 'Lens', 'Summary', 'History']
    const tabBox = (name: string) => boxOf(page.getByRole('button', { name, exact: true }))
    await expect(page.getByRole('button', { name: 'Lens', exact: true })).toBeVisible({ timeout: 30_000 })
    await showsView(page, 'Board')
    const before = await Promise.all(names.map(tabBox))
    await page.getByRole('button', { name: 'Lens', exact: true }).click()
    await showsView(page, 'Lens')
    const after = await Promise.all(names.map(tabBox))
    // The active tab's weight changes its own width, so tabs are compared on
    // their origin row (y and height); the first tab also keeps its x.
    expect(after[0].x).toBe(before[0].x)
    after.forEach((box, i) => {
      expect(box.y).toBe(before[i].y)
      expect(box.height).toBe(before[i].height)
    })
    const filters = await boxOf(page.getByRole('button', { name: 'Filters' }))
    const pivot = await boxOf(page.getByText('Columns: Status'))
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
