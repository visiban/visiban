import { test, expect } from '@playwright/test'
import { routeAuth, routeBoard } from './helpers'
import { BOARD_FULL, CARD } from './fixtures/board'

const CARD_TWO = { ...CARD, id: 2, uid: 'card000002b', title: 'Second task', position: 1 }

// The card peek sheet (#2273): Shift+click (or Show summary) on a board card opens a read-only
// side sheet; a plain click opens the detail panel (#2358).
async function setup(page: import('@playwright/test').Page, board = BOARD_FULL) {
  await routeAuth(page)
  await routeBoard(page, board)
  await page.route(/\/api\/v1\/boards\/\d+\/cards\/\d+\/movements\/(\?.*)?$/, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) }),
  )
  await page.route(/\/api\/v1\/boards\/\d+\/cards\/\d+\/(comments|attachments|checklist|relations|activity|blocks)\/(\?.*)?$/, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) }),
  )
  await page.route(/\/api\/v1\/boards\/\d+\/cards\/\d+\/timeline\//, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ count: 0, next: null, results: [] }) }),
  )
}

test.describe('card peek sheet', () => {
  test.use({ viewport: { width: 1440, height: 900 } })

  test('opens on Shift+click without resizing the grid, marks the card, and Escape returns focus', async ({ page }) => {
    await setup(page)
    await page.goto(`/boards/${BOARD_FULL.id}`)
    const card = page.locator(`[data-card-id="${CARD.id}"]`)
    await expect(card).toBeVisible({ timeout: 10_000 })
    const scroll = page.locator('[data-board-scroll]')
    const before = await scroll.boundingBox()
    await card.click({ modifiers: ['Shift'] })
    const sheet = page.getByTestId('card-peek-sheet')
    await expect(sheet).toBeVisible()
    await expect(page.getByRole('button', { name: 'Open card' })).toBeFocused()
    await expect(card).toHaveAttribute('aria-current', 'true')
    const after = await scroll.boundingBox()
    expect(after?.width).toBe(before?.width)
    await page.keyboard.press('Escape')
    await expect(sheet).toHaveCount(0)
    await expect(card).toBeFocused()
  })

  test('Open card hands off to the detail sheet', async ({ page }) => {
    await setup(page)
    await page.goto(`/boards/${BOARD_FULL.id}`)
    await page.locator(`[data-card-id="${CARD.id}"]`).click({ modifiers: ['Shift'] })
    await page.getByRole('button', { name: 'Open card' }).click()
    await expect(page.getByTestId('card-peek-sheet')).toHaveCount(0)
    await expect(page.getByRole('dialog', { name: /./ })).toBeVisible()
  })

  test('Shift+Enter on the focused card opens the peek; Enter opens the detail panel', async ({ page }) => {
    await setup(page)
    await page.goto(`/boards/${BOARD_FULL.id}`)
    const card = page.locator(`[data-card-id="${CARD.id}"]`)
    await expect(card).toBeVisible({ timeout: 10_000 })
    await card.focus()
    await page.keyboard.press('Shift+Enter')
    await expect(page.getByTestId('card-peek-sheet')).toBeVisible()
    await page.keyboard.press('Escape')
    await card.focus()
    await page.keyboard.press('Enter')
    await expect(page.getByTestId('card-peek-sheet')).toHaveCount(0)
    await expect(page.getByRole('dialog', { name: /./ })).toBeVisible()
  })

  test('a plain click opens the detail panel; the Show summary button and the menu open the peek', async ({ page }) => {
    await setup(page)
    await page.goto(`/boards/${BOARD_FULL.id}`)
    const card = page.locator(`[data-card-id="${CARD.id}"]`)
    await expect(card).toBeVisible({ timeout: 10_000 })
    await card.click()
    await expect(page.getByTestId('card-peek-sheet')).toHaveCount(0)
    await expect(page.getByRole('dialog', { name: /./ })).toBeVisible()
    await page.keyboard.press('Escape')
    await card.hover()
    await card.getByRole('button', { name: 'Show summary' }).click()
    await expect(page.getByTestId('card-peek-sheet')).toBeVisible()
    await page.keyboard.press('Escape')
    await card.click({ button: 'right' })
    await page.getByRole('menuitem', { name: /Show summary/ }).click()
    await expect(page.getByTestId('card-peek-sheet')).toBeVisible()
  })

  test('a click on "+ Add card" closes the peek and does not also open the editor', async ({ page }) => {
    await setup(page)
    await page.goto(`/boards/${BOARD_FULL.id}`)
    const card = page.locator(`[data-card-id="${CARD.id}"]`)
    await card.click({ modifiers: ['Shift'] })
    await expect(page.getByTestId('card-peek-sheet')).toBeVisible()
    await page.locator('[data-board-cell]').getByRole('button', { name: /^Add card to / }).first().click()
    await expect(page.getByTestId('card-peek-sheet')).toHaveCount(0)
    await expect(page.getByPlaceholder(/title/i)).toHaveCount(0)
  })

  test('Open card then Escape closes the detail sheet and returns focus to the board card', async ({ page }) => {
    await setup(page)
    await page.goto(`/boards/${BOARD_FULL.id}`)
    const card = page.locator(`[data-card-id="${CARD.id}"]`)
    await card.click({ modifiers: ['Shift'] })
    await page.getByRole('button', { name: 'Open card' }).click()
    await expect(page.getByTestId('card-peek-sheet')).toHaveCount(0)
    await expect(page.getByRole('dialog', { name: /./ })).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog', { name: /./ })).toHaveCount(0)
    await expect(card).toBeFocused()
  })

  test.describe('at 640px', () => {
    test.use({ viewport: { width: 640, height: 800 } })

    test('is full-screen at exactly 640px', async ({ page }) => {
      await setup(page)
      await page.goto(`/boards/${BOARD_FULL.id}`)
      await page.locator(`[data-card-id="${CARD.id}"]`).click({ modifiers: ['Shift'] })
      const box = await page.getByTestId('card-peek-sheet').boundingBox()
      expect(Math.round(box?.width ?? 0)).toBe(640)
    })
  })

  test.describe('at 390px', () => {
    test.use({ viewport: { width: 390, height: 844 }, hasTouch: true })

    test('Show summary in the More actions menu opens a full-screen peek with 44px targets; Escape closes it', async ({ page }) => {
      await setup(page)
      await page.goto(`/boards/${BOARD_FULL.id}`)
      const card = page.locator(`[data-card-id="${CARD.id}"]`)
      await expect(card).toBeVisible({ timeout: 10_000 })
      await card.focus()
      await page.keyboard.press('Shift+F10')
      await page.getByRole('menuitem', { name: /Show summary/ }).click()
      const sheet = page.getByTestId('card-peek-sheet')
      await expect(sheet).toBeVisible()
      const box = await sheet.boundingBox()
      expect(Math.round(box?.width ?? 0)).toBe(390)
      const close = await page.getByRole('button', { name: 'Close card peek' }).boundingBox()
      expect(close?.height).toBeGreaterThanOrEqual(44)
      const open = await page.getByRole('button', { name: 'Open card' }).boundingBox()
      expect(open?.height).toBeGreaterThanOrEqual(44)
      await page.keyboard.press('Escape')
      await expect(sheet).toHaveCount(0)
    })
  })

  test.describe('touch at 390px', () => {
    test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })

    test('Show summary on the face and in the More actions menu both open the peek with 44px targets (#2358)', async ({ page }) => {
      await setup(page)
      await page.goto(`/boards/${BOARD_FULL.id}`)
      const card = page.locator(`[data-card-id="${CARD.id}"]`)
      await expect(card).toBeVisible({ timeout: 10_000 })
      await card.focus()
      const summary = page.getByTestId('card-show-summary')
      const more = page.getByTestId('card-more-actions')
      await expect(summary).toBeVisible()
      await expect(more).toBeVisible()
      const s = await summary.boundingBox()
      const m = await more.boundingBox()
      expect(s?.height).toBeGreaterThanOrEqual(44)
      expect(s?.width).toBeGreaterThanOrEqual(44)
      // #2402: boundingBox() ignores clipping, so measure the part of each button an ancestor's overflow leaves visible,
      // and check that focusing a button scrolls neither the face nor any ancestor.
      const visible = (loc: typeof summary) => loc.evaluate((el) => {
        let r = el.getBoundingClientRect()
        for (let p = el.parentElement; p; p = p.parentElement) {
          const o = getComputedStyle(p)
          if (o.overflowX === 'visible' && o.overflowY === 'visible') continue
          const c = p.getBoundingClientRect()
          r = new DOMRect(Math.max(r.left, c.left), Math.max(r.top, c.top), Math.max(0, Math.min(r.right, c.right) - Math.max(r.left, c.left)), Math.max(0, Math.min(r.bottom, c.bottom) - Math.max(r.top, c.top)))
        }
        return { w: r.width, h: r.height }
      })
      for (const b of [summary, more]) {
        const v = await visible(b)
        expect(v.h).toBeGreaterThanOrEqual(43.5)
        expect(v.w).toBeGreaterThanOrEqual(43.5)
      }
      // NOTE: the scrollTop assertions below are a sanity check, not proof of #2402: only the clipped-box check above
      // goes red without the fix.
      const scrolls = () => card.evaluate((el) => {
        const out: number[] = []
        for (let p: Element | null = el; p; p = p.parentElement) out.push(p.scrollTop)
        return out
      })
      const baseline = await scrolls()
      await summary.focus()
      expect(await scrolls()).toEqual(baseline)
      await more.focus()
      expect(await scrolls()).toEqual(baseline)
      await card.focus()
      expect((s!.x + s!.width <= m!.x + 0.5) || (m!.x + m!.width <= s!.x + 0.5)).toBe(true)
      await summary.tap()
      const sheet = page.getByTestId('card-peek-sheet')
      await expect(sheet).toBeVisible()
      await page.getByRole('button', { name: 'Close card peek' }).tap()
      await expect(sheet).toHaveCount(0)
      await card.focus()
      await more.tap()
      await page.getByRole('menuitem', { name: /Show summary/ }).tap()
      await expect(sheet).toBeVisible()
    })
  })
})

