import { test, expect, type Page, type Locator } from '@playwright/test'
import { routeAuth, routeBoard } from './helpers'
import { BOARD_FULL, BOARD_TEAM, USER, SWIMLANE, CARD, COLUMN_TODO, COLUMN_DONE, CHILD_BOARD_OPTIONS_TEAM } from './fixtures/board'


// Controls under 44px in their smaller dimension inside the given roots. Card faces are skipped:
// the face is the 44px target and its select checkbox stays 16px (frontend/CLAUDE.md § Phone layout).
async function smallControls(page: Page, roots: string[]): Promise<string[]> {
  return page.evaluate((rs) => {
    const out: string[] = []
    for (const sel of rs) {
      document.querySelectorAll(`${sel} button, ${sel} a, ${sel} [role="tab"], ${sel} input, ${sel} textarea, ${sel} select, ${sel} [role="combobox"]`).forEach((el) => {
        if (el.closest('[data-card-id]')) return
        // A native checkbox or radio stays 16px by design; its <label> row is the touch target, so measure that (#2341).
        const isCheck = el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio')
        const r = ((isCheck && el.closest('label')) || el as HTMLElement).getBoundingClientRect()
        if (r.width === 0 && r.height === 0) return
        if (Math.min(r.width, r.height) < 43.5) out.push(`${el.tagName} ${(el.textContent || el.getAttribute('aria-label') || '').trim().slice(0, 30)} ${Math.round(r.width)}x${Math.round(r.height)}`)
      })
    }
    return Array.from(new Set(out))
  }, roots)
}

// Menu options (role=option) below the 44px floor; smallControls does not cover them.
async function optionsBelowFloor(page: Page): Promise<string[]> {
  return page.evaluate(() => Array.from(document.querySelectorAll('[role="option"], [role="menuitem"]'))
    .map((el) => ({ el, r: el.getBoundingClientRect() }))
    .filter(({ r }) => r.width > 0 && r.height > 0 && Math.min(r.width, r.height) < 43.5)
    .map(({ el, r }) => `${(el.textContent || '').trim().slice(0, 30)} ${Math.round(r.width)}x${Math.round(r.height)}`))
}

// Pairs of header and toolbar controls whose boxes overlap (a control may not cover another).
async function overlappingControls(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const els = Array.from(document.querySelectorAll('[role="banner"] button, [role="banner"] a, [data-testid="shell-fallback-bar"] button, nav[aria-label="Board toolbar"] button'))
      .filter((el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden' })
    const name = (el: Element) => (el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 24)
    // The part a user sees: a tab scrolled out of the tab strip's own box (#2348) is clipped, not overlapping the icons after it.
    const shown = (el: Element) => {
      let r = el.getBoundingClientRect()
      for (let p = el.parentElement; p; p = p.parentElement) {
        if (getComputedStyle(p).overflowX === 'visible') continue
        const c = p.getBoundingClientRect()
        r = new DOMRect(Math.max(r.left, c.left), r.top, Math.max(0, Math.min(r.right, c.right) - Math.max(r.left, c.left)), r.height)
      }
      return r
    }
    const out: string[] = []
    for (let i = 0; i < els.length; i++) {
      for (let j = i + 1; j < els.length; j++) {
        if (els[i].contains(els[j]) || els[j].contains(els[i])) continue
        const a = shown(els[i]), b = shown(els[j])
        const w = Math.min(a.right, b.right) - Math.max(a.left, b.left)
        const h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top)
        if (w > 1 && h > 1) out.push(`${name(els[i])} overlaps ${name(els[j])}`)
      }
    }
    return out
  })
}

