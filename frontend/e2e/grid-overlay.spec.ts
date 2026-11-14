import { test, expect, type Page } from '@playwright/test'
import { routeAuth } from './helpers'
import { BOARD_FULL, CARD, COLUMN_DONE, COLUMN_TODO, LABEL_BUG, SWIMLANE } from './fixtures/board'

/**
 * The grid overlay slot and picker in a real browser (#1163, shipped in #1147). jsdom has no
 * paint order, no portal placement and no resolved theme tokens, so these are the checks
 * that the tint stays under the cards, the non-color channels ride along with it, the
 * picker menu opens where the button is, and the whole thing holds in both themes.
 * Dwell time has its own spec (grid-overlay-dwell.spec.ts); this one drives Card count,
 * the overlay that needs no timestamps.
 */

const COLUMN_DOING = { ...COLUMN_TODO, id: 3, uid: 'col0000003w', name: 'Doing', position: 1 }
const COLUMN_FINISHED = { ...COLUMN_DONE, position: 2 }

function card(id: number, column: number, title: string) {
  return { ...CARD, id, uid: `card00000${id}x`, column, title, labels: [] }
}

// Todo holds the most cards, so it is the top of the relative scale.
const CARDS = [
  card(11, COLUMN_TODO.id, 'Todo one'),
  card(12, COLUMN_TODO.id, 'Todo two'),
  card(13, COLUMN_TODO.id, 'Todo three'),
  card(14, COLUMN_DOING.id, 'Doing one'),
]

async function openBoard(page: Page, cards: unknown[] = CARDS) {
  await routeAuth(page)
  const board = { ...BOARD_FULL, columns: [COLUMN_TODO, COLUMN_DOING, COLUMN_FINISHED], swimlanes: [SWIMLANE], cards }
  await page.route(`**/api/v1/boards/${BOARD_FULL.id}/full/`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(board) }),
  )
  await page.route(`**/api/v1/boards/${BOARD_FULL.id}/cards/`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ count: cards.length, results: cards }) }),
  )
  await page.route(`**/api/v1/boards/${BOARD_FULL.id}/saved-filters/`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) }),
  )
  await page.routeWebSocket(`**/ws/boards/${BOARD_FULL.id}/`, (ws) => {
    ws.send(JSON.stringify({ event: 'connected', data: {} }))
  })
  await page.goto(`/boards/${BOARD_FULL.id}`)
  await expect(page.getByText('Todo one').first()).toBeVisible({ timeout: 10_000 })
}

async function pickOverlay(page: Page, name: string) {
  // The trigger reads "Overlay" at rest and takes the active overlay's own name while one is on.
  await page.getByRole('button', { name: /^(Overlay|Card count|Dwell time)$/ }).click()
  await page.getByRole('menuitem', { name }).click()
}

const cellOf = (page: Page, title: string) =>
  page.getByText(title).first().locator('xpath=ancestor::*[@data-board-cell][1]')

const legend = (page: Page) => page.getByRole('group', { name: 'Card count overlay scale' })

for (const scheme of ['light', 'dark'] as const) {
  test.describe(`grid overlay picker, ${scheme} theme`, () => {
    test.beforeEach(async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme })
      await openBoard(page)
      await expect(page.locator('html')).toHaveAttribute('data-theme', scheme)
    })

    test('Card count adds tint, a bar and a value, and None takes them all away', async ({ page }) => {
      // Nothing is shaded before an overlay is chosen.
      await expect(page.getByRole('img', { name: /^Card count:/ })).toHaveCount(0)
      await expect(legend(page)).toHaveCount(0)

      await pickOverlay(page, 'Card count')

      const busiest = cellOf(page, 'Todo one')
      // Non-color channel: the value is in the accessibility tree with its level wording.
      const badge = busiest.getByRole('img', { name: 'Card count: 3 cards, level 4 of 4' })
      await expect(badge).toHaveText('3')
      // Color channel + geometric channel ship together at the top level.
      await expect(busiest.locator('.bg-primary-emphasis\\/40')).toHaveCount(1)
      await expect(busiest.locator('.h-1')).toHaveCount(1)

      const lighter = cellOf(page, 'Doing one')
      await expect(lighter.getByRole('img', { name: /^Card count: 1 card, level \d of 4$/ })).toHaveText('1')
      // A cell with no cards has no reading at all.
      await expect(cellOf(page, 'Doing one').getByRole('img')).toHaveCount(1)

      await pickOverlay(page, 'None')
      await expect(page.getByRole('img', { name: /^Card count:/ })).toHaveCount(0)
      await expect(busiest.locator('.bg-primary-emphasis\\/40')).toHaveCount(0)
      await expect(legend(page)).toHaveCount(0)
    })

    test('shows the legend with the overlay name and the busiest cell value', async ({ page }) => {
      await pickOverlay(page, 'Card count')
      await expect(legend(page)).toBeVisible()
      await expect(legend(page)).toContainText('Card count')
      await expect(legend(page)).toContainText('3')
    })

    test('the tint sits under the cards: titles stay on top and the badge is opaque', async ({ page }) => {
      await pickOverlay(page, 'Card count')
      const title = page.getByText('Todo one').first()
      const onTop = await title.evaluate((el) => {
        const r = el.getBoundingClientRect()
        const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
        return !!hit?.closest('[data-card-id]')
      })
      expect(onTop).toBe(true)
      const badge = cellOf(page, 'Todo one').getByRole('img', { name: /^Card count:/ })
      const [badgeColor, canvas] = await badge.evaluate((el) => [
        getComputedStyle(el).backgroundColor,
        `rgb(${getComputedStyle(document.documentElement).getPropertyValue('--canvas').trim().split(/\s+/).join(', ')})`,
      ])
      expect(badgeColor).toBe(canvas)
    })
  })
}

test.describe('grid overlay picker menu and filters', () => {
  test('the picker menu opens at its button, lists the overlays, and closes on Escape', async ({ page }) => {
    await openBoard(page)
    const button = page.getByRole('button', { name: /^Overlay$/ })
    await button.click()
    const menu = page.getByRole('menu')
    await expect(menu).toBeVisible()
    for (const name of ['None', 'Card count', 'Dwell time']) {
      await expect(menu.getByRole('menuitem', { name })).toBeVisible()
    }
    // Portal placement: the menu is anchored to the button, not stranded at the page origin.
    const [b, m] = await Promise.all([button.boundingBox(), menu.boundingBox()])
    expect(b && m).toBeTruthy()
    expect(Math.abs(m!.y - (b!.y + b!.height))).toBeLessThan(40)
    expect(m!.x).toBeGreaterThan(b!.x - m!.width)
    await page.keyboard.press('Escape')
    await expect(menu).toHaveCount(0)
  })

  test('the legend says no values match when filters leave the overlay nothing to scale', async ({ page }) => {
    await openBoard(page, CARDS.map((c) => ({ ...c, labels: [] })))
    await pickOverlay(page, 'Card count')
    await expect(legend(page)).toBeVisible()
    await expect(legend(page)).not.toContainText('No values')

    // The board's only label is "Bug" and no card carries it, so this filter matches nothing.
    await page.keyboard.press('f')
    await page.getByRole('button', { name: '+ Filter' }).click()
    await page.getByRole('checkbox', { name: 'Label' }).click()
    await page.getByRole('button', { name: /^Label/ }).click()
    await page.getByRole('checkbox', { name: LABEL_BUG.name }).click()
    await page.keyboard.press('Escape')

    await expect(legend(page)).toContainText('No values match the active filters.')
    await expect(page.getByRole('img', { name: /^Card count:/ })).toHaveCount(0)
  })
})
