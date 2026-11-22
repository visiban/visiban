import { test, expect } from '@playwright/test'
import { routeAuth, routeBoard } from './helpers'
import { BOARD_FULL, CARD } from './fixtures/board'

// The Parent filter's two surfaces outside the card sheet (#2209, #2499): the board Filters panel's Parent row
// and the History view's removable Parent chip. Each at desktop and 390px, light and dark, operated by keyboard,
// with the lowest measured text contrast of the surface held to WCAG AA 4.5:1.
const parent = {
  hidden: false, id: 50, title: 'Initech: security review', board_id: 9, board_name: 'Pipeline', column_id: 1,
  column_name: 'Qualify', swimlane_id: 1, swimlane_name: 'Acme', archived: false, board_parent_name_singular: '',
}
const BOARD = { ...BOARD_FULL, cards: [{ ...CARD, parent }, { ...CARD, id: 2, uid: 'card000002a', title: 'Second', parent: null }] }

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


for (const width of [1280, 390]) {
  for (const scheme of ['light', 'dark'] as const) {
    test.describe(`Parent filter surfaces at ${width}px, ${scheme}`, () => {
      test.beforeEach(async ({ page }) => {
        await page.setViewportSize({ width, height: 900 })
        await page.emulateMedia({ colorScheme: scheme })
        await routeAuth(page)
        await routeBoard(page, BOARD as typeof BOARD_FULL)
        await page.route(`**/api/v1/boards/${BOARD.id}/movements/**`, (route) =>
          route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ count: 0, results: [] }) }),
        )
      })

      test('board Filters panel: the Parent row is keyboard operable and readable', async ({ page }) => {
        await page.goto(`/boards/${BOARD.id}`)
        await page.getByRole('button', { name: /^Filters/ }).click()
        const row = page.getByRole('button', { name: /^Parent Any$/ })
        await expect(row).toBeVisible()
        await row.focus()
        await page.keyboard.press('Enter')
        const group = page.getByRole('radiogroup', { name: 'Parent' })
        await expect(group).toBeVisible()
        await expect(group.getByRole('radio')).toHaveCount(4)
        const radio = group.getByRole('radio', { name: 'Initech: security review' })
        await radio.focus()
        await page.keyboard.press('Space')
        await expect(radio).toBeChecked()
        const worst = await lowestContrast(group)
        console.log(`contrast-2499 ${width} ${scheme} panel ${worst.ratio.toFixed(2)} "${worst.text}"`)
        expect(worst.ratio, `panel contrast ${worst.ratio.toFixed(2)} on "${worst.text}"`).toBeGreaterThanOrEqual(4.5)
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
        expect(overflow).toBeLessThanOrEqual(0)
      })

      test('History Parent chip: Tab reaches it, Enter removes it and the URL forgets it', async ({ page }) => {
        await page.goto(`/boards/${BOARD.id}?view=history&parent=50`)
        const chip = page.getByTestId('history-parent-chip')
        await expect(chip).toContainText('Initech: security review')
        const worst = await lowestContrast(chip)
        console.log(`contrast-2499 ${width} ${scheme} chip ${worst.ratio.toFixed(2)} "${worst.text}"`)
        expect(worst.ratio, `chip contrast ${worst.ratio.toFixed(2)} on "${worst.text}"`).toBeGreaterThanOrEqual(4.5)
        const target = chip.getByRole('button', { name: 'Parent: Initech: security review, remove' }).first()
        await target.focus()
        await expect(target).toBeFocused()
        if (width <= 390) {
          const box = await chip.locator('button').boundingBox()
          expect(box!.width, 'remove target width').toBeGreaterThanOrEqual(44)
          expect(box!.height, 'remove target height').toBeGreaterThanOrEqual(44)
        }
        await page.keyboard.press('Enter')
        await expect(chip).toHaveCount(0)
        await expect(page).not.toHaveURL(/parent=/)
        await page.reload()
        await expect(page.getByTestId('history-parent-chip')).toHaveCount(0)
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
        expect(overflow).toBeLessThanOrEqual(0)
      })
    })
  }
}