// Phone layout (#2277): one column at a time, lanes stacked, 44px targets in the board body.
test.describe('board phone layout', () => {
  test.use({ viewport: { width: 390, height: 844 } })

  test.beforeEach(async ({ page }) => {
    await routeAuth(page)
    await routeBoard(page)
    await page.goto(`/boards/${BOARD_FULL.id}`)
    await expect(page.getByTestId('phone-board')).toBeVisible({ timeout: 10_000 })
  })

  test('switches columns and shows only the selected column\'s cards', async ({ page }) => {
    const switcher = page.getByTestId('phone-column-switcher')
    const todo = switcher.getByRole('tab', { name: /To Do/ })
    const done = switcher.getByRole('tab', { name: /Done/ })
    await expect(todo).toHaveAttribute('aria-selected', 'true')
    await expect(page.locator(`[data-card-id="${CARD.id}"]`)).toBeVisible()
    await done.click()
    await expect(done).toHaveAttribute('aria-selected', 'true')
    await expect(page.locator(`[data-card-id="${CARD.id}"]`)).toHaveCount(0)
  })

  test('collapses and expands a lane', async ({ page }) => {
    const lane = page.getByRole('button', { name: /Collapse lane/ })
    await expect(page.locator(`[data-card-id="${CARD.id}"]`)).toBeVisible()
    await lane.click()
    await expect(page.locator(`[data-card-id="${CARD.id}"]`)).toHaveCount(0)
    await page.getByRole('button', { name: /Expand lane/ }).click()
    await expect(page.locator(`[data-card-id="${CARD.id}"]`)).toBeVisible()
  })

  test('has no sideways page scroll and every board-body control is at least 44px', async ({ page }) => {
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
    expect(overflow).toBeLessThanOrEqual(0)
    const small = await smallControls(page, ['[data-testid="phone-board"]', '[data-testid="show-chips"]', '[role="banner"]', '[data-testid="shell-fallback-bar"]', 'nav[aria-label="Board toolbar"]'])
    expect(small).toEqual([])
    expect(await overlappingControls(page)).toEqual([])
    const faces = await page.locator('[data-testid="phone-board"] [data-card-id]').evaluateAll((els) => els.map((el) => el.getBoundingClientRect().height))
    expect(faces.length).toBeGreaterThan(0)
    for (const h of faces) expect(h).toBeGreaterThanOrEqual(45.5) // 46px: holds the 44px More actions button inside the face (#2402)
  })

  test('a long board name in a group shrinks so Star and Health stay inside the viewport (#2333)', async ({ page }) => {
    const name = 'Quarterly platform migration and infrastructure hardening board'
    await routeBoard(page, { ...BOARD_FULL, group: 7, group_name: 'Platform engineering and operations', name } as unknown as typeof BOARD_FULL)
    await page.goto(`/boards/${BOARD_FULL.id}`)
    await expect(page.getByTestId('phone-board')).toBeVisible()
    const banner = page.getByRole('banner')
    // Phones show only the last crumb; the group crumb is hidden, not clipped.
    await expect(banner.getByRole('link', { name: 'Platform engineering and operations' })).toBeHidden()
    const nameBtn = banner.getByRole('button', { name: `${name}, switch board` })
    await expect(nameBtn).toBeVisible()
    const nameBox = (await nameBtn.boundingBox())!
    for (const ctl of [banner.getByRole('button', { name: 'Star board' }), banner.getByRole('button', { name: /^Health status/ })]) {
      await expect(ctl).toBeVisible()
      const box = (await ctl.boundingBox())!
      expect(box.x).toBeGreaterThanOrEqual(0)
      expect(box.x + box.width).toBeLessThanOrEqual(390)
      expect(box.x).toBeGreaterThanOrEqual(nameBox.x + nameBox.width - 1)
      expect(Math.min(box.width, box.height)).toBeGreaterThanOrEqual(43.5)
    }
    // The name truncates with an ellipsis instead of pushing the controls out.
    // The board switcher's label span carries the truncation (#2473).
    expect(await nameBtn.locator('span.truncate').evaluate((el) => el.scrollWidth > el.clientWidth && getComputedStyle(el).textOverflow === 'ellipsis')).toBe(true)
    expect(await overlappingControls(page)).toEqual([])
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
    expect(overflow).toBeLessThanOrEqual(0)
  })

  test('the notifications panel stays inside the viewport and Mark all read is 44px (#2333)', async ({ page }) => {
    // The list endpoint is a bare array; the shared helper's paginated stub would crash the panel.
    await page.route(/\/api\/v1\/notifications\/$/, (route) => route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify([{ id: 1, verb: 'Ada moved Fix login to Done', created_at: new Date().toISOString(), board_id: BOARD_FULL.id, card_id: null, action_type: 'card_moved', is_read: false }]),
    }))
    await page.getByRole('button', { name: /^Notifications/ }).click()
    await expect(page.getByText('Ada moved Fix login to Done')).toBeVisible()
    const panel = page.getByText('Notifications', { exact: true }).locator('xpath=ancestor::div[contains(@class, "shadow-xl")][1]')
    await expect(panel).toBeVisible()
    const box = (await panel.boundingBox())!
    expect(box.x).toBeGreaterThanOrEqual(0)
    expect(box.x + box.width).toBeLessThanOrEqual(390)
    // Below the header, not over it.
    const header = (await page.getByRole('banner').boundingBox())!
    expect(box.y).toBeGreaterThanOrEqual(header.y + header.height - 1)
    const markAll = panel.getByRole('button', { name: /Mark all read/ })
    expect((await markAll.boundingBox())!.height).toBeGreaterThanOrEqual(43.5)
  })

  test('the header and toolbar show icon buttons for Search, Activity and Filter, with names and the four tabs (#2333)', async ({ page }) => {
    const toolbar = page.getByRole('navigation', { name: 'Board toolbar' })
    // View has no button of its own on phones: the Filter button opens it (#2340).
    await expect(toolbar.getByRole('button', { name: 'View', exact: true })).toBeHidden()
    for (const name of ['Filters and view options', /activity drawer/, 'More board actions']) {
      const btn = toolbar.getByRole('button', { name })
      await expect(btn).toBeVisible()
      const box = await btn.boundingBox()
      expect(box!.width).toBeGreaterThanOrEqual(43.5)
      expect(box!.height).toBeGreaterThanOrEqual(43.5)
      // Icon-only: the visible label is gone, the accessible name stays.
      expect(box!.width).toBeLessThan(60)
    }
    for (const tab of ['Board', 'Summary', 'History', 'Analytics']) {
      await expect(toolbar.getByRole('button', { name: new RegExp(`^${tab}`) })).toBeVisible()
    }
    await expect(page.getByRole('button', { name: /^Search/ }).first()).toBeVisible()
    await expect(page.getByRole('button', { name: /^Notifications/ })).toBeVisible()
    await expect(page.getByRole('banner').getByRole('button', { name: 'Open navigation' })).toBeVisible()
  })

  test('the navigation bar and the app header are one row, over the toolbar and tabs (#2344)', async ({ page }) => {
    await expect(page.getByTestId('shell-fallback-bar')).toHaveCount(0)
    const banner = page.getByRole('banner')
    const hamburger = banner.getByRole('button', { name: 'Open navigation' })
    const nameBtn = banner.getByRole('button', { name: `${BOARD_FULL.name}, switch board` })
    const search = banner.getByRole('button', { name: /^Search/ })
    const [hb, nb, sb, bb] = await Promise.all([hamburger.boundingBox(), nameBtn.boundingBox(), search.boundingBox(), banner.boundingBox()])
    // One row: the hamburger, the board name and the header icons share a line.
    for (const box of [hb!, nb!, sb!]) {
      expect(box.y).toBeGreaterThanOrEqual(bb!.y - 1)
      expect(box.y + box.height).toBeLessThanOrEqual(bb!.y + bb!.height + 1)
    }
    expect(hb!.x + hb!.width).toBeLessThanOrEqual(nb!.x + 1)
    expect(nb!.x + nb!.width).toBeLessThanOrEqual(sb!.x + 1)
    expect(bb!.y).toBeLessThan(1)
    // Header row, then one toolbar row (tabs plus Filter, Activity and More): the separate navigation bar no longer adds a third (#2348).
    const toolbar = (await page.getByRole('navigation', { name: 'Board toolbar' }).boundingBox())!
    expect(toolbar.y + toolbar.height).toBeLessThanOrEqual(96)
    await hamburger.click()
    await expect(page.getByRole('dialog', { name: 'Main navigation' })).toBeVisible()
  })

  test('the header and toolbar stay on one row, 44px, without overlap in dark mode (#2344)', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark' })
    await page.reload()
    await expect(page.getByTestId('phone-board')).toBeVisible({ timeout: 10_000 })
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
    const toolbar = (await page.getByRole('navigation', { name: 'Board toolbar' }).boundingBox())!
    expect(toolbar.y + toolbar.height).toBeLessThanOrEqual(96)
    expect(await overlappingControls(page)).toEqual([])
    expect(await smallControls(page, ['[role="banner"]', 'nav[aria-label="Board toolbar"]'])).toEqual([])
  })

  test('the Filter button opens the View options too, and focus comes back to it (#2340)', async ({ page }) => {
    const filter = page.getByRole('button', { name: 'Filters and view options' })
    await filter.click()
    const filterPanel = page.getByTestId('filter-panel')
    await expect(filterPanel).toBeVisible()
    await filterPanel.getByRole('button', { name: 'View options' }).click()
    await expect(filterPanel).toBeHidden()
    const viewPanel = page.getByRole('dialog', { name: 'View options' })
    await expect(viewPanel).toBeVisible()
    await expect(viewPanel.getByRole('group', { name: 'Card density' })).toBeVisible()
    const box = (await viewPanel.boundingBox())!
    expect(box.x).toBeGreaterThanOrEqual(0)
    expect(box.x + box.width).toBeLessThanOrEqual(390)
    // The panel takes focus on open; Escape closes it and returns focus to the Filter button.
    await expect.poll(() => viewPanel.evaluate((el) => el.contains(document.activeElement))).toBe(true)
    await page.keyboard.press('Escape')
    await expect(viewPanel).toBeHidden()
    await expect(filter).toBeFocused()
  })

  test('every control in the open panels, menus, drawer and notifications is at least 44px (#2341)', async ({ page }) => {
    await page.route(/\/api\/v1\/notifications\/$/, (route) => route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify([{ id: 1, verb: 'Ada moved Fix login to Done', created_at: new Date().toISOString(), board_id: BOARD_FULL.id, card_id: null, action_type: 'card_moved', is_read: false }]),
    }))
    const sweep = async (root: string) => {
      await expect(page.locator(root).first()).toBeVisible()
      expect(await smallControls(page, [root])).toEqual([])
    }
    // Number and date filter editors need custom fields; an active filter shows the save-filter form.
    const def = (id: number, name: string, field_type: string) => ({
      id, uid: `cfuid00000${id}`, name, field_type, choices: [], position: id, show_on_card: false,
      is_required: false, help_text: '', number_prefix: '', number_suffix: '', number_decimals: null, choice_colors: {},
    })
    await routeBoard(page, { ...BOARD_FULL, custom_field_definitions: [def(1, 'Estimate', 'number'), def(2, 'Review by', 'date')] } as unknown as typeof BOARD_FULL)
    await page.goto(`/boards/${BOARD_FULL.id}?f_blocked=1`)
    await expect(page.getByTestId('phone-board')).toBeVisible({ timeout: 10_000 })
    await page.getByRole('button', { name: 'Filters and view options' }).click()
    const filterPanel = page.getByTestId('filter-panel')
    await sweep('[data-testid="filter-panel"]')
    // One row of each editor kind: checkbox list (Label), radio list (Due date), number, date.
    for (const row of [/^Label/, /^Due date/, /^Estimate/, /^Review by/]) {
      await filterPanel.getByRole('button', { name: row }).first().click()
      await sweep('[data-testid="filter-panel"]')
    }
    await filterPanel.getByRole('button', { name: 'Save filter' }).click()
    await expect(filterPanel.getByLabel('Save current filters as:')).toBeVisible()
    await sweep('[data-testid="filter-panel"]')
    await filterPanel.getByRole('button', { name: 'View options' }).click()
    await sweep('[data-testid="view-menu-panel"]')
    // The Preset and Overlay option menus render at document.body, outside the View panel.
    const viewPanel = page.getByTestId('view-menu-panel')
    for (const trigger of [/^Preset(:|$)/, 'Overlay']) {
      await viewPanel.getByRole('button', { name: trigger }).click()
      // The menu is portaled to document.body, so it is not inside the View panel.
      const menu = page.getByRole('menu').filter({ hasNot: page.getByTestId('view-menu-panel') }).last()
      await expect(menu).toBeVisible()
      const heights = await menu.locator('[role^="menuitem"]').evaluateAll((els) => els.map((el) => Math.round(el.getBoundingClientRect().height)))
      expect(heights.length).toBeGreaterThan(0)
      expect(Math.min(...heights)).toBeGreaterThanOrEqual(44)
      await page.keyboard.press('Escape')
    }
    await page.keyboard.press('Escape')
    await page.getByRole('button', { name: 'More board actions' }).click()
    await sweep('[role="menu"]')
    await page.keyboard.press('Escape')
    await page.getByRole('button', { name: /Account menu/ }).click()
    await sweep('[role="menu"]')
    await page.keyboard.press('Escape')
    await page.getByRole('button', { name: /^Notifications/ }).click()
    await expect(page.getByText('Ada moved Fix login to Done')).toBeVisible()
    await sweep('[role="banner"] .shadow-xl')
    await page.getByRole('button', { name: /^Notifications/ }).click()
    await page.getByRole('banner').getByRole('button', { name: 'Open navigation' }).click()
    await sweep('[role="dialog"][aria-label="Main navigation"]')
  })

  test('the filter bar facet menus, Activity drawer, Board Health popover and command palette are 44px (#2350, #2351)', async ({ page }) => {
    await page.goto(`/boards/${BOARD_FULL.id}`)
    await expect(page.getByTestId('phone-board')).toBeVisible({ timeout: 10_000 })
    const rowHeights = (sel: string) => page.locator(sel).evaluateAll((els) => els.map((el) => Math.round(el.getBoundingClientRect().height)))
    // Facet menus render at document.body, so they carry their own rules. The option's checkbox is a decorative 16px mark inside a 44px row (intended).
    await page.getByRole('button', { name: 'Filters and view options' }).click()
    await page.getByRole('button', { name: /^Show filter bar/ }).click()
    const bar = page.getByRole('search', { name: 'Board filters' })
    await expect(bar).toBeVisible()
    expect(await smallControls(page, ['[role="search"]'])).toEqual([])
    // The "+ Filter" menu is a CheckboxDropdown, as is every facet; its menu is portaled to document.body.
    await bar.getByRole('button', { name: '+ Filter' }).click()
    const optionRows = page.locator('[role="group"] label:has(input[type="checkbox"])')
    await expect(optionRows.first()).toBeVisible()
    const rows = await optionRows.evaluateAll((els) => els.map((el) => Math.round(el.getBoundingClientRect().height)))
    expect(rows.length).toBeGreaterThan(0)
    expect(Math.min(...rows)).toBeGreaterThanOrEqual(44)
    await page.keyboard.press('Escape')
    // The Saved filters menu is portaled too (AnchoredMenuPanel), so it carries its own descendant rule.
    await bar.getByRole('button', { name: 'Saved filters' }).click()
    await expect(page.getByRole('group', { name: 'Saved filters' })).toBeVisible()
    expect(await smallControls(page, ['[role="group"][aria-label="Saved filters"]'])).toEqual([])
    await page.keyboard.press('Escape')
    // Activity drawer.
    await page.getByRole('button', { name: 'Open activity drawer' }).click()
    await expect(page.getByTestId('activity-drawer')).toBeVisible()
    expect(await smallControls(page, ['[data-testid="activity-drawer"]'])).toEqual([])
    await page.getByTestId('activity-drawer').getByRole('button', { name: 'Close activity drawer' }).click()
    await expect(page.getByTestId('activity-drawer')).toBeHidden()
    // Board Health popover.
    await page.getByRole('button', { name: /^Set health status for/ }).first().click()
    const health = page.getByRole('dialog', { name: /^Health status for/ })
    await expect(health).toBeVisible()
    expect(await smallControls(page, ['[role="dialog"][aria-label^="Health status for"]'])).toEqual([])
    await page.keyboard.press('Escape')
    // Command palette (opened from the header Search button).
    await page.getByRole('banner').getByRole('button', { name: /^Search/ }).click()
    await expect(page.getByRole('combobox', { name: 'Command palette search' })).toBeVisible()
    expect(Math.round((await page.getByRole('combobox', { name: 'Command palette search' }).boundingBox())!.height)).toBeGreaterThanOrEqual(44)
    const items = await rowHeights('[role="listbox"][aria-label="Results"] [role="option"]')
    expect(items.length).toBeGreaterThan(0)
    expect(Math.min(...items)).toBeGreaterThanOrEqual(44)
  })

  test('the card actions menu items are 44px (#2350)', async ({ page }) => {
    await page.goto(`/boards/${BOARD_FULL.id}`)
    await expect(page.getByTestId('phone-board')).toBeVisible({ timeout: 10_000 })
    // The menu is portaled to document.body (the phone "More actions" menu is the same component), so it carries its own rule.
    await page.locator('[data-card-id]').first().click({ button: 'right' })
    const menu = page.getByTestId('card-context-menu')
    await expect(menu).toBeVisible()
    const heights = await menu.getByRole('menuitem').evaluateAll((els) => els.map((el) => Math.round(el.getBoundingClientRect().height)))
    expect(heights.length).toBeGreaterThan(0)
    expect(Math.min(...heights)).toBeGreaterThanOrEqual(44)
  })

  test('the tab strip scrolls and fades its right edge instead of clipping silently (#2348)', async ({ page }) => {
    await page.goto(`/boards/${BOARD_FULL.id}`)
    await expect(page.getByTestId('phone-board')).toBeVisible({ timeout: 10_000 })
    const strip = page.getByTestId('view-tab-strip')
    const m = await strip.evaluate((el) => ({ sw: el.scrollWidth, cw: el.clientWidth, right: el.getBoundingClientRect().right, fade: el.getAttribute('data-fade') }))
    expect(m.sw).toBeGreaterThan(m.cw)
    expect(m.fade).toBe('true')
    const filter = await page.getByRole('button', { name: 'Filters and view options' }).boundingBox()
    expect(m.right).toBeLessThanOrEqual(filter!.x + 0.5)
    // Switching to the last tab scrolls it into view.
    await page.getByRole('button', { name: 'Analytics' }).click()
    // Each view mounts its own strip, so the click remounts it: wait for the new strip's Analytics tab to be the
    // active one (aria-current="page") before measuring, since boundingBox() does not auto-wait.
    const analyticsTab = page.getByTestId('view-tab-strip').getByRole('button', { name: 'Analytics' })
    await expect(analyticsTab).toHaveAttribute('aria-current', 'page')
    await expect(strip).toBeVisible()
    // The scroll-into-view may settle over more than one frame.
    await expect(async () => {
      const analytics = await analyticsTab.boundingBox()
      const box = await strip.boundingBox()
      expect(analytics).not.toBeNull()
      expect(box).not.toBeNull()
      expect(analytics!.x + analytics!.width).toBeLessThanOrEqual(box!.x + box!.width + 1)
    }).toPass({ timeout: 5_000 })
  })

  test('the tab strip fade is on at 390px once the Lens tab mounts late, with no scroll (#2395)', async ({ page }) => {
    const lensUser = { ...USER, git_lens_enabled: true }
    await page.route(`**/api/v1/git-lens/connections/${BOARD_FULL.id}/`, async (route) => {
      await new Promise((r) => setTimeout(r, 1500))
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: 1, provider: 'gitlab', repo_slug: 'a/b', column_dim: 'status', swimlane_dim: 'milestone', created_by: { id: 1, username: 'u', display_name: 'U', avatar_url: '' }, created_at: '', updated_at: '' }) })
    })
    // Lens is on for this user; its tab appears once the connection lookup resolves, after first paint.
    for (const path of ['auth/user', 'auth/me']) {
      await page.route(`**/api/v1/${path}/`, async (route) => {
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(lensUser) })
      })
    }
    await page.goto(`/boards/${BOARD_FULL.id}`)
    await expect(page.getByTestId('phone-board')).toBeVisible({ timeout: 10_000 })
    await expect(page.getByRole('button', { name: 'Lens', exact: true })).toBeAttached({ timeout: 15_000 })
    const strip = page.getByTestId('view-tab-strip')
    // The strip's first child grows with its tabs, so the observer sees the late tab.
    await expect(strip).toHaveAttribute('data-fade', 'true')
    const m = await strip.evaluate((el) => ({ sw: el.scrollWidth, cw: el.clientWidth, left: el.scrollLeft, child: (el.firstElementChild as HTMLElement).offsetWidth }))
    expect(m.left).toBe(0)
    expect(m.sw).toBeGreaterThan(m.cw)
    expect(m.child).toBeGreaterThan(m.cw)
  })

  test('the Exit focus and Show all cards banner buttons are at least 44px (#2333)', async ({ page }) => {
    // Focus needs a second lane; the later route wins over the beforeEach one.
    await routeBoard(page, { ...BOARD_FULL, swimlanes: [SWIMLANE, { ...SWIMLANE, id: 2, uid: 'swimlane02x', name: 'Second lane', position: 1 }] })
    await page.goto(`/boards/${BOARD_FULL.id}`)
    await expect(page.getByTestId('phone-board')).toBeVisible()
    await page.getByRole('button', { name: /^Lane actions for / }).first().click()
    await page.getByRole('button', { name: /^Focus on / }).first().click()
    const exit = page.getByText('Focused on:').locator('..').getByRole('button', { name: 'Exit focus' })
    await expect(exit).toBeVisible()
    expect((await exit.boundingBox())!.height).toBeGreaterThanOrEqual(43.5)
    await exit.click()
    await page.goto(`/boards/${BOARD_FULL.id}?f_blocked=1`)
    const showAll = page.getByRole('button', { name: 'Show all cards' })
    await expect(showAll).toBeVisible()
    expect((await showAll.boundingBox())!.height).toBeGreaterThanOrEqual(43.5)
    expect(await smallControls(page, ['[role="status"]'])).toEqual([])
  })

  test('the filter bar, the collapsed-lanes strip and the lane-filter banner have 44px targets (#2333)', async ({ page }) => {
    // Filter bar (role=search): the `/` shortcut opens it and focuses its search box.
    await page.keyboard.press('/')
    await expect(page.getByRole('search', { name: 'Board filters' })).toBeVisible()
    expect(await smallControls(page, ['[role="search"]'])).toEqual([])
    // Collapsed-lanes strip: collapse the lane, then Expand all swimlanes appears.
    await page.getByRole('button', { name: /Collapse lane/ }).click()
    const expand = page.getByRole('button', { name: 'Expand all swimlanes' })
    await expect(expand).toBeVisible()
    expect((await expand.boundingBox())!.height).toBeGreaterThanOrEqual(43.5)
    // Lane-filter banner: a lane rule matching nothing hides every lane.
    const rule = encodeURIComponent('1.[{"f":"name","o":"contains","v":"zzzz"}]')
    await page.goto(`/boards/${BOARD_FULL.id}?f_lanes=${rule}`)
    const clear = page.getByRole('button', { name: 'Clear lane filters' })
    await expect(clear).toBeVisible()
    expect((await clear.boundingBox())!.height).toBeGreaterThanOrEqual(43.5)
  })

  test('the Lanes popover in the filter bar has 44px targets, its checkbox row included (#2350)', async ({ page }) => {
    // Two lanes offer the Lanes control. Its popover is not portaled, so it sits inside role=search, whose
    // descendant rule skips a checkbox: the "Hide lanes with no matching cards" label row carries its own 44px.
    await routeBoard(page, { ...BOARD_FULL, swimlanes: [SWIMLANE, { ...SWIMLANE, id: 2, uid: 'swimlane02x', name: 'Second lane', position: 1 }] })
    await page.goto(`/boards/${BOARD_FULL.id}`)
    await expect(page.getByTestId('phone-board')).toBeVisible({ timeout: 10_000 })
    await page.keyboard.press('/')
    const bar = page.getByRole('search', { name: 'Board filters' })
    await expect(bar).toBeVisible()
    await bar.getByRole('button', { name: /^Lane filters/ }).click()
    const pop = bar.getByRole('dialog', { name: 'Lane filters' })
    await expect(pop).toBeVisible()
    const row = pop.locator('label:has([data-testid="lane-filter-hide-unmatched"])')
    expect(Math.round((await row.boundingBox())!.height)).toBeGreaterThanOrEqual(44)
    expect(await smallControls(page, ['[role="search"] [role="dialog"]'])).toEqual([])
  })

  test('the column policy popover is 44px (#2350)', async ({ page }) => {
    const policy = { entry: ['Has an owner'], done: ['Reviewed'] }
    await routeBoard(page, { ...BOARD_FULL, columns: BOARD_FULL.columns.map((c, i) => (i === 0 ? { ...c, policy } : c)) } as unknown as typeof BOARD_FULL)
    await page.goto(`/boards/${BOARD_FULL.id}`)
    await expect(page.getByTestId('phone-board')).toBeVisible({ timeout: 10_000 })
    await page.getByRole('button', { name: /^Column policy for / }).first().click()
    const pop = page.getByRole('dialog', { name: /^Column policy for / })
    await expect(pop).toBeVisible()
    // The fixture user is an admin, so Edit policy is there to measure.
    await expect(pop.getByRole('button', { name: 'Edit policy' })).toBeVisible()
    expect(await smallControls(page, ['[role="dialog"][aria-label^="Column policy for"]'])).toEqual([])
  })

  test('adds a card to a lane and Edit swimlane opens the modal', async ({ page }) => {
    let body: Record<string, unknown> | null = null
    await page.route(`**/api/v1/boards/${BOARD_FULL.id}/cards/`, (route) => {
      if (route.request().method() !== 'POST') return route.fallback()
      body = JSON.parse(route.request().postData() ?? '{}')
      return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ ...CARD, id: 77, uid: 'card000077z', title: 'Phone card', position: 5 }) })
    })
    await page.getByRole('button', { name: /^\+?\s*Add card/ }).first().click()
    await page.getByLabel(/New card title/).fill('Phone card')
    await page.getByRole('button', { name: 'Add card', exact: true }).click()
    await expect(page.locator('[data-card-id="77"]')).toBeVisible()
    expect(body).toMatchObject({ column: 1, swimlane: 1, title: 'Phone card' })

    await page.getByRole('button', { name: /^Lane actions for / }).click()
    await page.getByRole('button', { name: /^Edit swimlane/ }).click()
    await expect(page.getByRole('dialog', { name: 'Edit Swimlane' })).toBeVisible()
  })

  test('Edit column opens the column modal; Add column and Add swimlane are reachable', async ({ page }) => {
    await page.getByTestId('phone-column-actions-toggle').click()
    await page.getByTestId('phone-column-actions').click()
    await expect(page.getByRole('dialog').first()).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByRole('button', { name: '+ Add column' })).toBeVisible()
    await expect(page.getByRole('button', { name: '+ Add swimlane' })).toBeVisible()
  })

  test('dragging a card does nothing at phone width', async ({ page }) => {
    const card = page.locator(`[data-card-id="${CARD.id}"]`)
    const before = await card.boundingBox()
    await page.mouse.move(before!.x + 40, before!.y + 20)
    await page.mouse.down()
    await page.mouse.move(before!.x + 40, before!.y + 200, { steps: 10 })
    // Asserted mid-drag: with sensors on, the card would fade (opacity-25) and the
    // DragOverlay copy would render a second face with the same title.
    await expect(page.getByText(CARD.title, { exact: true })).toHaveCount(1)
    await expect(card).not.toHaveClass(/opacity-25/)
    await page.mouse.up()
    await expect(card).toBeVisible()
    await expect(page.getByTestId('phone-column-switcher').getByRole('tab', { name: /To Do, 1 card/ })).toBeVisible()
  })

  test('Move later reorders the column through the reorder endpoint', async ({ page }) => {
    let order: unknown = null
    await page.route(`**/api/v1/boards/${BOARD_FULL.id}/columns/reorder/`, (route) => {
      order = JSON.parse(route.request().postData() ?? '{}').order
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ ...COLUMN_DONE, position: 0 }, { ...COLUMN_TODO, position: 1 }]) })
    })
    await page.getByTestId('phone-column-actions-toggle').click()
    const later = page.getByRole('button', { name: 'Move column To Do later' })
    await expect(page.getByRole('button', { name: 'Move column To Do earlier' })).toBeDisabled()
    await later.click()
    await expect.poll(() => order).toEqual([COLUMN_DONE.id, COLUMN_TODO.id])
    await expect(page.getByTestId('phone-column-switcher').getByRole('tab')).toHaveText([/Done/, /To Do/])
    await expect(page.getByRole('button', { name: 'Move column To Do later' })).toBeDisabled()
  })

  test('Move from the peek sheet moves the card to Done', async ({ page }) => {
    let moveBody: Record<string, unknown> | null = null
    await page.route(/\/api\/v1\/boards\/\d+\/cards\/\d+\/movements\/(\?.*)?$/, (r) =>
      r.fulfill({ status: 200, contentType: 'application/json', body: '[]' }))
    await page.route(`**/api/v1/boards/${BOARD_FULL.id}/cards/${CARD.id}/move/`, (route) => {
      moveBody = JSON.parse(route.request().postData() ?? '{}')
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ card: { ...CARD, column: 2, swimlane: 1, position: 0 } }) })
    })
    // Touch route to the peek: tap opens the detail panel; closing it leaves focus on the card, whose Show summary button then shows.
    await page.locator(`[data-card-id="${CARD.id}"]`).click()
    await page.keyboard.press('Escape')
    await page.locator(`[data-card-id="${CARD.id}"]`).getByTestId('card-show-summary').click()
    await expect(page.getByTestId('card-peek-sheet')).toBeVisible()
    await page.getByRole('button', { name: 'Move', exact: true }).click()
    await page.getByTestId('card-peek-move-form').locator('select').first().selectOption({ label: 'Done' })
    await page.getByRole('button', { name: 'Move card' }).click()
    await expect.poll(() => moveBody).toMatchObject({ column_id: 2 })
    await page.keyboard.press('Escape')
    await expect(page.getByRole('tab', { name: /To Do, 0 cards/ })).toBeVisible()
  })

  test('Move later in the peek sheet moves the card down one place and it stays after the server frame', async ({ page }) => {
    // A0 B1 C2 D3 in one cell. The move endpoint reads `position` as a raw slot
    // (no same-cell compaction), so Move later on B sends C's position + 1 and the
    // server answers B 3, D 4: the order A C B D, which the optimistic update
    // must already show, so the card.moved frame changes nothing visible.
    const mk = (id: number, title: string, position: number) => ({ ...CARD, id, uid: `card00000${id}a`, title, position })
    const cards = [mk(1, 'Alpha task', 0), mk(2, 'Bravo task', 1), mk(3, 'Charlie task', 2), mk(4, 'Delta task', 3)]
    await routeBoard(page, { ...BOARD_FULL, cards } as unknown as typeof BOARD_FULL)
    let socket: { send: (m: string) => void } | null = null
    await page.routeWebSocket(`**/ws/boards/${BOARD_FULL.id}/`, (ws) => {
      socket = ws
      ws.send(JSON.stringify({ event: 'connected', data: {} }))
    })
    await page.route(/\/api\/v1\/boards\/\d+\/cards\/\d+\/movements\/(\?.*)?$/, (r) =>
      r.fulfill({ status: 200, contentType: 'application/json', body: '[]' }))
    let moveBody: Record<string, unknown> | null = null
    const movedB = { ...cards[1], position: 3, version: (cards[1].version ?? 1) + 1 }
    await page.route(`**/api/v1/boards/${BOARD_FULL.id}/cards/2/move/`, (route) => {
      moveBody = JSON.parse(route.request().postData() ?? '{}')
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ card: movedB, movement: null }) })
    })
    await page.goto(`/boards/${BOARD_FULL.id}`)
    const faces = page.locator('[data-testid="phone-board"] [data-card-id]')
    await expect(faces).toHaveCount(4)
    const ids = () => faces.evaluateAll((els) => els.map((el) => el.getAttribute('data-card-id')))
    expect(await ids()).toEqual(['1', '2', '3', '4'])
    // Record every order the lane renders from here on, to catch a flash.
    await page.evaluate(() => {
      const w = window as unknown as { __orders: string[] }
      const read = () => Array.from(document.querySelectorAll('[data-testid="phone-board"] [data-card-id]')).map((el) => el.getAttribute('data-card-id')).join('')
      w.__orders = [read()]
      const root = document.querySelector('[data-testid="phone-board"]')!
      new MutationObserver(() => {
        const o = read()
        if (w.__orders[w.__orders.length - 1] !== o) w.__orders.push(o)
      }).observe(root, { childList: true, subtree: true })
    })
    // Touch route to the peek: tap opens the detail panel; closing it leaves focus on the card, whose Show summary button then shows.
    await page.locator('[data-card-id="2"]').click()
    await page.keyboard.press('Escape')
    await page.locator('[data-card-id="2"]').getByTestId('card-show-summary').click()
    const sheet = page.getByTestId('card-peek-sheet')
    await expect(sheet).toBeVisible()
    await sheet.getByRole('button', { name: 'Move later' }).click()
    await expect.poll(() => moveBody).toMatchObject({ column_id: 1, swimlane_id: 1, position: 3 })
    await expect.poll(ids).toEqual(['1', '3', '2', '4'])
    await expect.poll(() => socket !== null).toBe(true)
    socket!.send(JSON.stringify({
      event: 'card.moved', event_id: 501,
      data: { card: movedB, movement: null, sibling_positions: [{ id: 4, position: 4, version: cards[3].version ?? 1 }] },
    }))
    // A later frame with a visible effect: once it shows, the card.moved frame
    // before it (same socket, in order) has been applied.
    socket!.send(JSON.stringify({ event: 'card.updated', data: { ...cards[0], title: 'Alpha renamed', version: 2 } }))
    await expect(page.getByText('Alpha renamed')).toBeVisible()
    expect(await ids()).toEqual(['1', '3', '2', '4'])
    expect(await page.evaluate(() => (window as unknown as { __orders: string[] }).__orders)).toEqual(['1234', '1324'])
  })

  test('the empty-board Add card opens the input on phones', async ({ page }) => {
    const empty = { ...BOARD_FULL, cards: [] }
    await routeBoard(page, empty as unknown as typeof BOARD_FULL)
    await page.goto(`/boards/${BOARD_FULL.id}`)
    await page.getByTestId('board-empty-state').getByRole('button', { name: /Add a card/ }).click()
    await expect(page.getByLabel(/New card title/)).toBeVisible()
  })

  test('lane band second line: fields, Show N more details, lane WIP; one 44px collapse target (#2329, #2658)', async ({ page }) => {
    const def = (id: number, name: string, field_type = 'text') => ({
      id, uid: `sfd0000${id}x`, name, field_type, choices: [], position: id, show_on_row: false,
      is_admin_only: false, choice_colors: {}, number_prefix: '', number_suffix: '', number_decimals: null, created_at: '2026-01-01T00:00:00Z',
    })
    const lane = {
      ...SWIMLANE,
      name: 'North America with a long lane name that wraps on a phone',
      wip_limit: 0,
      custom_field_values: [{ field_definition: 1, value: 'Avery Brooks' }, { field_definition: 2, value: '600000' }, { field_definition: 3, value: 'West' }, { field_definition: 4, value: 'Enterprise' }],
    }
    const board = { ...BOARD_FULL, swimlanes: [lane], swimlane_custom_field_definitions: [def(1, 'Owner'), def(2, 'Quota', 'number'), def(3, 'Region'), def(4, 'Segment')] }
    await routeBoard(page, board as unknown as typeof BOARD_FULL)
    await page.goto(`/boards/${BOARD_FULL.id}`)
    const band = page.getByTestId('phone-lane-band')
    const details = band.getByTestId('phone-lane-band-details')
    await expect(details).toContainText('Avery Brooks')
    await expect(details).toContainText('600000')
    await expect(details).not.toContainText('West')
    await expect(band.getByTestId('swimlane-limit-stat')).toHaveText(/WIP \d+ \/ 0 over/)
    // One collapse target, at least 44px tall; the second line is outside it.
    const toggle = band.getByRole('button', { name: /Collapse lane/ })
    await expect(band.getByRole('button', { name: /(Collapse|Expand) lane/ })).toHaveCount(1)
    expect((await toggle.boundingBox())!.height).toBeGreaterThanOrEqual(43.5)
    await expect(toggle.getByTestId('phone-lane-band-details')).toHaveCount(0)
    // A board with no tiers set resolves them by position (#2658): the first two are Band, the rest Details.
    // The accessible name turns into "Hide details for …" once open, so hold it by test id.
    const more = band.getByTestId('phone-lane-fields-toggle')
    await expect(more).toHaveAccessibleName(/^Show 2 more fields for/)
    const box = (await more.boundingBox())!
    expect(Math.min(box.width, box.height)).toBeGreaterThanOrEqual(43.5)
    await more.click()
    await expect(details).toContainText('West')
    await expect(more).toHaveAttribute('aria-expanded', 'true')
    await expect(more).toHaveAccessibleName(/^Hide details for/)
    // Measured, not just a class string: at 390px the Details grid is one column (all values share one left edge, stacked).
    const values = band.getByTestId('swimlane-field-grid').locator('dd')
    await expect(values).toHaveCount(2)
    const boxes = await values.evaluateAll((els) => els.map((e) => { const r = e.getBoundingClientRect(); return { x: Math.round(r.x), y: r.y, right: r.right } }))
    expect(new Set(boxes.map((b) => b.x)).size).toBe(1)
    expect(boxes[1].y).toBeGreaterThan(boxes[0].y)
    expect(Math.max(...boxes.map((b) => b.right))).toBeLessThanOrEqual(390)
    // The long name wraps rather than pushing the page sideways.
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0)
    await toggle.click()
    await expect(page.getByRole('button', { name: /Expand lane/ })).toHaveAttribute('aria-expanded', 'false')
  })
})