test.describe('card face 44px buttons on a touch tablet (#2402)', () => {
  // 1024px is the grid, not PhoneBoard, so only CardItem's own coarse-pointer min-height keeps the buttons in the face.
  test.use({ viewport: { width: 1024, height: 768 }, hasTouch: true, isMobile: true })

  const visibleBox = (loc: import('@playwright/test').Locator) => loc.evaluate((el) => {
    let r = el.getBoundingClientRect()
    for (let p = el.parentElement; p; p = p.parentElement) {
      const o = getComputedStyle(p)
      if (o.overflowX === 'visible' && o.overflowY === 'visible') continue
      const c = p.getBoundingClientRect()
      r = new DOMRect(Math.max(r.left, c.left), Math.max(r.top, c.top), Math.max(0, Math.min(r.right, c.right) - Math.max(r.left, c.left)), Math.max(0, Math.min(r.bottom, c.bottom) - Math.max(r.top, c.top)))
    }
    return { w: r.width, h: r.height }
  })

  test('More actions and Show summary are fully inside the face, and the current card has none', async ({ page }) => {
    await setup(page)
    await page.goto(`/boards/${BOARD_FULL.id}`)
    const card = page.locator(`[data-card-id="${CARD.id}"]`)
    await expect(card).toBeVisible({ timeout: 10_000 })
    const check = async () => {
      await card.focus()
      for (const id of ['card-show-summary', 'card-more-actions']) {
        const v = await visibleBox(page.getByTestId(id))
        expect(v.h, id).toBeGreaterThanOrEqual(43.5)
        expect(v.w, id).toBeGreaterThanOrEqual(43.5)
      }
    }
    await check()
    // The `current` card (border-2, 42px padding box) never shows these buttons: BoardView drops onOpenCardMenu while a
    // peek or detail panel is open, so there is nothing to overhang (asserted so a change to that surfaces here).
    await card.click({ modifiers: ['Shift'] })
    await expect(card).toHaveAttribute('aria-current', 'true')
    await expect(page.getByTestId('card-more-actions')).toHaveCount(0)
  })
})

