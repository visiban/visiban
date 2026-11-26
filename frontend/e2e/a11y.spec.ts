import { test, expect } from '@playwright/test'
import type { Page } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import { routeAuth, routeBoard } from './helpers'
import { BOARD_FULL, BOARD_LIST_ITEM, CARD, USER } from './fixtures/board'

// #1423 — axe-core scans of the states users actually live in, at WCAG 2.1 AA.
// A new violation fails the job. Violations that already existed when the gate
// landed are listed in BASELINE below: each entry names the state, the axe rule
// id, the exact number of offending nodes, and the OPEN issue that tracks the
// fix. The list may only shrink — an entry that no longer reproduces, or
// reproduces on fewer nodes than recorded, also fails, so fixing a violation
// forces its entry to be deleted or its count lowered. See
// docs/development/a11y-axe.md.

const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']

type StateName =
  | 'board view'
  | 'card detail dialog'
  | 'command palette'
  | 'filter bar expanded'
  | 'settings page'
  | 'member management modal'
  | 'mobile navigation'
  | 'group tree'
  | 'group detail page'

// state -> axe rule id -> { affected nodes }, with the tracking issue as a
// SUPPRESSED-UNTIL(#N) marker on the same line. The marker is the only place the
// issue is named, so CI's suppressions-check (scripts/check-suppression-issues.sh
// scans frontend/e2e) fails once that issue closes while the entry remains.
// maxNodes is exact: more nodes is a new violation, fewer means lower the count.
const BASELINE: Partial<Record<StateName, Record<string, { maxNodes: number }>>> = {
  'board view': {
    'nested-interactive': { maxNodes: 1 }, // SUPPRESSED-UNTIL(#2560)
  },
  'card detail dialog': {
  },
  'command palette': {
    'nested-interactive': { maxNodes: 1 }, // SUPPRESSED-UNTIL(#2560)
  },
  'filter bar expanded': {
    'nested-interactive': { maxNodes: 1 }, // SUPPRESSED-UNTIL(#2560)
  },
  'settings page': {
  },
  'member management modal': {
    'nested-interactive': { maxNodes: 1 }, // SUPPRESSED-UNTIL(#2560)
  },
  'mobile navigation': {
  },
  'group tree': {
  },
  'group detail page': {
  },
}

/**
 * Waits for finite CSS/Web animations (dialog and sheet open transitions) to finish so axe
 * measures the final colors and geometry. Infinite animations (spinners) are ignored.
 */
async function settleAnimations(page: Page): Promise<void> {
  await page.waitForFunction(() =>
    document
      .getAnimations()
      .every((a) => a.effect?.getComputedTiming().iterations === Infinity || a.playState !== 'running'),
  )
}

async function scan(page: Page, state: StateName): Promise<void> {
  await settleAnimations(page)
  const results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze()
  const baseline = BASELINE[state] ?? {}
  const found = new Set(results.violations.map((v) => v.id))

  // New = rule not baselined, or a baselined rule with more nodes than recorded.
  const fresh = results.violations.filter((v) => !(v.id in baseline) || v.nodes.length > baseline[v.id].maxNodes)
  const summary = fresh.map(
    (v) =>
      `${v.id} (${v.impact}): ${v.help}\n  ${v.helpUrl}\n` +
      v.nodes.map((n) => `  - ${n.target.join(' ')}`).join('\n'),
  )
  expect(fresh.map((v) => v.id), `New axe violations in "${state}":\n${summary.join('\n')}`).toEqual([])

  const stale = Object.keys(baseline).filter((id) => !found.has(id))
  expect(
    stale,
    `Baseline entries no longer reproduce in "${state}" — delete them from BASELINE: ${stale.join(', ')}`,
  ).toEqual([])

  // Shrunk = a baselined rule now on fewer nodes than recorded, so the baseline
  // ratchets down per node, not only when a whole rule disappears.
  const shrunk = results.violations
    .filter((v) => v.id in baseline && v.nodes.length < baseline[v.id].maxNodes)
    .map((v) => `lower maxNodes for ${v.id} in "${state}" to ${v.nodes.length}`)
  expect(shrunk, shrunk.join('\n')).toEqual([])
}