// #2359: a tap opens the card detail panel (#2358), which carries the peek sheet's Move earlier / Move later.
test.describe('phone reorder from the card detail panel (#2359)', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true })

  test('tap a card, then Move earlier in the detail panel reorders it', async ({ page }) => {
    await routeAuth(page)
    const second = { ...CARD, id: CARD.id + 1000, uid: 'e2ereorder0002', title: 'Second in the cell', position: CARD.position + 1 }
    await routeBoard(page, { ...BOARD_FULL, cards: [CARD, second] })
    let moved: unknown = null
    await page.route(`**/api/v1/boards/${BOARD_FULL.id}/cards/${second.id}/move/**`, async (route) => {
      moved = route.request().postDataJSON()
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ card: { ...second, position: CARD.position, version: 2 } }) })
    })
    await page.goto(`/boards/${BOARD_FULL.id}`)
    const order = () => page.locator('[data-testid="phone-board"] [data-card-id]').evaluateAll((els) => els.map((el) => el.getAttribute('data-card-id')))
    await expect.poll(order).toEqual([String(CARD.id), String(second.id)])
    await page.locator(`[data-card-id="${second.id}"]`).tap()
    const reorder = page.getByTestId('card-detail-reorder')
    await expect(reorder).toBeVisible()
    const earlier = reorder.getByRole('button', { name: 'Move earlier' })
    const later = reorder.getByRole('button', { name: 'Move later' })
    // The last card in its cell can only step earlier; both targets are 44px.
    await expect(later).toHaveAttribute('aria-disabled', 'true')
    expect((await earlier.boundingBox())!.height).toBeGreaterThanOrEqual(43.5)
    await earlier.tap()
    await expect.poll(() => moved).not.toBeNull()
    expect(moved).toMatchObject({ column_id: CARD.column, swimlane_id: CARD.swimlane, position: CARD.position })
    await expect(earlier).toHaveAttribute('aria-disabled', 'true')
    await expect(later).not.toHaveAttribute('aria-disabled')
  })
  test('the detail panel Move button and its popover are 44px (#2359)', async ({ page }) => {
    await routeAuth(page)
    await routeBoard(page)
    await page.goto(`/boards/${BOARD_FULL.id}`)
    await page.locator(`[data-card-id="${CARD.id}"]`).tap()
    const move = page.getByRole('button', { name: 'Move card to different column or swimlane' })
    await expect(move).toBeVisible()
    const box = (await move.boundingBox())!
    expect(Math.round(Math.min(box.width, box.height))).toBeGreaterThanOrEqual(44)
    await move.tap()
    await expect(page.locator('[data-move-popover]')).toBeVisible()
    expect(await smallControls(page, ['[data-move-popover]'])).toEqual([])
  })

  test('a multi-select custom field menu in the detail panel is 44px (#2350)', async ({ page }) => {
    // MultiSelectDropdown is reachable on the phone board through the card detail panel's custom fields.
    const def = {
      id: 1, uid: 'sfuid000001', name: 'Tags', field_type: 'multi_select', choices: ['Alpha', 'Beta', 'Gamma'], position: 1,
      show_on_row: false, is_admin_only: false, is_required: false, help_text: '',
      number_prefix: '', number_suffix: '', number_decimals: null, choice_colors: {},
      created_at: '2026-01-01T00:00:00Z',
    }
    await routeAuth(page)
    await routeBoard(page, { ...BOARD_FULL, custom_field_definitions: [def] } as unknown as typeof BOARD_FULL)
    await page.goto(`/boards/${BOARD_FULL.id}`)
    await page.locator(`[data-card-id="${CARD.id}"]`).tap()
    await page.getByRole('button', { name: /Custom fields/ }).tap()
    const trigger = page.getByRole('button', { name: 'Tags: No value' })
    if (!(await trigger.count())) await page.getByRole('button', { name: /Custom fields/ }).tap()
    await trigger.scrollIntoViewIfNeeded()
    await trigger.tap()
    const search = page.getByRole('combobox', { name: /Filter Tags choices/ })
    await expect(search).toBeVisible()
    const listbox = page.getByRole('listbox')
    const rows = await listbox.getByRole('option').evaluateAll((els) => els.map((el) => Math.round(el.getBoundingClientRect().height)))
    expect(rows.length).toBe(3)
    expect(Math.min(...rows)).toBeGreaterThanOrEqual(44)
    expect(Math.round((await search.boundingBox())!.height)).toBeGreaterThanOrEqual(44)
    expect(Math.round((await page.getByRole('button', { name: 'Done' }).boundingBox())!.height)).toBeGreaterThanOrEqual(44)
  })
})

