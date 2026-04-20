import { test, expect } from '@playwright/test'
import { routeAuth, routeBoard } from './helpers'
import { BOARD_FULL, CARD, COLUMN_TODO, SWIMLANE } from './fixtures/board'

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
    // Mock the card creation endpoint.
    await page.route(`**/api/v1/boards/${BOARD_FULL.id}/cards/`, async (route) => {
      if (route.request().method() === 'POST') {
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
    await page.getByText(/^\+\s*add card$/i).first().click()
    const titleInput = page.getByPlaceholder(/card title|title/i).or(page.locator('input[name="title"], textarea[name="title"]')).first()
    await titleInput.fill('New task')
    await titleInput.press('Enter')

    // The new card title should appear in the board.
    await expect(page.getByText('New task').first()).toBeVisible({ timeout: 5_000 })
  })

  test('moves a card between columns via drag-and-drop', async ({ page }) => {
    let moveRequestBody: unknown = null
    await page.route(`**/api/v1/boards/${BOARD_FULL.id}/cards/${CARD.uid}/move/`, async (route) => {
      moveRequestBody = JSON.parse(route.request().postData() ?? '{}')
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ...CARD, column: 2 }),
      })
    })

    await page.goto(`/boards/${BOARD_FULL.id}`)
    await expect(page.getByText(CARD.title).first()).toBeVisible({ timeout: 10_000 })

    const cardEl = page.getByText(CARD.title).first()
    const doneHeader = page.getByText('Done').first()

    // Drag the card to the Done column header.
    // dnd-kit uses PointerSensor with a 5px activation distance.
    // We use page.mouse sequences so pointer events match what PointerSensor expects.
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

    // Verify the move API was called.
    await expect.poll(() => moveRequestBody, { timeout: 5_000 }).not.toBeNull()
  })
})
