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
    await page.getByText('+ Add card').first().click()
    const titleInput = page.getByPlaceholder('Card title…')
    await titleInput.fill('New task')
    // close_editor_on_enter is false in the user fixture, so Enter does not submit.
    // Click the "Add" button explicitly.
    await page.getByRole('button', { name: 'Add' }).first().click()

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
