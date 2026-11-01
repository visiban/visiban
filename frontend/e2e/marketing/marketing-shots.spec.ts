/**
 * Marketing product screenshots (#1039) — opt-in, never part of the regular E2E run.
 *
 * Regenerates six deterministic product views as retina PNGs for the marketing
 * site, docs, and pitch deck. Run it with its own config:
 *
 *   npm run dev                      # in another terminal
 *   npm run shots:marketing
 *
 * See e2e/marketing/README.md for the full procedure, env overrides, and how to
 * add a shot.
 *
 * Determinism: every API call is answered from fixtures.ts (no backend, no dev DB),
 * the wall-clock is pinned to CLOCK, and animations are disabled, so two runs on
 * different days or machines produce the same content.
 */
import { test, expect, type Page, type Route } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  ADMIN_INVITE_LINKS,
  ADMIN_USERS,
  BOARDS,
  BOARD_FULL,
  BOARD_ID,
  CARDS,
  CLOCK,
  COMMENTS,
  CURRENT_USER,
  DETAIL_CARD,
  EMAIL_SETTINGS,
  GROUPS,
  GROUP_MEMBERS,
  PUBLIC_BOARD,
  SHARE_TOKEN,
  SITE_CONFIG,
  SITE_SETTINGS,
  TIMELINE,
} from './fixtures'

/** Where PNGs land. MARKETING_SHOTS_DIR exists so verification runs can avoid ~/Downloads. */
const OUT_DIR = process.env.MARKETING_SHOTS_DIR || path.join(os.homedir(), 'Downloads')

test.use({
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 2,
  // Pinned so date and number formatting never depends on the machine running the shots.
  locale: 'en-US',
  timezoneId: 'UTC',
  colorScheme: 'light',
  // Belt and braces with `animations: 'disabled'` below: also honors the app's
  // prefers-reduced-motion branches.
  contextOptions: { reducedMotion: 'reduce' },
})

const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })

const page_ = <T,>(results: T[]) => ({ count: results.length, next: null, previous: null, results })

/**
 * Answer every /api/ request from fixtures. One dispatcher instead of a route per
 * endpoint: it is order-independent (Playwright runs the last-registered matching
 * route first, which makes stacked per-endpoint routes easy to get wrong) and it
 * gives one place to see which endpoints a shot touches.
 *
 * Set MARKETING_DEBUG=1 to log requests that fell through to the empty default —
 * a new page that starts calling an unmocked endpoint shows up there.
 */
