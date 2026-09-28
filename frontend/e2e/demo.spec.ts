/**
 * Hosted demo (#1179): the visitor's whole loop, end to end in the SPA.
 *
 * sign in with one click → the demo bar counts down → move a card → the move
 * shows in the card's History → creating a board is refused up front.
 *
 * Like every spec here the API is mocked (see playwright.config.ts), so this
 * proves the SPA's side of the contract. The server-side fence itself — that
 * POST /api/v1/boards/ answers 403 `demo_read_only` whatever the UI does — is
 * proven by backend/accounts/tests/test_demo_mode.py's route sweep.
 */
import { test, expect } from '@playwright/test'
import { routeAuth, routeBoard } from './helpers'
import { AUTH_PROVIDERS, BOARD_FULL, CARD, COLUMN_DONE, SITE_CONFIG, USER } from './fixtures/board'

// Comfortably outside the 5-minute warning window whenever the spec runs.
const NEXT_RESET_ISO = new Date(Date.now() + 40 * 60_000).toISOString()

const DEMO_SITE_CONFIG = {
  ...SITE_CONFIG,
  demo_mode: true,
  demo_login: { username: 'visitor', password: 'published-pw' },
  demo_reset_schedule: '0 * * * *',
  demo_next_reset_at: NEXT_RESET_ISO,
}
const VISITOR = { ...USER, id: 9, username: 'visitor', display_name: 'Demo Visitor', demo_mode: true, demo_next_reset_at: NEXT_RESET_ISO }
// The fixture's role is irrelevant here: the API is mocked, and the fence is
// role-independent by design.
const BOARD = BOARD_FULL

