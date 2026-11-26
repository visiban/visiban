import { test, expect, type Page } from '@playwright/test'
import { routeAuth, routeBoard } from './helpers'
import { BOARD_FULL, CARD } from './fixtures/board'

// The Children tab (#2209 row 14): every state at three viewport widths (880, 540 and 390px), in light and
// dark. The card sheet is 540px at every viewport above the phone, so the tab never reaches the 800px that the
// side-by-side layout needs and always shows one column at a time; that layout is pinned in Vitest on a measured
// container. Each state must render its own content and never scroll the sheet sideways.
// The parent carries a rollup with `last_moved_at` so the tab renders "Work moved" and its contrast is measured;
// card 10 is a child on the same board whose `parent` makes its header read "‹ <parent>" (`from_parent`).
const PARENT_CARD = {
  ...CARD, title: 'Launch plan',
  children_rollup: { visible: true, total: 5, done: 2, doing: 1, todo: 1, blocked: 1, last_moved_at: new Date(Date.now() - 86_400_000).toISOString() },
}
const CHILD_CARD = {
  ...CARD, id: 10, uid: 'card000010c', title: 'Pen-test scoping call', position: 1,
  parent: {
    hidden: false, id: CARD.id, title: 'Launch plan', board_id: BOARD_FULL.id, board_name: BOARD_FULL.name, column_id: 1, column_name: 'To Do',
    swimlane_id: 1, swimlane_name: 'Default', archived: false, board_parent_name_singular: '',
  },
}
const PARENT_BOARD = { ...BOARD_FULL, cards_can_have_children: true, cards: [PARENT_CARD, CHILD_CARD] }

const columns = [
  { id: 100, name: 'To do', color: '#6B7280', wip_limit: null, is_done: false, card_count: 9 },
  { id: 101, name: 'Doing', color: '#3B82F6', wip_limit: 5, is_done: false, card_count: 4 },
  // At its limit: with enforced limits the Move picker disables it for a member (#2209 WIP mode).
  { id: 102, name: 'Blocked', color: '#EF4444', wip_limit: 4, is_done: false, card_count: 4 },
  { id: 103, name: 'Done', color: '#22C55E', wip_limit: null, is_done: true, card_count: 6 },
]
const child = (id: number, title: string, column_id: number, over: Record<string, unknown> = {}) => ({
  id, title, board_id: 7, column_id, column_name: '', swimlane_id: 1, swimlane_name: 'Lane', archived: false,
  position: id, assignee: null, blocked: false, blocked_at: null, priority: 'low', due_date: null, labels: [], ...over,
})
const populated = {
  count: 5, visible: true, offset: 0, limit: 50,
  results: [
    child(10, 'Pen-test scoping call with a deliberately long title that has to wrap', 100, {
      priority: 'high', due_date: '2020-01-02', labels: [{ id: 1, name: 'Security', color: '#EF4444' }, { id: 2, name: 'Customer', color: '#FDE047' }],
    }),
    child(11, 'Kickoff', 101),
    child(12, 'Firewall review', 102, { blocked: true, blocked_at: new Date(Date.now() - 6 * 86_400_000).toISOString() }),
    child(13, 'Contract', 103),
    child(14, 'Sign-off', 103),
  ],
  board: { id: 7, name: 'Delivery', role: 'member', enforce_wip_limits: true, enforce_wip_hard: false, columns },
}

/**
 * Lowest WCAG contrast ratio among the visible text in `root`: each element with its own text node, its
 * computed color against the first opaque background up the tree. Colors are normalized through a canvas,
 * so any CSS color syntax resolves.
 */
async function lowestContrast(root: import('@playwright/test').Locator) {
  return root.evaluate((el) => {
    const ctx = document.createElement('canvas').getContext('2d')!
    const rgba = (c: string): [number, number, number, number] => {
      ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = '#000'; ctx.fillStyle = c; ctx.fillRect(0, 0, 1, 1)
      const d = ctx.getImageData(0, 0, 1, 1).data
      return [d[0], d[1], d[2], d[3] / 255]
    }
    const lum = ([r, g, b]: number[]) => {
      const f = (v: number) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4 }
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
    }
    const bgOf = (n: Element | null): number[] => {
      for (let e = n; e; e = e.parentElement) {
        const c = rgba(getComputedStyle(e).backgroundColor)
        if (c[3] > 0.95) return c
      }
      return rgba(getComputedStyle(document.body).backgroundColor)
    }
    let worst = { ratio: 21, text: '' }
    for (const e of [el, ...Array.from(el.querySelectorAll('*'))]) {
      const own = Array.from(e.childNodes).some((n) => n.nodeType === 3 && n.textContent!.trim())
      if (!own) continue
      const cs = getComputedStyle(e)
      if (cs.visibility === 'hidden' || cs.display === 'none' || (e as HTMLElement).offsetParent === null && cs.position !== 'fixed') continue
      if (e.closest('.sr-only,[aria-hidden="true"]')) continue
      if ((e as HTMLButtonElement).disabled || e.closest('[aria-disabled="true"]')) continue
      const fg = rgba(cs.color)
      const bg = bgOf(e)
      const mixed = fg.slice(0, 3).map((v, i) => v * fg[3] + bg[i] * (1 - fg[3]))
      const [a, b] = [lum(mixed), lum(bg)].sort((x, y) => y - x)
      const ratio = (a + 0.05) / (b + 0.05)
      if (ratio < worst.ratio) worst = { ratio, text: e.textContent!.trim().slice(0, 40) }
    }
    return worst
  })
}