async function mockApi(page: Page): Promise<void> {
  // Match on the path prefix, not a `**/api/**` glob: that glob would also swallow the
  // dev server's own module requests (/src/api/boards.ts) and blank the whole app.
  await page.route((url) => url.pathname.startsWith('/api/'), (route) => {
    const req = route.request()
    const url = new URL(req.url())
    const p = url.pathname
    const q = url.searchParams

    // Writes are never needed to take a screenshot; refuse them so a stray click
    // can't pretend to succeed.
    if (req.method() !== 'GET') return json(route, { detail: 'read-only marketing fixture' }, 405)

    // Auth / instance
    if (p === '/api/v1/auth/user/' || p === '/api/v1/auth/me/') return json(route, CURRENT_USER)
    if (p === '/api/v1/auth/site-config/') return json(route, SITE_CONFIG)
    if (p === '/api/v1/auth/providers/') {
      return json(route, { google: false, github: false, gitlab: false, oidc: false, oidc_name: null })
    }
    if (p === '/api/v1/version/') return json(route, { version: '1.3.0' })
    if (p === '/api/v1/notifications/unread-count/') return json(route, { count: 0 })
    if (p === '/api/v1/notifications/') return json(route, [])

    // Public share page (anonymous endpoint, not under /api/v1/)
    if (p === `/api/share/${SHARE_TOKEN}/`) return json(route, PUBLIC_BOARD)

    // Boards
    if (p === '/api/v1/boards/') {
      return json(route, page_(q.get('starred') === 'true' ? BOARDS.filter((b) => b.is_starred) : BOARDS))
    }
    if (p === `/api/v1/boards/${BOARD_ID}/full/`) return json(route, BOARD_FULL)
    if (p === `/api/v1/boards/${BOARD_ID}/`) return json(route, BOARDS[0])
    if (p === `/api/v1/boards/${BOARD_ID}/saved-filters/`) return json(route, [])
    if (p === `/api/v1/boards/${BOARD_ID}/cards/`) return json(route, CARDS)
    if (p === `/api/v1/boards/${BOARD_ID}/labels/`) return json(route, BOARD_FULL.labels)

    // Card detail drawer
    const card = new RegExp(`^/api/v1/boards/${BOARD_ID}/cards/${DETAIL_CARD.id}/(\\w+)/$`).exec(p)
    if (card) {
      switch (card[1]) {
        case 'timeline': {
          // The drawer asks for moves only by default (event_types=move); honor the
          // filter so the shot shows the column-to-column history.
          const types = q.get('event_types')?.split(',')
          const results = types ? TIMELINE.filter((e) => types.includes(e.kind === 'move' ? 'move' : e.event_type)) : TIMELINE
          return json(route, { count: results.length, next: null, previous: null, results })
        }
        case 'comments':
          return json(route, COMMENTS)
        case 'checklist':
          return json(route, [
            { id: 1, text: 'Map IdP groups to Meridian roles', is_checked: true, position: 0 },
            { id: 2, text: 'Confirm just-in-time provisioning', is_checked: true, position: 1 },
            { id: 3, text: 'Test deprovisioning in the sandbox', is_checked: true, position: 2 },
            { id: 4, text: 'Share the access review report', is_checked: true, position: 3 },
            { id: 5, text: 'Customer sign-off on role mapping', is_checked: false, position: 4 },
            { id: 6, text: 'Schedule production cutover', is_checked: false, position: 5 },
          ])
        default:
          return json(route, [])
      }
    }

    // Groups
    if (p === '/api/v1/groups/') {
      return json(route, page_(q.get('starred') === 'true' ? GROUPS.filter((g) => g.is_starred) : GROUPS))
    }
    const group = /^\/api\/v1\/groups\/(\d+)\/(\w[\w-]*)?\/?$/.exec(p)
    if (group) {
      const g = GROUPS.find((x) => x.id === Number(group[1]))
      if (!g) return json(route, { detail: 'Not found.' }, 404)
      switch (group[2]) {
        case undefined:
          return json(route, g)
        case 'members':
          return json(route, GROUP_MEMBERS)
        case 'subgroups':
          return json(route, GROUPS.filter((x) => x.parent === g.id))
        case 'boards':
          return json(route, BOARDS.filter((b) => b.group === g.id))
        case 'descendant-boards':
          return json(route, BOARDS.filter((b) => b.group !== null))
        case 'labels':
          return json(route, g.shared_labels)
        default:
          return json(route, [])
      }
    }

    // Admin
    if (p === '/api/v1/admin/settings/') return json(route, SITE_SETTINGS)
    if (p === '/api/v1/admin/users/') {
      return json(route, { count: ADMIN_USERS.length, offset: 0, page_size: 50, results: ADMIN_USERS })
    }
    if (p === '/api/v1/admin/invite-links/') return json(route, ADMIN_INVITE_LINKS)
    if (p === '/api/v1/admin/email-settings/') return json(route, EMAIL_SETTINGS)
    if (p === '/api/v1/admin/board-invite-links/') {
      return json(route, { count: 0, offset: 0, page_size: 50, results: [] })
    }

    if (process.env.MARKETING_DEBUG) console.log(`[marketing-shots] unmocked GET ${p}${url.search}`)
    return json(route, [])
  })

  // Boards open a WebSocket; answer the handshake so the board never shows "disconnected".
  await page.routeWebSocket('**/ws/**', (ws) => {
    ws.send(JSON.stringify({ event: 'connected', data: {} }))
  })
}