// #2378: the shared settings Toggle has a 44px hit area at max-sm (the track stays 36x20).
test.describe('phone settings toggles (#2378)', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true })

  test('every switch on the board settings Rules tab is at least 44px', async ({ page }) => {
    await routeAuth(page)
    await routeBoard(page)
    await page.goto(`/boards/${BOARD_FULL.id}`)
    await expect(page.getByText(CARD.title).first()).toBeVisible({ timeout: 10_000 })
    await page.keyboard.press('Control+,')
    const dialog = page.getByRole('dialog', { name: 'Board settings' })
    await expect(dialog).toBeVisible()
    await pickSettingsSection(dialog, 'Rules')
    await expect(dialog.getByRole('switch').first()).toBeVisible()
    const sizes = await dialog.getByRole('switch').evaluateAll((els) => els.map((el) => {
      const r = el.getBoundingClientRect()
      return `${el.getAttribute('aria-labelledby') ? (document.getElementById(el.getAttribute('aria-labelledby')!)?.textContent ?? '') : ''} ${Math.round(r.width)}x${Math.round(r.height)}`
    }))
    expect(sizes.length).toBeGreaterThan(0)
    expect(sizes.filter((s) => { const [w, h] = s.split(' ').pop()!.split('x').map(Number); return Math.min(w, h) < 44 })).toEqual([])
  })
})