test.describe('card peek sheet — placement and Dock to edge (#2507)', () => {
  test.use({ viewport: { width: 1600, height: 900 } })

  test('anchors beside the card, docks on toggle, persists across a reload and keeps the mode on a swap', async ({ page }) => {
    await setup(page, { ...BOARD_FULL, cards: [CARD, CARD_TWO] })
    await page.goto(`/boards/${BOARD_FULL.id}`)
    const first = page.locator(`[data-card-id="${CARD.id}"]`)
    const second = page.locator(`[data-card-id="${CARD_TWO.id}"]`)
    await expect(first).toBeVisible({ timeout: 10_000 })
    await first.click({ modifiers: ['Shift'] })
    const sheet = page.getByTestId('card-peek-sheet')
    await expect(sheet).toHaveAttribute('data-sheet-mode', 'anchored')
    await expect(sheet).toHaveAttribute('data-sheet-side', 'right')
    await page.getByTestId('card-sheet-dock-toggle').click()
    await expect(sheet).toHaveAttribute('data-sheet-mode', 'docked')
    await page.reload()
    await expect(first).toBeVisible({ timeout: 10_000 })
    await first.click({ modifiers: ['Shift'] })
    await expect(sheet).toHaveAttribute('data-sheet-mode', 'docked')
    await second.click({ modifiers: ['Shift'] })
    await expect(sheet).toHaveAttribute('data-sheet-mode', 'docked')
  })
})