test.describe('hosted demo visitor loop', () => {
  test('explore → move a card → see it in History → create-board refused', async ({ page }) => {
    // Everything an authenticated shell needs, then override the auth bits.
    await routeAuth(page)
    await routeBoard(page, BOARD)

    let signedIn = false
    let loginBody: unknown = null
    const writes: string[] = []
    page.on('request', (req) => {
      if (req.method() !== 'GET' && req.url().includes('/api/v1/')) writes.push(`${req.method()} ${new URL(req.url()).pathname}`)
    })

    await page.route('**/api/v1/auth/site-config/', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(DEMO_SITE_CONFIG) }),
    )
    await page.route('**/api/v1/auth/providers/', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(AUTH_PROVIDERS) }),
    )
    await page.route('**/api/v1/auth/login/', (route) => {
      signedIn = true
      loginBody = JSON.parse(route.request().postData() ?? '{}')
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ key: 'k' }) })
    })
    await page.route('**/api/v1/auth/user/', (route) =>
      signedIn
        ? route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(VISITOR) })
        : route.fulfill({ status: 401 }),
    )

    // History: empty until the move lands, then the move.
    let moved = false
    await page.route(`**/api/v1/boards/${BOARD.id}/cards/${CARD.id}/move/`, (route) => {
      moved = true
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ card: { ...CARD, column: COLUMN_DONE.id } }) })
    })
    for (const sub of ['movements', 'comments', 'checklist', 'attachments', 'activity', 'relations']) {
      await page.route(`**/api/v1/boards/${BOARD.id}/cards/${CARD.id}/${sub}/**`, (route) =>
        route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) }),
      )
    }
    await page.route(`**/api/v1/boards/${BOARD.id}/cards/${CARD.id}/timeline/**`, (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          count: moved ? 1 : 0,
          next: null,
          results: moved
            ? [{
                kind: 'move',
                ts: new Date().toISOString(),
                event_type: 'card_moved',
                actor: { id: 9, username: 'visitor', display_name: 'Demo Visitor', avatar_url: '' },
                data: {
                  id: 501, card: CARD.id, from_column: 1, from_column_name: 'To Do', to_column: 2,
                  to_column_name: 'Done', user: { id: 9, username: 'visitor', display_name: 'Demo Visitor', avatar_url: '' },
                  created_at: new Date().toISOString(),
                },
              }]
            : [],
        }),
      }),
    )

    // 1. One-click sign-in with the published account.
    await page.goto('/')
    const banner = page.getByTestId('demo-banner')
    await expect(banner).toContainText('This is a shared demo.', { timeout: 10_000 })
    await expect(banner).toContainText('you will be signed out')
    await banner.getByRole('button', { name: 'Explore the demo' }).click()
    await expect.poll(() => loginBody).toEqual({ username: 'visitor', password: 'published-pw' })

    // 2. The shell's demo bar is up, counting down to the next reset.
    const bar = page.getByTestId('demo-mode-bar')
    await expect(bar).toContainText('Shared demo', { timeout: 10_000 })
    await expect(bar).toContainText(/\(in \d+ min\)/)

    // 3. Move a card (drag to the Done column header, as board.spec.ts does).
    await page.goto(`/boards/${BOARD.id}`)
    const cardEl = page.getByText(CARD.title).first()
    await expect(cardEl).toBeVisible({ timeout: 10_000 })
    const cardBox = await cardEl.boundingBox()
    const doneBox = await page.getByText('Done').first().boundingBox()
    if (!cardBox || !doneBox) throw new Error('Could not locate card or Done column')
    const fromX = cardBox.x + cardBox.width / 2
    const fromY = cardBox.y + cardBox.height / 2
    await page.mouse.move(fromX, fromY)
    await page.mouse.down()
    await page.mouse.move(fromX, fromY + 10, { steps: 3 })
    await page.mouse.move(doneBox.x + doneBox.width / 2, doneBox.y + doneBox.height / 2, { steps: 10 })
    await page.mouse.up()
    await expect.poll(() => moved, { timeout: 5_000 }).toBe(true)

    // 4. ...and it shows in the card's History.
    await page.getByText(CARD.title, { exact: true }).first().click()
    const dialog = page.locator('[role="dialog"]')
    await expect(dialog).toBeVisible({ timeout: 5_000 })

    // 4a. #1193 — a second refused write, this time inside the card panel:
    // adding a relation is refused up front too, not left to the fallback
    // toast. Proves the SPA wiring for one representative surface among the
    // several #1193 fixed; the rest have dedicated unit coverage (cardDetail,
    // cardRelationsSection, navbar, boardPageStarButton, themeServerSync).
    const addRelation = dialog.getByRole('button', { name: '+ Add relation' })
    await expect(addRelation).toHaveAttribute('aria-disabled', 'true', { timeout: 5_000 })
    await expect(addRelation).toHaveAccessibleDescription("This is a shared demo — card relations can't be added here.")
    await addRelation.focus()
    await expect(addRelation).toBeFocused()
    await addRelation.click({ force: true })
    await expect(dialog.getByRole('radio', { name: 'Blocked by' })).toHaveCount(0)

    await dialog.getByRole('tab', { name: 'activity' }).click()
    await expect(dialog.getByText('To Do → Done')).toBeVisible({ timeout: 5_000 })
    await page.keyboard.press('Escape')

    // 5. Creating a board is refused up front, with the reason, and nothing is sent.
    await page.goto('/')
    const newBoard = page.getByRole('main').getByRole('button', { name: /^New board\./ })
    await expect(newBoard).toHaveAttribute('aria-disabled', 'true', { timeout: 10_000 })
    await expect(newBoard).toHaveAttribute('title', "This is a shared demo — boards can't be created here.")
    await newBoard.focus()
    await expect(newBoard).toBeFocused()
    // force: Playwright treats aria-disabled as not actionable; the point is
    // that a determined click still does nothing.
    await newBoard.click({ force: true })
    await expect(page.getByRole('dialog')).toHaveCount(0)
    expect(writes).not.toContain('POST /api/v1/boards/')
    // The only writes the whole loop sent were the allowlisted ones.
    expect(writes).toContain('POST /api/v1/auth/login/')
    expect(writes).toContain(`POST /api/v1/boards/${BOARD.id}/cards/${CARD.id}/move/`)
  })
})