// #2377: the card detail panel is a primary phone surface (a card tap opens it, #2358).
test.describe('phone card detail panel (#2377)', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true })

  test('every control in the card detail panel is at least 44px', async ({ page }) => {
    const user = BOARD_FULL.members[0].user
    const def = (id: number, name: string, field_type: string, choices: string[] = []) => ({
      id, uid: `sfuid00000${id}`, name, field_type, choices, position: id,
      show_on_row: false, is_admin_only: false, is_required: false, help_text: '',
      number_prefix: '', number_suffix: '', number_decimals: null, choice_colors: {},
      created_at: '2026-01-01T00:00:00Z',
    })
    const card = { ...CARD, custom_field_values: [{ field_definition: 2, value: 'https://example.com' }] }
    await routeAuth(page)
    await routeBoard(page, {
      ...BOARD_FULL, cards: [card],
      custom_field_definitions: [def(1, 'Tags', 'multi_select', ['Alpha', 'Beta']), def(2, 'Link', 'url'), def(3, 'Notes', 'text'), def(4, 'Qty', 'number')],
    } as unknown as typeof BOARD_FULL)
    const json = (body: unknown) => (route: import('@playwright/test').Route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
    const base = `**/api/v1/boards/${BOARD_FULL.id}/cards/${CARD.id}`
    const ts = '2026-01-02T00:00:00Z'
    await page.route(`${base}/checklist/`, json([
      { id: 1, text: 'First item', is_checked: false, position: 1, created_by: user, assignee: null, due_date: null },
      { id: 2, text: 'Second item', is_checked: true, position: 2, created_by: user, assignee: user, due_date: '2026-03-01' },
    ]))
    await page.route(`${base}/comments/`, json([{ id: 1, author: user, body: 'A comment', created_at: ts, updated_at: ts, imported_from_username: null }]))
    await page.route(`${base}/timeline/**`, json({ count: 1, next: null, previous: null, results: [{ id: 1, kind: 'activity', ts, actor: user, event_type: 'card_created', data: {}, imported_from_username: null }] }))
    for (const leaf of ['attachments', 'relations', 'activity', 'blocks']) await page.route(`${base}/${leaf}/`, json([]))
    await page.goto(`/boards/${BOARD_FULL.id}`)
    await page.locator(`[data-card-id="${CARD.id}"]`).tap()
    const panel = page.locator('[data-testid="card-detail-dialog"]')
    await expect(panel).toBeVisible()
    const sweep = () => smallControls(page, ['[data-testid="card-detail-dialog"]'])
    // Expand every collapsed section so its controls are measured too.
    for (const name of [/^Relations/, /^Checklist/, /^Attachments/, /Custom fields/]) {
      const t = page.getByRole('button', { name }).first()
      if (await t.count() && (await t.getAttribute('aria-expanded')) !== 'true') await t.tap()
    }
    await expect(page.getByText('First item')).toBeVisible()
    expect(await sweep()).toEqual([])
    // The block form (Details tab), then the Comments and History tabs.
    await panel.getByRole('button', { name: 'Block…' }).tap()
    await expect(panel.getByRole('textbox', { name: /reason/i }).first()).toBeVisible()
    expect(await sweep()).toEqual([])
    await panel.getByRole('button', { name: 'Block…' }).tap()
    await panel.getByRole('tab', { name: /^Comments/ }).tap()
    await expect(page.getByText('A comment')).toBeVisible()
    expect(await sweep()).toEqual([])
    await panel.getByRole('tab', { name: /^History/ }).tap()
    await expect(panel.getByRole('tabpanel')).toBeVisible()
    expect(await sweep()).toEqual([])
    await panel.getByRole('tab', { name: /^Details/ }).tap()
    // Custom fields is open (its toggle reports it), and its value controls were swept above.
    await expect(page.getByRole('button', { name: /Custom fields/ })).toHaveAttribute('aria-expanded', 'true')
    await expect(panel.getByRole('button', { name: 'Link: https://example.com' }).or(panel.getByText('Open link ↗')).first()).toBeVisible()
    // Opened states: the description editor (toolbar and Text color swatches), the relation form, and the new-label form.
    await panel.getByRole('button', { name: 'Edit description' }).tap()
    await expect(panel.getByRole('button', { name: 'Text color', exact: true })).toBeVisible()
    await panel.getByRole('button', { name: 'Text color', exact: true }).tap()
    await expect(panel.getByRole('button', { name: /^Text color (Custom|Red)/ }).first()).toBeVisible()
    expect(await sweep()).toEqual([])
    await panel.getByRole('button', { name: 'Cancel' }).first().tap()
    await panel.getByRole('button', { name: '+ Add relation' }).first().tap()
    await expect(panel.getByRole('radiogroup', { name: 'Relation type' })).toBeVisible()
    expect(await sweep()).toEqual([])
    await panel.getByRole('radiogroup', { name: 'Relation type' }).locator('xpath=following-sibling::button[last()]').tap()
    await panel.getByRole('button', { name: '+ Link a pull or merge request' }).tap()
    expect(await sweep()).toEqual([])
    await page.keyboard.press('Escape')
    await panel.getByRole('button', { name: '+ New label' }).tap()
    await expect(panel.getByLabel('New label name')).toBeVisible()
    expect(await sweep()).toEqual([])
    await page.keyboard.press('Escape')
    // The assignee menu is portaled out of the panel, so measure its options too.
    await panel.getByRole('combobox').first().tap()
    const rows = await page.getByRole('option').evaluateAll((els) => els.map((el) => Math.round(el.getBoundingClientRect().height)))
    expect(rows.length).toBeGreaterThan(0)
    expect(Math.min(...rows)).toBeGreaterThanOrEqual(44)
    await page.keyboard.press('Escape')
    // A custom-field value menu (#2350 pattern): the multi-select listbox, its search and Done.
    const trigger = page.getByRole('button', { name: 'Tags: No value' })
    if (!(await trigger.count())) await page.getByRole('button', { name: /Custom fields/ }).tap()
    await trigger.scrollIntoViewIfNeeded()
    await trigger.tap()
    const listbox = page.getByRole('listbox')
    await expect(listbox).toBeVisible()
    const optionRows = await listbox.getByRole('option').evaluateAll((els) => els.map((el) => Math.round(el.getBoundingClientRect().height)))
    expect(optionRows.length).toBe(2)
    expect(Math.min(...optionRows)).toBeGreaterThanOrEqual(44)
    expect(Math.round((await page.getByRole('button', { name: 'Done' }).boundingBox())!.height)).toBeGreaterThanOrEqual(44)
  })
})