async function setup(page: Page): Promise<void> {
  // Pin the wall-clock before any navigation so relative copy ("2 days ago"), due-date
  // chips, and staleness all resolve identically on every run. setFixedTime keeps
  // timers running, so the app still settles normally.
  await page.clock.setFixedTime(CLOCK)
  await mockApi(page)
}

/** Take the shot at `OUT_DIR/visiban-<name>.png`, with animations frozen. */
async function shoot(page: Page, name: string): Promise<void> {
  fs.mkdirSync(OUT_DIR, { recursive: true })
  // Let web fonts and layout finish before freezing the frame.
  await page.evaluate(() => document.fonts.ready)
  await page.screenshot({
    path: path.join(OUT_DIR, `visiban-${name}.png`),
    fullPage: false,
    animations: 'disabled',
    caret: 'hide',
  })
}

/**
 * Start with the sidebar collapsed so wide views (the board) show every column.
 * Seeded before first navigation via the app's persisted preference.
 */
async function collapseSidebar(page: Page): Promise<void> {
  await page.addInitScript(() => {
    try {
      localStorage.setItem('user:prefs:sidebar-collapsed', 'true')
    } catch {
      // storage unavailable: shot falls back to the expanded sidebar
    }
  })
}

test.describe('Marketing snapshots', () => {
  test.beforeEach(async ({ page }) => {
    await setup(page)
  })

  test('01 — Dashboard', async ({ page }) => {
    await page.goto('/')
    await expect(page.getByRole('heading', { name: 'Groups' })).toBeVisible({ timeout: 15_000 })
    await expect(page.getByText('Partner Launch Tracker').first()).toBeVisible()
    await shoot(page, '01-dashboard')
  })

  test('02 — Board', async ({ page }) => {
    await collapseSidebar(page)
    await page.goto(`/boards/${BOARD_ID}`)
    await expect(page.getByText('SSO and SCIM provisioning').first()).toBeVisible({ timeout: 15_000 })
    await expect(page.getByText('Fabrikam Health').first()).toBeVisible()
    await shoot(page, '02-board')
  })

  test('03 — Card detail with activity', async ({ page }) => {
    // ?card=<id> is the notification deep link: BoardView opens the drawer for it.
    await page.goto(`/boards/${BOARD_ID}?card=${DETAIL_CARD.id}`)
    await expect(page.getByRole('tab', { name: /activity/i })).toBeVisible({ timeout: 15_000 })
    await page.getByRole('tab', { name: /activity/i }).click()
    await expect(page.getByText('Created in Intake')).toBeVisible({ timeout: 10_000 })
    await shoot(page, '03-card-detail')
  })

  test('04 — Group settings', async ({ page }) => {
    await page.goto('/groups/1?tab=settings')
    await expect(page.getByRole('heading', { name: 'Client Delivery' }).first()).toBeVisible({ timeout: 15_000 })
    await expect(page.getByText(/Defaults for boards created in this group/)).toBeVisible()
    // Scroll the Members section to the top so the frame ends on the Invite links
    // card instead of cutting through it.
    await page.getByRole('heading', { name: 'Members' }).evaluate((el) => {
      el.closest('main')!.scrollTop = el.getBoundingClientRect().top - 60
    })
    await shoot(page, '04-group-settings')
  })

  test('05 — Share board page', async ({ page }) => {
    // The anonymous, read-only page a customer sees from a share link.
    await page.goto(`/share/${SHARE_TOKEN}`)
    await expect(page.getByTestId('share-board-page')).toBeVisible({ timeout: 15_000 })
    await expect(page.getByText('Northwind Traders').first()).toBeVisible()
    await shoot(page, '05-share-board')
  })

  test('06 — Admin', async ({ page }) => {
    await page.goto('/admin')
    await page.getByRole('button', { name: 'Users' }).click()
    await expect(page.getByText('elena.sokolova@meridiancloud.example')).toBeVisible({ timeout: 15_000 })
    await shoot(page, '06-admin')
  })
})
