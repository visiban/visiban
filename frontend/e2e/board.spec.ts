import { test, expect } from '@playwright/test'
import { routeAuth, routeBoard } from './helpers'
import { BOARD_FULL, CARD, COLUMN_DONE, COLUMN_TODO, SWIMLANE } from './fixtures/board'

test.describe('board view', () => {
  test.beforeEach(async ({ page }) => {
    await routeAuth(page)
    await routeBoard(page)
  })

  test('renders column and swimlane names', async ({ page }) => {
    await page.goto(`/boards/${BOARD_FULL.id}`)
    await expect(page.getByText(COLUMN_TODO.name).first()).toBeVisible({ timeout: 10_000 })
    await expect(page.getByText('Done').first()).toBeVisible()
    await expect(page.getByText(SWIMLANE.name).first()).toBeVisible()
  })

  test('renders the existing card in its column', async ({ page }) => {
    await page.goto(`/boards/${BOARD_FULL.id}`)
    await expect(page.getByText(CARD.title).first()).toBeVisible({ timeout: 10_000 })
  })

  test('creates a card via the add-card affordance', async ({ page }) => {
    const newCard = { ...CARD, id: 2, uid: 'card000002b', title: 'New task', position: 1 }
    let createRequestBody: unknown = null
    // Mock the card creation endpoint.
    await page.route(`**/api/v1/boards/${BOARD_FULL.id}/cards/`, async (route) => {
      if (route.request().method() === 'POST') {
        createRequestBody = JSON.parse(route.request().postData() ?? '{}')
        return route.fulfill({
          status: 201,
          contentType: 'application/json',
          body: JSON.stringify(newCard),
        })
      }
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ count: 1, results: [CARD] }),
      })
    })

    await page.goto(`/boards/${BOARD_FULL.id}`)
    await expect(page.getByText(COLUMN_TODO.name).first()).toBeVisible({ timeout: 10_000 })

    // Click the "+ Add card" affordance in the first column/swimlane cell.
    // Only the To Do column allows card creation (COLUMN_DONE.allow_card_creation
    // is false), so the first match is unambiguously To Do / General.
    await page.getByRole('button', { name: /^Add card to / }).first().click()
    const titleInput = page.getByPlaceholder('Card title…')
    await titleInput.fill('New task')
    // close_editor_on_enter is false in the user fixture, so Enter does not submit.
    // Click the "Add" button explicitly.
    await page.getByRole('button', { name: 'Add', exact: true }).first().click()

    // Assert the actual POST payload (api/cards.ts createCard) rather than just
    // that *a* request happened — board/swimlane/column mismatches or an
    // optimistic-only local insert would otherwise pass silently.
    await expect.poll(() => createRequestBody, { timeout: 5_000 }).toEqual({
      column: COLUMN_TODO.id,
      swimlane: SWIMLANE.id,
      title: 'New task',
    })

    // The new card title should appear in the board.
    await expect(page.getByText('New task').first()).toBeVisible({ timeout: 5_000 })
  })

  test('column-header + asks which swimlane when the board has several (#2317)', async ({ page }) => {
    const mobile = { ...SWIMLANE, id: 2, uid: 'swim000002m', name: 'Mobile', position: 1, color: '#10B981' }
    await routeBoard(page, { ...BOARD_FULL, swimlanes: [SWIMLANE, mobile] })
    await page.goto(`/boards/${BOARD_FULL.id}`)
    const plus = page.getByRole('button', { name: `Add card to ${COLUMN_TODO.name}`, exact: true })
    await expect(plus).toBeVisible({ timeout: 10_000 })
    await plus.click()
    const menu = page.getByRole('menu', { name: 'Add card to which swimlane?' })
    await expect(menu.getByRole('menuitem')).toHaveText([SWIMLANE.name, 'Mobile'])
    // Escape closes the menu and returns focus to the +.
    await page.keyboard.press('Escape')
    await expect(menu).toBeHidden()
    await expect(plus).toBeFocused()
    // Picking the second lane opens the input in that lane's cell, not the first lane's.
    await plus.click()
    await menu.getByRole('menuitem', { name: 'Mobile' }).click()
    const input = page.getByPlaceholder('Card title…')
    await expect(input).toBeVisible()
    await expect(page.locator('[data-board-cell][data-swimlane-id="2"][data-column-id="' + COLUMN_TODO.id + '"]').getByPlaceholder('Card title…')).toBeVisible()
  })

  test('column headers stay visible after scrolling past the first lane (#2270)', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 500 })
    await page.goto(`/boards/${BOARD_FULL.id}`)
    const scroller = page.locator('[data-board-scroll]')
    const headerRow = page.getByTestId('board-header-row')
    await expect(headerRow).toBeVisible({ timeout: 10_000 })
    // Stand in for many tall lanes: a spacer below the lane rows makes the board scroll vertically.
    await scroller.evaluate((el) => {
      const spacer = document.createElement('div')
      spacer.style.height = '2000px'
      el.firstElementChild!.appendChild(spacer)
      el.scrollTop = 900
    })
    await expect.poll(() => scroller.evaluate((el) => el.scrollTop)).toBeGreaterThan(500)
    const [rowBox, scrollBox] = [await headerRow.boundingBox(), await scroller.boundingBox()]
    expect(Math.abs(rowBox!.y - scrollBox!.y)).toBeLessThanOrEqual(1)
    await expect(page.getByRole('button', { name: `Add card to ${COLUMN_TODO.name}`, exact: true })).toBeInViewport()
  })

  test('a tall cell does not stretch the cards in its neighbor cell (#2270)', async ({ page }) => {
    // Six same-shaped cards pile up in To Do; Done holds one with identical content.
    const mk = (id: number, column: number, position: number) => ({
      ...CARD,
      id,
      uid: `cardstretch${id}`,
      column,
      title: `Stretch card ${id}`,
      position,
    })
    const todoCards = [1, 2, 3, 4, 5, 6].map((n) => mk(100 + n, COLUMN_TODO.id, n))
    const doneCard = mk(200, COLUMN_DONE.id, 1)
    const board = { ...BOARD_FULL, cards: [...todoCards, doneCard] }
    await page.unroute(`**/api/v1/boards/${BOARD_FULL.id}/full/`)
    await page.unroute(`**/api/v1/boards/${BOARD_FULL.id}/cards/`)
    await routeBoard(page, board)
    await page.goto(`/boards/${BOARD_FULL.id}`)
    const baseline = page.locator('[data-card-id="101"]')
    const neighbor = page.locator('[data-card-id="200"]')
    await expect(baseline).toBeVisible({ timeout: 10_000 })
    await expect(neighbor).toBeVisible()
    const [b, n] = [await baseline.boundingBox(), await neighbor.boundingBox()]
    // The To Do cell is several cards tall; the Done card must keep its natural height.
    const lastTodo = await page.locator('[data-card-id="106"]').boundingBox()
    expect(lastTodo!.y + lastTodo!.height - b!.y).toBeGreaterThan(b!.height * 4)
    expect(n!.height).toBeCloseTo(b!.height, 0)
  })

  test('blank space below cards in a short populated cell is one big add target (#2319)', async ({ page }) => {
    const mk = (id: number, column: number, position: number) => ({
      ...CARD,
      id,
      uid: `cardblank${id}`,
      column,
      title: `Blank card ${id}`,
      position,
    })
    // Done is tall (five cards, creation off); To Do (addable) holds one, so its cell has blank
    // space below the card.
    const doneCards = [1, 2, 3, 4, 5].map((n) => mk(300 + n, COLUMN_DONE.id, n))
    const board = { ...BOARD_FULL, cards: [...doneCards, mk(400, COLUMN_TODO.id, 1)] }
    await page.unroute(`**/api/v1/boards/${BOARD_FULL.id}/full/`)
    await page.unroute(`**/api/v1/boards/${BOARD_FULL.id}/cards/`)
    await routeBoard(page, board)
    await page.goto(`/boards/${BOARD_FULL.id}`)
    const todoCard = page.locator('[data-card-id="400"]')
    await expect(todoCard).toBeVisible({ timeout: 10_000 })
    const cell = page.locator('[data-board-cell]').filter({ has: todoCard })
    // Named like the empty cell (#2320).
    const addBtn = cell.getByRole('button', { name: /^Add card to / })
    await addBtn.hover()
    // The button fills the blank well space, far taller than a single-row strip.
    await expect.poll(async () => (await addBtn.boundingBox())!.height).toBeGreaterThan(40)
    // Clicking the lower blank area (not the top text line) opens the new-card input.
    const box = (await addBtn.boundingBox())!
    await page.mouse.click(box.x + box.width / 2, box.y + box.height - 6)
    await expect(page.getByPlaceholder('Card title…')).toBeVisible()
  })

  test('the grid scrolls sideways inside its own box on a narrow window (#2270)', async ({ page }) => {
    // 700px: below 640px the board is the phone layout (#2277), covered by board-phone.spec.ts.
    await page.setViewportSize({ width: 700, height: 700 })
    await page.goto(`/boards/${BOARD_FULL.id}`)
    const scroller = page.locator('[data-board-scroll]')
    await expect(scroller).toBeVisible({ timeout: 10_000 })
    const m = await scroller.evaluate((el) => ({ sw: el.scrollWidth, cw: el.clientWidth, page: document.documentElement.scrollWidth, win: window.innerWidth }))
    expect(m.sw).toBeGreaterThan(m.cw)
    expect(m.page).toBeLessThanOrEqual(m.win)
  })

  // #2300: one grid template for the header row and the lanes. Below 1240px of board
  // width the grid scrolls inside its own box, and the columns stay aligned both ways.
  test('below 1240px the shared grid scrolls in its own box and stays aligned (#2300)', async ({ page }) => {
    await page.setViewportSize({ width: 1200, height: 700 })
    await page.goto(`/boards/${BOARD_FULL.id}`)
    const scroller = page.locator('[data-board-scroll]')
    const headerRow = page.getByTestId('board-header-row')
    await expect(headerRow).toBeVisible({ timeout: 10_000 })
    const m = await scroller.evaluate((el) => ({ sw: el.scrollWidth, cw: el.clientWidth, page: document.documentElement.scrollWidth, win: window.innerWidth }))
    expect(m.cw).toBeLessThan(1240)
    expect(m.sw).toBeGreaterThanOrEqual(1240)
    expect(m.page).toBeLessThanOrEqual(m.win)

    const header = headerRow.getByText(COLUMN_DONE.name, { exact: true }).first()
    const cell = page.locator(`[data-board-cell][data-column-id="${COLUMN_DONE.id}"]`).first()
    await scroller.evaluate((el) => {
      const spacer = document.createElement('div')
      spacer.style.height = '1500px'
      el.firstElementChild!.appendChild(spacer)
      el.scrollLeft = 150
      el.scrollTop = 40
    })
    await expect.poll(() => scroller.evaluate((el) => el.scrollLeft)).toBeGreaterThan(100)
    const tplHeader = await headerRow.evaluate((el) => getComputedStyle(el).gridTemplateColumns)
    const tplLane = await cell.evaluate((el) => {
      let row = el.parentElement
      while (row && getComputedStyle(row).display !== 'grid') row = row.parentElement
      return row ? getComputedStyle(row).gridTemplateColumns : 'no grid row'
    })
    // Same resolved track sizes in px, so every column lines up.
    expect(tplLane).toBe(tplHeader)
    const [h, c] = [await header.boundingBox(), await cell.boundingBox()]
    expect(h).not.toBeNull()
    // The header's name sits inside the column; the cell spans the same track.
    expect(h!.x).toBeGreaterThanOrEqual(c!.x - 1)
    expect(h!.x).toBeLessThan(c!.x + c!.width)
  })

  // #1990 kept under #2300: dragging a header separator resizes the column to its left.
  // The saved width is a track weight in the one shared template, so the header cell
  // and every lane cell of that column change together and stay aligned.
  test('dragging a column separator resizes the column in the header and every lane (#1990, #2300)', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 800 })
    await page.goto(`/boards/${BOARD_FULL.id}`)
    const headerRow = page.getByTestId('board-header-row')
    await expect(headerRow).toBeVisible({ timeout: 10_000 })
    const cell = page.locator('[data-board-cell]').first()
    await expect(cell).toBeVisible()
    const colId = await cell.getAttribute('data-column-id')
    const laneCells = page.locator(`[data-board-cell][data-column-id="${colId}"]`)
    const seps = headerRow.getByTestId('column-separator')
    const headerTrack = async () => {
      const [a, b] = [await seps.nth(0).boundingBox(), await seps.nth(1).boundingBox()]
      return { left: a!.x + a!.width, width: b!.x - (a!.x + a!.width) }
    }
    const before = await headerTrack()
    const cellBefore = (await cell.boundingBox())!
    expect(Math.abs(cellBefore.width - before.width)).toBeLessThanOrEqual(1)

    const handle = (await seps.nth(1).boundingBox())!
    await expect(seps.nth(1)).toHaveClass(/cursor-col-resize/)
    await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2)
    await page.mouse.down()
    await page.mouse.move(handle.x + handle.width / 2 + 60, handle.y + handle.height / 2, { steps: 4 })
    await page.mouse.move(handle.x + handle.width / 2 + 120, handle.y + handle.height / 2, { steps: 4 })
    await page.mouse.up()

    // No add-column modal: a drag is not a click.
    await expect(page.getByRole('dialog')).toHaveCount(0)
    // The dragged edge ends under the pointer: a column's saved width is an fr
    // weight, and the resize accounts for the other tracks' share (#2300), so the
    // separator follows the pointer rather than lagging behind it.
    const pointerX = handle.x + handle.width / 2 + 120
    await expect.poll(async () => {
      const box = (await seps.nth(1).boundingBox())!
      return Math.abs(box.x + box.width / 2 - pointerX)
    }).toBeLessThanOrEqual(2)
    expect((await headerTrack()).width).toBeGreaterThan(before.width + 118)
    const after = await headerTrack()
    const n = await laneCells.count()
    expect(n).toBeGreaterThan(0)
    for (let i = 0; i < n; i++) {
      const box = await laneCells.nth(i).boundingBox()
      if (!box) continue
      // Same track in every row: same left edge and width as the header cell.
      expect(Math.abs(box.x - after.left)).toBeLessThanOrEqual(1)
      expect(Math.abs(box.width - after.width)).toBeLessThanOrEqual(1)
    }
    const tplHeader = await headerRow.evaluate((el) => getComputedStyle(el).gridTemplateColumns)
    const tplLane = await cell.evaluate((el) => {
      let row = el.parentElement
      while (row && getComputedStyle(row).display !== 'grid') row = row.parentElement
      return row ? getComputedStyle(row).gridTemplateColumns : 'no grid row'
    })
    expect(tplLane).toBe(tplHeader)
    // The width is saved per board, as before the shared template.
    const saved = await page.evaluate((id) => {
      const raw = localStorage.getItem(`board:${id}:view-prefs`)
      return raw ? (JSON.parse(raw).columnWidths ?? {}) : {}
    }, BOARD_FULL.id)
    expect(saved[colId!]).toBeGreaterThan(220)
    // The page never scrolls sideways.
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0)
  })

  // #2305: on a board wider than the window, the swimlane band (name and stats) stays
  // in view while the grid scrolls sideways.
  test('the swimlane band keeps its name and stats in view after scrolling sideways (#2305)', async ({ page }) => {
    const extra = Array.from({ length: 9 }, (_, i) => ({
      ...COLUMN_TODO,
      id: 900 + i,
      uid: `colwide00${i}`,
      name: `Wide ${i}`,
      position: 10 + i,
    }))
    const board = { ...BOARD_FULL, columns: [...BOARD_FULL.columns, ...extra] }
    await page.unroute(`**/api/v1/boards/${BOARD_FULL.id}/full/`)
    await page.unroute(`**/api/v1/boards/${BOARD_FULL.id}/cards/`)
    await routeBoard(page, board)
    await page.setViewportSize({ width: 1440, height: 800 })
    await page.goto(`/boards/${BOARD_FULL.id}`)
    const scroller = page.locator('[data-board-scroll]')
    const band = page.getByTestId('swimlane-band').first()
    await expect(band).toBeVisible({ timeout: 10_000 })
    const m = await scroller.evaluate((el) => ({ sw: el.scrollWidth, cw: el.clientWidth }))
    expect(m.sw).toBeGreaterThan(m.cw)
    await scroller.evaluate((el) => { el.scrollLeft = el.scrollWidth })
    await expect.poll(() => scroller.evaluate((el) => el.scrollLeft)).toBeGreaterThan(100)
    await expect(band.getByTestId('swimlane-name')).toBeInViewport({ ratio: 1 })
    // The band's right end (the focus icon; the card count is gone, #2328) stays on screen too.
    await expect(band.getByRole('button', { name: /^Focus on / })).toBeInViewport({ ratio: 1 })
    const [bandBox, scrollBox] = [await band.boundingBox(), await scroller.boundingBox()]
    expect(bandBox!.x).toBeGreaterThanOrEqual(scrollBox!.x)
    expect(bandBox!.x + bandBox!.width).toBeLessThanOrEqual(scrollBox!.x + scrollBox!.width)
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0)
    // The last column's cell is reachable: the band does not cover the grid.
    await expect(page.locator(`[data-board-cell][data-column-id="908"]`).first()).toBeInViewport()
  })

  test('moves a card between columns via drag-and-drop', async ({ page }) => {
    let moveRequestBody: unknown = null
    await page.route(`**/api/v1/boards/${BOARD_FULL.id}/cards/${CARD.id}/move/`, async (route) => {
      moveRequestBody = JSON.parse(route.request().postData() ?? '{}')
      // The real move endpoint (boards/views/cards.py MoveCard.move) responds
      // with { card, movement? } — moveCard() in api/cards.ts destructures
      // `card` from it. Returning the bare card here (as this mock used to)
      // would make the UI apply `card: undefined`, which this test's extra
      // assertion below would have caught.
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ card: { ...CARD, column: COLUMN_DONE.id, swimlane: SWIMLANE.id, position: 0 } }),
      })
    })

    await page.goto(`/boards/${BOARD_FULL.id}`)
    await expect(page.getByText(CARD.title).first()).toBeVisible({ timeout: 10_000 })

    // Scoped to the actual CardItem element (data-tour-step="card"), not
    // plain getByText(CARD.title): after the drop, the sr-only dnd
    // announcement region (role="status") renders text containing the card's
    // title too ("Card 'First task' moved to column 'Done', swimlane
    // 'General'"), and getByText does substring matching — .first() would
    // otherwise resolve to that 1x1 off-screen node instead of the card.
    const cardEl = page.locator('[data-tour-step="card"]').filter({ hasText: CARD.title }).first()
    const doneHeader = page.getByText('Done').first()

    // Drag the card to the Done column header.
    // dnd-kit uses MouseSensor with a 5px activation distance (useDragSensors).
    // We use page.mouse sequences so mouse events match what MouseSensor expects.
    const cardBox = await cardEl.boundingBox()
    const doneBox = await doneHeader.boundingBox()
    if (!cardBox || !doneBox) throw new Error('Could not locate card or Done column')

    const fromX = cardBox.x + cardBox.width / 2
    const fromY = cardBox.y + cardBox.height / 2
    const toX = doneBox.x + doneBox.width / 2
    const toY = doneBox.y + doneBox.height / 2

    await page.mouse.move(fromX, fromY)
    await page.mouse.down()
    // Move past the 5px activation distance before heading to the target.
    await page.mouse.move(fromX, fromY + 10, { steps: 3 })
    await page.mouse.move(toX, toY, { steps: 10 })
    await page.mouse.up()

    // Assert the exact move payload (api/cards.ts moveCard / backend
    // CardViewSet.move) — a move to the wrong column/swimlane/position would
    // otherwise pass as long as *some* request fired. BOARD_FULL seeds a
    // single swimlane and no cards in the Done column, so the destination
    // cell is unambiguous and the target position is 0.
    await expect.poll(() => moveRequestBody, { timeout: 5_000 }).toEqual({
      column_id: COLUMN_DONE.id,
      swimlane_id: SWIMLANE.id,
      position: 0,
      version: CARD.version,
    })

    // And assert the card actually renders under the Done column afterward —
    // the mocked response's column/swimlane must be reflected in the DOM, not
    // just accepted by an optimistic local update.
    await expect.poll(async () => {
      const box = await cardEl.boundingBox()
      return box ? box.x : null
    }, { timeout: 5_000 }).not.toBeNull()
    const movedCardBox = await cardEl.boundingBox()
    if (!movedCardBox) throw new Error('Could not locate card after the move')
    expect(movedCardBox.x).toBeGreaterThan(cardBox.x + 50)
    expect(Math.abs(movedCardBox.x - doneBox.x)).toBeLessThan(150)
  })
})
