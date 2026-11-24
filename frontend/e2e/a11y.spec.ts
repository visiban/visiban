import { test, expect } from '@playwright/test'
import type { Page } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import { routeAuth, routeBoard } from './helpers'
import { BOARD_FULL, CARD } from './fixtures/board'

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