type Mode = 'populated' | 'empty' | 'hidden' | 'error' | 'loading'

async function setup(page: Page, mode: () => Mode) {
  await routeAuth(page)
  await routeBoard(page, PARENT_BOARD as typeof BOARD_FULL)
  await page.route(/\/api\/v1\/boards\/\d+\/cards\/\d+\/(comments|attachments|checklist|relations|activity|blocks|movements)\/(\?.*)?$/, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }),
  )
  await page.route(/\/api\/v1\/boards\/\d+\/cards\/\d+\/timeline\//, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ count: 0, next: null, results: [] }) }),
  )
  await page.route(/\/api\/v1\/boards\/\d+\/cards\/\d+\/children\/\d+\/$/, (route) => route.fulfill({ status: 204, body: '' }))
  await page.route(/\/api\/v1\/boards\/\d+\/cards\/\d+\/children\/(\?.*)?$/, async (route) => {
    const m = mode()
    if (m === 'loading') return // never answers: the skeleton stays
    if (m === 'error') return route.fulfill({ status: 500, contentType: 'application/json', body: '{}' })
    const body = m === 'populated' ? populated
      : m === 'hidden' ? { count: 5, visible: false, offset: 0, limit: 50, results: [] }
      : { count: 0, visible: true, offset: 0, limit: 50, results: [] }
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
  })
}

const expected: Record<Mode, RegExp> = {
  populated: /2 of 5 done/,
  empty: /No children yet/,
  hidden: /5 children on a board you can't open/,
  error: /The children didn't load/,
  loading: /./,
}