// #2384: an admin's controls rest behind Column actions / Lane actions so cards are on screen.
test.describe('phone admin controls at rest (#2384)', () => {
  test.use({ viewport: { width: 390, height: 844 } })

  test('cards show at rest for an admin, and every admin action is reachable by keyboard at 44px', async ({ page }) => {
    await routeAuth(page)
    await routeBoard(page, { ...BOARD_FULL, swimlanes: [SWIMLANE, { ...SWIMLANE, id: 2, uid: 'swimlane02x', name: 'Second lane', position: 1 }] })
    await page.goto(`/boards/${BOARD_FULL.id}`)
    await expect(page.getByTestId('phone-board')).toBeVisible({ timeout: 10_000 })
    const card = page.locator(`[data-card-id="${CARD.id}"]`)
    await expect(card).toBeVisible()
    // The first card sits within the first screen, not pushed below rows of admin buttons.
    expect((await card.boundingBox())!.y).toBeLessThan(420)
    for (const name of [/^Edit column/, /^Edit swimlane/, /^Move column/, /^Move swimlane/, /^Field order/, /^Focus on /]) {
      await expect(page.getByRole('button', { name })).toHaveCount(0)
    }
    expect(await smallControls(page, ['[data-testid="phone-board"]'])).toEqual([])
    // Keyboard: focus the toggle, press Enter, and the actions appear, each 44px.
    const colToggle = page.getByTestId('phone-column-actions-toggle')
    await colToggle.focus()
    await page.keyboard.press('Enter')
    await expect(colToggle).toHaveAttribute('aria-expanded', 'true')
    await expect(page.getByRole('button', { name: /^Edit column/ })).toBeVisible()
    await expect(page.getByRole('button', { name: /^Move column/ }).first()).toBeVisible()
    const laneToggle = page.getByRole('button', { name: /^Lane actions for / }).first()
    await laneToggle.focus()
    await page.keyboard.press('Enter')
    await expect(page.getByRole('button', { name: /^Edit swimlane/ }).first()).toBeVisible()
    await expect(page.getByRole('button', { name: /^Focus on / }).first()).toBeVisible()
    await expect(page.getByRole('button', { name: /^Move swimlane/ }).first()).toBeVisible()
    expect(await smallControls(page, ['[data-testid="phone-board"]'])).toEqual([])
  })
})

// #2401: the card detail header on a phone, with long lane and column names.
test.describe('phone card detail header (#2401)', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true })

  test('long lane and column names truncate without overflow and every header control is 44px', async ({ page }) => {
    const longLane = 'Platform Reliability and Incident Response Engineering'
    const longCol = 'Awaiting Customer Acceptance Sign-off Review'
    await routeAuth(page)
    await routeBoard(page, {
      ...BOARD_FULL,
      swimlanes: [{ ...SWIMLANE, name: longLane }],
      columns: [{ ...COLUMN_TODO, name: longCol }, COLUMN_DONE],
    } as unknown as typeof BOARD_FULL)
    await page.goto(`/boards/${BOARD_FULL.id}`)
    await page.locator(`[data-card-id="${CARD.id}"]`).tap()
    const panel = page.locator('[data-testid="card-detail-dialog"]')
    await expect(panel).toBeVisible()
    const header = page.getByTestId('card-detail-title-block').locator('xpath=..')
    const hb = (await header.boundingBox())!
    const m = await header.evaluate((el) => ({ sw: el.scrollWidth, cw: el.clientWidth }))
    expect(m.sw).toBeLessThanOrEqual(m.cw)
    for (const name of ['Back to board', 'Block…', 'Close', 'Move card to different column or swimlane']) {
      const b = (await panel.getByRole('button', { name }).boundingBox())!
      expect(Math.min(b.width, b.height), name).toBeGreaterThanOrEqual(43.5)
      expect(b.x, name).toBeGreaterThanOrEqual(hb.x)
      expect(b.x + b.width, name).toBeLessThanOrEqual(hb.x + hb.width + 0.5)
    }
    for (const full of [longLane, longCol]) {
      const crumb = panel.getByRole('button', { name: full, exact: true })
      await expect(crumb).toHaveAttribute('title', full)
      const b = (await crumb.boundingBox())!
      expect(b.height).toBeGreaterThanOrEqual(43.5)
      expect(b.x + b.width).toBeLessThanOrEqual(hb.x + hb.width)
    }
  })
})

// #2436: at phone width the grouped sidebar is a "Section" select; pick a section by the start of its label.
async function pickSettingsSection(dialog: Locator, name: string) {
  const select = dialog.getByLabel('Section')
  const value = await select.locator('option').filter({ hasText: new RegExp(`^${name}`) }).first().getAttribute('value')
  await select.selectOption(value!)
  await expect(select).toHaveValue(value!)
}

// #2404: every control in Board settings, on every tab, is 44px at 390px (no carve-outs).
test.describe('phone board settings modal (#2404)', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true })

  test('every control on every tab is at least 44px', async ({ page }) => {
    await routeAuth(page)
    await routeBoard(page)
    await page.goto(`/boards/${BOARD_FULL.id}`)
    await expect(page.getByText(CARD.title).first()).toBeVisible({ timeout: 10_000 })
    await page.keyboard.press('Control+,')
    const dialog = page.getByRole('dialog', { name: 'Board settings' })
    await expect(dialog).toBeVisible()
    const tabs = ['Members', 'Display', 'Rules', 'Card fields', 'Swimlane fields', 'Sharing', 'Webhooks', 'Export', 'Danger zone']
    for (const t of tabs) {
      await pickSettingsSection(dialog, t)
      expect(await smallControls(page, ['[role="dialog"]']), `tab ${t}`).toEqual([])
      // Reachable sub-states: an open SelectDropdown menu (its options are measured too).
      const trigger = dialog.locator('[aria-haspopup="listbox"]:not([disabled])').first()
      if (await trigger.count()) {
        await trigger.dispatchEvent('click')
        await expect(trigger).toHaveAttribute('aria-expanded', 'true')
        expect(await smallControls(page, ['[role="dialog"]', '[role="listbox"]']), `tab ${t} open menu`).toEqual([])
        expect(await optionsBelowFloor(page), `tab ${t} menu options`).toEqual([])
        await trigger.dispatchEvent('click')
        await expect(trigger).toHaveAttribute('aria-expanded', 'false')
      }
    }
  })

  test('add, invite, webhook and confirm sub-states are at least 44px', async ({ page }) => {
    await routeAuth(page)
    // A second, non-owner member so the remove-board-role confirm is reachable.
    const other = { ...BOARD_FULL.members[0].user, id: 2, username: 'other', email: 'other@example.com', display_name: 'Other Member' }
    await routeBoard(page, { ...BOARD_FULL, members: [...BOARD_FULL.members, { id: 2, user: other, role: 'member', is_moderator: false, joined_at: '2026-01-02T00:00:00Z' }] } as unknown as typeof BOARD_FULL)
    await page.goto(`/boards/${BOARD_FULL.id}`)
    await expect(page.getByText(CARD.title).first()).toBeVisible({ timeout: 10_000 })
    await page.keyboard.press('Control+,')
    const dialog = page.getByRole('dialog', { name: 'Board settings' })
    await expect(dialog).toBeVisible()
    const openTab = (t: string) => pickSettingsSection(dialog, t)

    // Members: the Add member form (typing opens the search and the staged-invite controls) and the remove confirm.
    await openTab('Members')
    const search = dialog.getByPlaceholder(/search/i).first()
    await search.fill('a')
    expect(await smallControls(page, ['[role="dialog"]']), 'Add member typed').toEqual([])
    await search.fill('')
    const remove = dialog.getByRole('button', { name: /^Remove (direct )?board role for/ }).first()
    await expect(remove, 'a removable member row is reachable').toBeVisible()
    await remove.dispatchEvent('click')
    await expect(dialog.getByText(/from this board\?|Remove this board role\?/).first()).toBeVisible()
    expect(await smallControls(page, ['[role="dialog"]']), 'member remove confirm').toEqual([])

    // Rules: the hard WIP confirm.
    await openTab('Rules')
    const hard = dialog.getByRole('switch', { name: 'Hard mode (no admin override)' })
    await expect(hard, 'hard WIP toggle is reachable').toBeVisible()
    if ((await hard.getAttribute('aria-checked')) !== 'true') await hard.dispatchEvent('click')
    await expect(dialog.getByRole('button', { name: 'Confirm' }).first()).toBeVisible()
    expect(await smallControls(page, ['[role="dialog"]']), 'hard WIP confirm').toEqual([])

    // Webhooks: the create form.
    // An empty list is enough to reach the create form; routed after routeBoard so it wins.
    await page.route(`**/api/v1/boards/${BOARD_FULL.id}/webhooks/`, (route) => route.fulfill({ json: [] }))
    await page.route(`**/api/v1/boards/${BOARD_FULL.id}/webhooks/status/`, (route) => route.fulfill({
      json: { enabled: true, dispatcher_last_run_at: null, dispatcher_stale: false, subscribable_event_types: ['card.created', 'card.moved'], disable_after_failures: 10, test_timeout_seconds: 5 },
    }))
    await openTab('Webhooks')
    await dialog.getByRole('button', { name: 'Add webhook' }).first().dispatchEvent('click')
    await expect(dialog.getByRole('button', { name: /^Back|^Cancel/ }).first()).toBeVisible()
    expect(await smallControls(page, ['[role="dialog"]']), 'create webhook form').toEqual([])
  })
})