async function mockCardEndpoints(page: Page): Promise<void> {
  const base = `**/api/v1/boards/${BOARD_FULL.id}/cards/${CARD.id}`
  const json = (body: unknown) => (route: import('@playwright/test').Route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
  await page.route(`${base}/`, json(CARD))
  await page.route(`${base}/movements/`, json([]))
  await page.route(`${base}/comments/`, json([]))
  await page.route(`${base}/timeline/**`, json({ count: 0, next: null, previous: null, results: [] }))
  await page.route(`${base}/activity/`, json([]))
  await page.route(`${base}/checklist/`, json([]))
  await page.route(`${base}/attachments/`, json([]))
  await page.route(`${base}/relations/`, json([]))
  await page.route(`${base}/blocks/`, json([]))
}

async function openBoard(page: Page): Promise<void> {
  await routeAuth(page)
  await routeBoard(page)
  await page.goto(`/boards/${BOARD_FULL.id}`)
  await expect(page.getByText(CARD.title).first()).toBeVisible({ timeout: 10_000 })
}

/** A group as the list and retrieve endpoints send it; health set so the status pill is scanned too. */
function group(id: number, name: string, parent: number | null, over: Record<string, unknown> = {}) {
  return {
    id, name, description: `${name} work`, owner: USER, parent, parent_name: parent ? 'Engineering' : null,
    member_count: 1, member_preview: [USER], board_count: 1, subgroup_count: parent ? 0 : 1,
    created_at: '2026-01-01T00:00:00Z', default_board_member_role: 'member', allowed_priorities: [],
    shared_labels: [], is_starred: false, navigation_only: false, can_place_boards: true,
    health_status: 'at_risk', effective_health_status: 'at_risk', health_status_source: null,
    health_status_changed_at: null, health_status_changed_by: null, health_status_note: null,
    health_review_days: null, health_review_due_at: null, ancestors: [], ...over,
  }
}

const PARENT_GROUP = group(7, 'Engineering', null)
const CHILD_GROUP = group(8, 'Platform', 7)

/** Routes for a parent group with one subgroup, whose boards run to a second page (#1779's Load more). */
async function mockGroups(page: Page): Promise<void> {
  // Without this the group socket reaches a running backend, whose 4001 signs the page out.
  await page.routeWebSocket('**/ws/groups/7/', (ws) => { ws.send(JSON.stringify({ event: 'connected', data: {} })) })
  await routeAuth(page)
  const json = (body: unknown) => (route: import('@playwright/test').Route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
  const board = (id: number, name: string, g: typeof PARENT_GROUP) =>
    ({ ...BOARD_LIST_ITEM, id, uid: `board0000${id}x`, name, group: g.id, group_name: g.name })
  const own = board(1, 'Roadmap', PARENT_GROUP)
  const nested = board(2, 'Platform backlog', CHILD_GROUP)
  await page.route(/\/api\/v1\/groups\/(\?.*)?$/, json({ count: 2, next: null, previous: null, results: [PARENT_GROUP, CHILD_GROUP] }))
  await page.route('**/api/v1/groups/7/', json(PARENT_GROUP))
  await page.route('**/api/v1/groups/7/subgroups/', json([CHILD_GROUP]))
  await page.route('**/api/v1/groups/7/boards/', json([own]))
  await page.route('**/api/v1/groups/7/members/', json([{ id: 1, user: USER, role: 'admin', joined_at: '2026-01-01T00:00:00Z' }]))
  await page.route('**/api/v1/groups/7/descendant-boards/paged/**', json({ count: 3, offset: 0, page_size: 50, results: [own, nested] }))
  await page.route('**/api/v1/groups/7/invite-links/**', json([]))
  await page.route('**/api/v1/groups/7/labels/', json([]))
}

test.describe('a11y: axe-core WCAG 2.1 AA scans (#1423)', () => {
  test.use({ viewport: { width: 1600, height: 900 } })

  test('board view', async ({ page }) => {
    await openBoard(page)
    await scan(page, 'board view')
  })

  test('card detail dialog', async ({ page }) => {
    await mockCardEndpoints(page)
    await openBoard(page)
    await page.getByText(CARD.title).first().click()
    await expect(page.locator('[role="dialog"]')).toBeVisible({ timeout: 5_000 })
    await expect(page.getByText(CARD.description)).toBeVisible({ timeout: 5_000 })
    await scan(page, 'card detail dialog')
  })

  test('command palette', async ({ page }) => {
    await openBoard(page)
    await page.keyboard.press(`${process.platform === 'darwin' ? 'Meta' : 'Control'}+k`)
    await expect(page.getByRole('combobox', { name: 'Command palette search' })).toBeVisible()
    await scan(page, 'command palette')
  })

  test('filter bar expanded', async ({ page }) => {
    await openBoard(page)
    await page.keyboard.press('f')
    await expect(page.getByRole('button', { name: '+ Filter' })).toBeVisible()
    await scan(page, 'filter bar expanded')
  })

  test('settings page', async ({ page }) => {
    await routeAuth(page)
    await page.goto('/settings')
    await expect(page.getByRole('heading').first()).toBeVisible({ timeout: 10_000 })
    await scan(page, 'settings page')
  })

  // The app's group tree is the nav drawer's nested Groups list; there is no /groups index route.
  test('group tree', async ({ page }) => {
    await mockGroups(page)
    await page.goto('/groups/7')
    await expect(page.getByRole('heading', { level: 1, name: /Engineering/ })).toBeVisible({ timeout: 10_000 })
    await page.keyboard.press('[')
    const drawer = page.getByRole('dialog')
    await expect(drawer.getByRole('link', { name: /Platform/ }).first()).toBeVisible()
    await scan(page, 'group tree')
  })

  test('group detail page', async ({ page }) => {
    await mockGroups(page)
    await page.goto('/groups/7')
    await expect(page.getByText('Roadmap').first()).toBeVisible({ timeout: 10_000 })
    await page.getByRole('switch', { name: /subgroup/i }).click()
    // The paged subtree list with its footer.
    await expect(page.getByRole('button', { name: 'Load more' })).toBeVisible()
    await expect(page.getByText('Platform backlog').first()).toBeVisible()
    await scan(page, 'group detail page')
  })

  test('member management modal', async ({ page }) => {
    await openBoard(page)
    await page.keyboard.press('Control+,')
    await expect(page.getByRole('tab', { name: /^Members/ })).toHaveAttribute('aria-selected', 'true')
    await scan(page, 'member management modal')
  })

  test.describe('narrow viewport', () => {
    test.use({ viewport: { width: 375, height: 720 } })

    test('mobile navigation', async ({ page }) => {
      await routeAuth(page)
      await page.goto('/')
      const hamburger = page.getByRole('button', { name: 'Open navigation' })
      await hamburger.click()
      await expect(page.getByRole('button', { name: 'Close navigation' })).toBeVisible()
      await scan(page, 'mobile navigation')
    })
  })
})