for (const width of [880, 540, 390]) {
  for (const scheme of ['light', 'dark'] as const) {
    test(`Children tab states at ${width}px, ${scheme}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 })
      await page.emulateMedia({ colorScheme: scheme })
      let mode: Mode = 'populated'
      await setup(page, () => mode)
      for (const m of ['populated', 'empty', 'hidden', 'error', 'loading'] as Mode[]) {
        mode = m
        await page.goto(`/boards/${PARENT_BOARD.id}?card=${CARD.id}&tab=children`)
        const tab = page.getByTestId('card-children-tab')
        await expect(tab, m).toBeVisible({ timeout: 10_000 })
        // The dark run must really render dark (the theme resolves "system" from prefers-color-scheme).
        const html = page.locator('html')
        if (scheme === 'dark') await expect(html, `${m} dark`).toHaveClass(/\bdark\b/)
        else await expect(html, `${m} light`).not.toHaveClass(/\bdark\b/)
        await expect(html).toHaveAttribute('data-theme', scheme)
        if (m === 'loading') await expect(page.getByRole('status', { name: 'Loading children' })).toBeVisible()
        else await expect(tab).toContainText(expected[m])
        if (m === 'error') await expect(tab.getByRole('alert').filter({ hasText: "didn't load" })).toBeVisible()
        if (m === 'populated') {
          await expect(tab.getByRole('link', { name: 'Open on Delivery' })).toHaveAttribute('href', `/boards/7?f_parent=${CARD.id}`)
          await expect(tab.getByRole('img', { name: '2 done, 1 doing, 1 blocked, 1 to do' })).toBeVisible()
          // The card sheet is 540px at every viewport above the phone and full screen at or below 640px
          // (useCardSheetPlacement), so the tab never gets the 880px of container the side-by-side layout
          // needs: asserted, not recorded. The side-by-side layout is pinned in cardChildrenTab2209.test.tsx
          // at a measured 880px container (no sheet is that wide today).
          const box = await tab.boundingBox()
          expect(box!.width, `tab width at ${width}px`).toBeLessThan(880)
          await expect(tab.getByRole('region')).toHaveCount(1)
          await expect(tab.getByRole('group', { name: 'Columns on Delivery' })).toBeVisible()
          await expect(tab.getByTestId('children-limit-line')).toContainText("are this card's")
          // Full card anatomy, the History link, and measured contrast of every text node in the tab.
          await expect(tab.getByTestId('child-card-face').first()).toContainText('High')
          await expect(tab.getByRole('link', { name: 'Movement history of these children' })).toHaveAttribute('href', `/boards/7?view=history&parent=${CARD.id}`)
          // "Work moved" is rendered from the rollup's last_moved_at and covered by the contrast measure below.
          await expect(tab.getByTestId('children-work-moved')).toContainText('Work moved')
          // Blocked is the first metadata slot of a child's face, as on the board's own card.
          await tab.getByRole('button', { name: /^Blocked/ }).click()
          await expect(tab.getByTestId('child-card-face').filter({ hasText: '⊘' }).first().locator('span').first()).toContainText('⊘ 6d')
          await tab.getByRole('button', { name: /^To do/ }).click()
          const worst = await lowestContrast(tab)
          console.log(`contrast-2209 ${width} ${scheme} tab ${worst.ratio.toFixed(2)} "${worst.text}"`)
          expect(worst.ratio, `lowest contrast ${worst.ratio.toFixed(2)} on "${worst.text}" (${width}px ${scheme})`).toBeGreaterThanOrEqual(4.5)
          // Move picker honors the child board's enforced WIP mode: the at-limit column is disabled with its reason.
          await tab.getByRole('button', { name: /^Move Pen-test/ }).click()
          const dialog = page.getByRole('dialog', { name: /^Move Pen-test/ })
          await expect(dialog.getByRole('radio', { name: /^Blocked 4 of 4/ })).toBeDisabled()
          await expect(dialog).toContainText('At its limit of 4')
          const dialogWorst = await lowestContrast(dialog)
          console.log(`contrast-2209 ${width} ${scheme} move ${dialogWorst.ratio.toFixed(2)} "${dialogWorst.text}"`)
          expect(dialogWorst.ratio, `Move picker lowest contrast ${dialogWorst.ratio.toFixed(2)} on "${dialogWorst.text}"`).toBeGreaterThanOrEqual(4.5)
          await dialog.getByRole('button', { name: 'Close move' }).click()
          await expect(dialog).toBeHidden()
          // Unlink acts at once and offers Undo on a toast (owner decision 2026-11-22).
          await tab.getByRole('button', { name: /^Unlink child Pen-test/ }).click()
          const toast = page.getByTestId('unlink-child-toast')
          await expect(toast).toBeVisible()
          await expect(toast.getByRole('button', { name: 'Undo' })).toBeVisible()
        }
        // No sideways scroll inside the sheet, in any state.
        const overflow = await tab.evaluate((el) => el.scrollWidth - el.clientWidth)
        expect(overflow, `${m} overflows by ${overflow}px`).toBeLessThanOrEqual(0)
      }
    })
  }
}

// The child's "‹ <parent>" header (#2209 Back link): target size, contrast, and the round trip back to the
// parent's Children tab with focus on the same child, on a phone and a wide window, in light and dark.
for (const width of [390, 880]) {
  for (const scheme of ['light', 'dark'] as const) {
    test(`Back to parent from a child at ${width}px, ${scheme}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 })
      await page.emulateMedia({ colorScheme: scheme })
      await setup(page, () => 'populated')
      await page.goto(`/boards/${PARENT_BOARD.id}?card=${CHILD_CARD.id}&from_parent=${PARENT_CARD.id}`)
      const back = page.getByTestId('back-to-parent')
      await expect(back).toBeVisible({ timeout: 10_000 })
      await expect(back).toContainText('Launch plan')
      await expect(page.locator('html')).toHaveAttribute('data-theme', scheme)
      const box = await back.boundingBox()
      // 44px on the full-screen phone sheet; the desktop sheet keeps its compact 24px control.
      expect(box!.height, `back control height at ${width}px`).toBeGreaterThanOrEqual(width <= 640 ? 44 : 24)
      const worst = await lowestContrast(back)
      console.log(`contrast-2209 ${width} ${scheme} back ${worst.ratio.toFixed(2)} "${worst.text}"`)
      expect(worst.ratio, `back link contrast ${worst.ratio.toFixed(2)} (${width}px ${scheme})`).toBeGreaterThanOrEqual(4.5)
      // Pin where the link goes before following it, not by polling the address bar afterwards (#2530): BoardView
      // consumes a `?card=` deep link as soon as it opens the card (`replace: true`), so `tab=children` is in the
      // URL only briefly. Whether a poll sees it depends on timing, and once missed it never comes back, so a
      // longer timeout cannot help.
      await expect(back).toHaveAttribute('href', `/boards/${PARENT_BOARD.id}?card=${PARENT_CARD.id}&tab=children&focus_child=${CHILD_CARD.id}`)
      await back.click()
      const tab = page.getByTestId('card-children-tab')
      await expect(tab).toBeVisible({ timeout: 10_000 })
      await expect(tab.locator(`a[data-child-id="${CHILD_CARD.id}"]`)).toBeFocused()
      // The parent's own sheet, not the child's: the parent has no parent, so no "‹ <parent>" header.
      await expect(back).toHaveCount(0)
      await expect(page).toHaveURL(`/boards/${PARENT_BOARD.id}?view=board`)
      const workMoved = await lowestContrast(tab.getByTestId('children-work-moved'))
      expect(workMoved.ratio, `Work moved contrast ${workMoved.ratio.toFixed(2)}`).toBeGreaterThanOrEqual(4.5)
    })
  }
}