// #2407: the shared ModalWrapper carries one container rule (MODAL_PHONE_TOUCH_TARGETS), so every modal's controls are
// lifted to 44px at 390px through it. All 30 <ModalWrapper sites are covered (Board settings in its own #2404 block
// above, every tab). Swept here, one test per modal: this block (Keyboard shortcuts, Add Column, Add
// Swimlane, Edit Column, Edit Swimlane, Delete card confirm, Export Board, Import board, New Board) and the REMAINING
// block below (Delete column, Archive card, Add child, Admin Add user, Admin Transfer boards & deactivate, both Delete field dialogs, Move board, Trello import, Join a
// group, Create group, Delete board on the dashboard, Force password change, Force username rename, Connect provider).
// Also swept in REMAINING: GroupDetail "Delete board?" and "Delete group" (group server state mocked by routeGroup),
// CreateGroupModal's post-creation "created" phase, the "Delete this card?" branch of CardDetail.tsx (shares one
// wrapper with Archive), PolicyConfirmModal and LensConnectionModal.
// BoardSelector "Delete board?" and GroupDetail "Transfer ownership" no longer
// exist as ModalWrapper sites (drawer-only nav #2473; Transfer ownership is an inline panel).
test.describe('phone ModalWrapper modals (#2407)', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true })

  const openers: Array<[string, string, (page: Page) => Promise<void>]> = [
    ['Keyboard shortcuts', 'Keyboard shortcuts', async (page) => { await page.keyboard.press('?') }],
    ['Add Column', 'Add Column', async (page) => { await page.getByRole('button', { name: '+ Add column' }).dispatchEvent('click') }],
    ['Add Swimlane', 'Add Swimlane', async (page) => { await page.getByRole('button', { name: '+ Add swimlane' }).dispatchEvent('click') }],
    ['Edit Column', 'Edit Column', async (page) => {
      await page.getByTestId('phone-column-actions-toggle').dispatchEvent('click')
      await page.getByTestId('phone-column-actions').dispatchEvent('click')
    }],
    ['Edit Swimlane', 'Edit Swimlane', async (page) => {
      await page.getByRole('button', { name: /^Lane actions for / }).first().dispatchEvent('click')
      await page.getByRole('button', { name: /^Edit swimlane/ }).first().dispatchEvent('click')
    }],
    ['Delete card confirm', '', async (page) => {
      await page.locator(`[data-card-id="${CARD.id}"]`).tap()
      await page.getByRole('button', { name: 'Delete card', exact: true }).dispatchEvent('click')
    }],
    ['Export Board', 'Export Board', async (page) => {
      await page.getByRole('button', { name: 'Export', exact: true }).dispatchEvent('click')
    }],
    ['Import board', 'Import Board', async (page) => {
      await page.goto('/')
      await page.getByRole('button', { name: /^Import/ }).first().click()
    }],
    ['New Board', 'New Board', async (page) => {
      // The drawer carries no New board button (#2473); the dashboard does.
      await page.goto('/')
      await page.getByRole('button', { name: /New board/ }).first().dispatchEvent('click')
    }],
  ]

  for (const [label, name, open] of openers) {
    test(`${label}: controls are at least 44px and the title is clear of Close`, async ({ page }) => {
      await routeAuth(page)
      await routeBoard(page)
      await page.goto(`/boards/${BOARD_FULL.id}`)
      await expect(page.getByTestId('phone-board')).toBeVisible({ timeout: 10_000 })
      await open(page)
      const dialog = name ? page.getByRole('dialog', typeof name === 'string' ? { name, exact: true } : { name }) : page.getByRole('dialog').last()
      await expect(dialog).toBeVisible()
      expect(await smallControls(page, ['[role="dialog"]']), label).toEqual([])
      const close = dialog.getByRole('button', { name: 'Close' })
      if (await close.count()) {
        const title = (await dialog.getByRole('heading').first().boundingBox())!
        const cb = (await close.boundingBox())!
        expect(title.x + title.width, `${label} title vs Close`).toBeLessThanOrEqual(cb.x + 0.5)
      }
    })
  }
})

// #2407 (remaining sites): modals reached from the dashboard, the shell, or a forced state. Each entry routes the
// minimal extra state its opener needs on top of routeAuth/routeBoard.
type Extra = { user?: Record<string, unknown>; start?: string; board?: typeof BOARD_FULL; setup?: (page: Page) => Promise<void> }

// A custom field definition for the "Delete field?" dialogs (shape: CustomFieldDefinition in src/types).
const FIELD_DEF = { id: 5, uid: 'field00005', name: 'Region', field_type: 'text', choices: [], position: 0, show_on_card: false, has_values: false, is_required: false, help_text: '', number_prefix: '', number_suffix: '' }
const BOARD_WITH_FIELDS = { ...BOARD_FULL, custom_field_definitions: [FIELD_DEF], swimlane_custom_field_definitions: [{ ...FIELD_DEF, id: 6, uid: 'field00006', name: 'Lane owner' }] } as unknown as typeof BOARD_FULL

// The card-detail endpoints a tapped card fetches; every list is empty.
async function routeCardDetail(page: Page, boardId: number, card: unknown) {
  const ok = (body: unknown) => (route: import('@playwright/test').Route) => route.fulfill({ json: body as object })
  await page.route(`**/api/v1/boards/${boardId}/cards/${CARD.id}/`, ok(card))
  for (const p of ['movements', 'comments', 'activity', 'checklist', 'attachments', 'relations', 'blocks']) await page.route(`**/api/v1/boards/${boardId}/cards/${CARD.id}/${p}/`, ok([]))
  await page.route(`**/api/v1/boards/${boardId}/cards/${CARD.id}/timeline/**`, ok({ count: 0, next: null, previous: null, results: [] }))
  await page.route(new RegExp(`/api/v1/boards/${boardId}/cards/${CARD.id}/children/(\\?.*)?$`), ok({ count: 0, visible: true, offset: 0, limit: 50, results: [] }))
}
// Site admin → Users, the mocks admin-phone-row-actions.spec.ts uses: the page needs is_site_admin and an admin/** list.
const ADMIN_OWNED = [{ id: 40, uid: 'boarduid00040', name: 'Ops' }, { id: 41, uid: 'boarduid00041', name: 'Web' }]
const adminRow = (id: number, username: string, owned: typeof ADMIN_OWNED) => ({
  id, username, email: `${username}@example.com`, display_name: username, first_name: username, last_name: '', avatar_url: '',
  is_active: true, is_site_admin: id === 1, can_access_all_content: false, is_superuser: false, must_change_password: false,
  has_completed_tour: true, date_joined: '2024-01-01T00:00:00Z', owned_boards: owned,
})
async function routeAdminUsers(page: Page) {
  await page.route('**/api/v1/admin/**', (r) => r.fulfill({ json: { count: 0, offset: 0, page_size: 50, results: [] } }))
  await page.route('**/api/v1/admin/users/**', (r) => r.fulfill({ json: { count: 2, offset: 0, page_size: 50, results: [adminRow(1, 'testuser', []), adminRow(5, 'bob', ADMIN_OWNED)] } }))
}

// /groups/:id server state for the GroupDetail confirm dialogs: the signed-in user owns the group, so the page offers
// Delete group, and the one board carries cards, so Delete board? shows its type-to-confirm input.
const GROUP_OWNER = { id: USER.id, username: USER.username, display_name: 'Test User', avatar_url: '' }
const GROUP_2407 = {
  id: 7, name: 'Sales', description: '', owner: GROUP_OWNER, parent: null, parent_name: null, member_count: 1, board_count: 1,
  subgroup_count: 0, created_at: '2024-01-01T00:00:00Z', default_board_member_role: 'member', allowed_priorities: [], shared_labels: [],
  is_starred: false, navigation_only: false, can_place_boards: true, health_status: null, effective_health_status: null,
  health_status_source: null,
}
async function routeGroup(page: Page) {
  const ok = (body: unknown) => (r: import('@playwright/test').Route) => r.fulfill({ json: body as object })
  // An unmocked group socket closes on auth and signs the app out; a stub that only says connected keeps the page up.
  await page.routeWebSocket('**/ws/groups/7/', (ws) => { ws.send(JSON.stringify({ event: 'connected', data: {} })) })
  await page.route('**/api/v1/groups/7/**', ok([]))
  await page.route('**/api/v1/groups/7/', ok(GROUP_2407))
  await page.route('**/api/v1/groups/7/members/', ok([{ id: 1, user: GROUP_OWNER, role: 'admin', joined_at: '2024-01-01T00:00:00Z' }]))
  await page.route('**/api/v1/groups/7/boards/', ok([{ ...BOARD_FULL, cards: undefined, owner: GROUP_OWNER, group: 7, card_count: 3, archived_card_count: 0 }]))
  await page.route(/\/api\/v1\/boards\/\d+\/delete-impact\/?$/, ok({ child_cards: 0, parent_cards: 0, parent_boards: [], child_boards: [] }))
}
const REMAINING: Array<[string, string | RegExp, Extra, (page: Page) => Promise<void>]> = [
  ['Admin Add user', 'Add user', { user: { is_site_admin: true }, start: '/admin?tab=users', setup: routeAdminUsers }, async (page) => {
    await page.getByRole('button', { name: 'Add user', exact: true }).first().click()
  }],
  ['Admin Transfer boards & deactivate', 'Transfer boards & deactivate', { user: { is_site_admin: true }, start: '/admin?tab=users', setup: routeAdminUsers }, async (page) => {
    await page.getByRole('button', { name: 'More actions for bob' }).click()
    await page.getByRole('dialog', { name: 'bob' }).getByRole('button', { name: /Transfer boards and deactivate…/ }).click()
  }],
  ['Force password change', '', { user: { must_change_password: true }, start: '/' }, async () => {}],
  ['Force username rename', '', { user: { must_change_username: true }, start: '/' }, async () => {}],
  ['Connect provider', '', { user: { pending_connect_provider: 'github', pending_connect_identity: 'someone' }, start: '/' }, async () => {}],
  ['Join a group', 'Join a group', {
    start: '/',
    setup: async (page) => { await page.route(/\/api\/v1\/boards\/(\?starred=true)?$/, (r) => r.fulfill({ json: { count: 0, results: [] } })) },
  }, async (page) => { await page.getByRole('button', { name: /invite link/i }).first().dispatchEvent('click') }],
  ['Create group', 'New Group', { start: '/' }, async (page) => { await page.getByRole('button', { name: 'New group' }).first().dispatchEvent('click') }],
  ['Move board', 'Move board', { start: '/' }, async (page) => {
    await page.getByRole('button', { name: /^More actions for / }).first().dispatchEvent('click')
    await page.getByRole('menuitem', { name: 'Move to group' }).dispatchEvent('click')
  }],
  ['Delete board (dashboard)', 'Delete board?', { start: '/' }, async (page) => {
    await page.getByRole('button', { name: /^More actions for / }).first().dispatchEvent('click')
    await page.getByRole('menuitem', { name: 'Delete' }).dispatchEvent('click')
  }],
  ['Delete column', 'Delete column?', {}, async (page) => {
    // The delete button is disabled while the column holds cards, so open the empty Done column.
    await page.getByTestId('phone-column-switcher').getByRole('tab', { name: /Done/ }).click()
    await page.getByTestId('phone-column-actions-toggle').dispatchEvent('click')
    await page.getByTestId('phone-column-actions').dispatchEvent('click')
    await page.getByRole('button', { name: 'Delete column' }).dispatchEvent('click')
  }],
  ['Archive card', '', { setup: (page) => routeCardDetail(page, BOARD_FULL.id, CARD) }, async (page) => {
    await page.locator(`[data-card-id="${CARD.id}"]`).tap()
    await page.getByRole('button', { name: 'Archive card' }).dispatchEvent('click')
  }],
  // Add child retitles itself `Add child to <board>` once the target board resolves, so match the prefix.
  ['Add child', /^Add child/, {
    board: BOARD_TEAM as unknown as typeof BOARD_FULL,
    setup: async (page) => {
      await routeCardDetail(page, BOARD_TEAM.id, CARD)
      await page.route(`**/api/v1/boards/${BOARD_TEAM.id}/cards/${CARD.id}/child-board-options/`, (r) => r.fulfill({ json: CHILD_BOARD_OPTIONS_TEAM }))
    },
  }, async (page) => {
    await page.locator(`[data-card-id="${CARD.id}"]`).tap()
    await page.getByRole('tab', { name: 'Children' }).click()
    await page.getByTestId('card-children-tab').getByRole('button', { name: /^Add child/ }).click()
  }],
  ['Delete field (Card fields)', 'Delete field?', { board: BOARD_WITH_FIELDS }, async (page) => {
    await page.keyboard.press('Control+,')
    await pickSettingsSection(page.getByRole('dialog', { name: 'Board settings' }), 'Card fields')
    await page.getByRole('dialog', { name: 'Board settings' }).getByRole('button', { name: /Delete/ }).first().dispatchEvent('click')
  }],
  ['Delete field (Swimlane fields)', 'Delete field?', { board: BOARD_WITH_FIELDS }, async (page) => {
    await page.keyboard.press('Control+,')
    await pickSettingsSection(page.getByRole('dialog', { name: 'Board settings' }), 'Swimlane fields')
    await page.getByRole('dialog', { name: 'Board settings' }).getByRole('button', { name: /Delete/ }).first().dispatchEvent('click')
  }],
  ['Delete board (group page)', 'Delete board?', { start: '/groups/7', setup: routeGroup }, async (page) => {
    await page.getByRole('button', { name: /^More actions for / }).first().dispatchEvent('click')
    await page.getByRole('menuitem', { name: 'Delete' }).dispatchEvent('click')
  }],
  ['Delete group', /^Delete "/, { start: '/groups/7?tab=settings&section=danger-zone', setup: routeGroup }, async (page) => {
    await page.getByRole('button', { name: 'Delete group', exact: true }).dispatchEvent('click')
  }],
  ['Create group (created phase)', /created$/, {
    start: '/',
    setup: async (page) => { await page.route('**/api/v1/groups/', (r) => r.request().method() === 'POST' ? r.fulfill({ status: 201, json: { ...GROUP_2407, id: 8, name: 'Ops' } }) : r.fallback()) },
  }, async (page) => {
    await page.getByRole('button', { name: 'New group' }).first().dispatchEvent('click')
    await page.getByPlaceholder('e.g. Engineering').fill('Ops')
    await page.getByRole('button', { name: 'Create Group' }).dispatchEvent('click')
  }],
  ['Delete card (CardDetail)', 'Delete this card?', { setup: (page) => routeCardDetail(page, BOARD_FULL.id, CARD) }, async (page) => {
    await page.locator(`[data-card-id="${CARD.id}"]`).tap()
    await page.getByRole('button', { name: 'Delete card', exact: true }).dispatchEvent('click')
  }],
  ['Connect an issue lens', 'Connect an issue lens', {
    user: { git_lens_enabled: true },
    setup: async (page) => { await page.route(`**/api/v1/git-lens/connections/${BOARD_FULL.id}/`, (r) => r.fulfill({ status: 404, json: { detail: 'Not found.' } })) },
  }, async (page) => {
    await page.keyboard.press('Control+,')
    await pickSettingsSection(page.getByRole('dialog', { name: 'Board settings' }), 'Issue lens')
    await page.getByRole('button', { name: 'Connect a repository' }).dispatchEvent('click')
  }],
  // Confirm-on-entry column. The checklist opens only from a drop: the phone layout has no drag and the card menu's
  // Move to... commits directly, so the drag happens at desktop width, then the viewport shrinks to 390 with the
  // held move (board state, not layout) still open, and the dialog is swept there.
  ['Policy confirm', /^Move .* to Done\?$/, {
    board: { ...BOARD_FULL, columns: [COLUMN_TODO, { ...COLUMN_DONE, policy: { v: 1, entry: ['Tests pass', 'Docs updated'], done: [], mode: 'confirm' } }] } as unknown as typeof BOARD_FULL,
  }, async (page) => {
    await page.setViewportSize({ width: 1280, height: 800 })
    await expect(page.getByTestId('phone-board')).toBeHidden({ timeout: 10_000 })
    const cardEl = page.locator('[data-tour-step="card"]').filter({ hasText: CARD.title }).first()
    await expect(cardEl).toBeVisible({ timeout: 10_000 })
    const from = (await cardEl.boundingBox())!
    const to = (await page.getByText('Done').first().boundingBox())!
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2)
    await page.mouse.down()
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2 + 10, { steps: 3 })
    await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 10 })
    await page.mouse.up()
    await expect(page.getByRole('dialog', { name: /^Move .* to Done\?$/ })).toBeVisible({ timeout: 10_000 })
    await page.setViewportSize({ width: 390, height: 844 })
  }],
  ['Trello import', '', { start: '/' }, async (page) => {
    await page.getByRole('button', { name: /^Import/ }).first().click()
    await page.getByRole('button', { name: /Trello/ }).first().click()
  }],
]

test.describe('phone ModalWrapper modals, remaining sites (#2407)', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true })

  for (const [label, name, extra, open] of REMAINING) {
    test(`${label}: controls are at least 44px and the title is clear of Close`, async ({ page }) => {
      await routeAuth(page)
      if (extra.user) {
        const u = { ...USER, ...extra.user }
        for (const p of ['**/api/v1/auth/user/', '**/api/v1/auth/me/']) await page.route(p, (r) => r.fulfill({ json: u }))
      }
      const board = extra.board ?? BOARD_FULL
      await routeBoard(page, board)
      await extra.setup?.(page)
      await page.goto(extra.start ?? `/boards/${board.id}`)
      if (!extra.start) await expect(page.getByTestId('phone-board')).toBeVisible({ timeout: 10_000 })
      await open(page)
      const dialog = name ? page.getByRole('dialog', typeof name === 'string' ? { name, exact: true } : { name }) : page.getByRole('dialog').last()
      await expect(dialog).toBeVisible({ timeout: 10_000 })
      expect(await smallControls(page, ['[role="dialog"]']), label).toEqual([])
      const close = dialog.getByRole('button', { name: 'Close' })
      if (await close.count()) {
        const title = (await dialog.getByRole('heading').first().boundingBox())!
        const cb = (await close.boundingBox())!
        expect(title.x + title.width, `${label} title vs Close`).toBeLessThanOrEqual(cb.x + 0.5)
      }
    })
  }
})
