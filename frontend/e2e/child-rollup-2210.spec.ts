import { test, expect, type Locator, type Page } from '@playwright/test'
import { routeAuth } from './helpers'
import { BOARD_FULL, CARD } from './fixtures/board'
import { borderColor, contrastRatio, effectiveBackground, fillColor, surfaceColor, textColor } from './contrast'

// #2210 — the parent card's child-progress footer at three densities, in light
// and dark, and at 390px; the live ring, the loading skeleton and the contrast
// of every segment against the card (3:1 non-text, 4.5:1 text; #2206 rule 8).

const DAY = 86_400_000
const ROLLUP = { visible: true, total: 5, done: 2, doing: 1, todo: 1, blocked: 1, last_moved_at: new Date(Date.now() - 1 * DAY).toISOString() }
const PARENT = { ...CARD, id: 11, uid: 'card000011c', title: 'Parent epic', position: 5, children_rollup: ROLLUP }
const IDLE_PARENT = { ...CARD, id: 12, uid: 'card000012c', title: 'Idle epic', position: 6, children_rollup: { ...ROLLUP, blocked: 0, todo: 2, last_moved_at: new Date(Date.now() - 30 * DAY).toISOString() } }

type Density = 'comfortable' | 'standard' | 'dense'

async function openBoard(page: Page, { density, theme, cards = [PARENT] }: { density: Density; theme: 'light' | 'dark'; cards?: unknown[] }) {
  await routeAuth(page)
  await page.addInitScript((t) => localStorage.setItem('user:prefs:theme', t), theme)
  const board = { ...BOARD_FULL, card_density: density, cards_can_have_children: true, cards }
  await page.route(`**/api/v1/boards/${BOARD_FULL.id}/full/`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(board) }))
  await page.route(`**/api/v1/boards/${BOARD_FULL.id}/cards/`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ count: cards.length, results: cards }) }))
  await page.route(`**/api/v1/boards/${BOARD_FULL.id}/saved-filters/`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) }))
  await page.routeWebSocket(`**/ws/boards/${BOARD_FULL.id}/`, (ws) => {
    ws.send(JSON.stringify({ event: 'connected', data: {} }))
  })
  await page.goto(`/boards/${BOARD_FULL.id}`)
}

const footer = (page: Page) => page.getByTestId('card-children-rollup').first()

for (const theme of ['light', 'dark'] as const) {
  test.describe(`child rollup footer (${theme})`, () => {
    test('comfortable shows both rows, a segment per child, blocked in danger', async ({ page }) => {
      await openBoard(page, { density: 'comfortable', theme })
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme)
      const f = footer(page)
      await expect(f).toHaveAttribute('aria-label', /^Children: 2 of 5 done, 1 doing, 1 blocked, 1 to do, work moved 1 day ago/)
      await expect(f.locator('[data-segment]')).toHaveCount(5)
      await expect(f.getByTestId('rollup-blocked')).toHaveText('1 blocked')
      await expect(f.getByTestId('rollup-movement')).toHaveText('Work moved 1 day ago')
    })

    test('standard keeps row 1 only; idle shows there when nothing is blocked', async ({ page }) => {
      await openBoard(page, { density: 'standard', theme, cards: [IDLE_PARENT] })
      const f = footer(page)
      await expect(f.getByTestId('rollup-movement')).toHaveCount(0)
      await expect(f).toContainText('Work idle 30 days')
    })

    test('dense draws the one-line footer with N/M and no bar', async ({ page }) => {
      await openBoard(page, { density: 'dense', theme })
      const f = footer(page)
      await expect(f).toContainText('2/5')
      await expect(f.locator('[data-segment]')).toHaveCount(0)
      await expect(f).toHaveAttribute('aria-label', /^Children: 2 of 5 done/)
    })

    test('every segment holds 3:1 against the card and the text 4.5:1', async ({ page }) => {
      await openBoard(page, { density: 'comfortable', theme, cards: [PARENT, IDLE_PARENT] })
      const f = footer(page)
      const card = await surfaceColor(f)
      const done = await fillColor(f.locator('[data-segment="done"]').first())
      const doingOutline = await borderColor(f.locator('[data-segment="doing"]').first())
      const todoOutline = await borderColor(f.locator('[data-segment="todo"]').first())
      const blockedOutline = await borderColor(f.locator('[data-segment="blocked"]').first())
      const rows: Record<string, number> = {
        done: contrastRatio(done, card),
        doing: contrastRatio(doingOutline, card),
        todo: contrastRatio(todoOutline, card),
        blocked: contrastRatio(blockedOutline, card),
      }
      const blockedText = contrastRatio(await textColor(f.getByTestId('rollup-blocked')), card)
      const movement = contrastRatio(await textColor(f.getByTestId('rollup-movement')), card)
      const idleText = contrastRatio(await textColor(page.getByTestId('rollup-movement').nth(1)), await surfaceColor(page.getByTestId('rollup-movement').nth(1)))
      // eslint-disable-next-line no-console
      console.log(`CONTRAST ${theme} ${JSON.stringify({ ...rows, blockedText, movement, idleText })}`)
      for (const [name, ratio] of Object.entries(rows)) expect(ratio, `${name} segment vs card`).toBeGreaterThanOrEqual(3)
      expect(blockedText, 'blocked text').toBeGreaterThanOrEqual(4.5)
      expect(movement, 'movement text').toBeGreaterThanOrEqual(4.5)
      expect(idleText, 'idle text').toBeGreaterThanOrEqual(4.5)
    })
  })
}

test.describe('child rollup footer at 390px', () => {
  test.use({ viewport: { width: 390, height: 844 } })
  test('keeps its words, no horizontal page scroll, card at least 44px tall', async ({ page }) => {
    await openBoard(page, { density: 'comfortable', theme: 'light' })
    const f = footer(page)
    await expect(f).toBeVisible()
    await expect(f.getByTestId('rollup-movement')).toHaveText('Work moved 1 day ago')
    await expect(f).toContainText('2/5 done')
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    const card = f.locator('xpath=ancestor::*[@data-card-id][1]')
    if (await card.count()) expect((await card.boundingBox())!.height).toBeGreaterThanOrEqual(44)
  })
})

test.describe('child rollup live behavior', () => {
  test('a ping rings only the changed segment, then drops it', async ({ page }) => {
    await routeAuth(page)
    let reads = 0
    const board = { ...BOARD_FULL, cards_can_have_children: true, cards: [PARENT] }
    await page.route(`**/api/v1/boards/${BOARD_FULL.id}/full/`, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(board) }))
    await page.route(`**/api/v1/boards/${BOARD_FULL.id}/cards/`, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ count: 1, results: [PARENT] }) }))
    await page.route(`**/api/v1/boards/${BOARD_FULL.id}/saved-filters/`, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) }))
    await page.route(new RegExp(`/api/v1/boards/${BOARD_FULL.id}/cards/${PARENT.id}/?$`), (r) => {
      reads += 1
      return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ...PARENT, children_rollup: { ...ROLLUP, done: 3, doing: 0 } }) })
    })
    let send: (m: string) => void = () => {}
    await page.routeWebSocket(`**/ws/boards/${BOARD_FULL.id}/`, (ws) => {
      send = (m) => ws.send(m)
      ws.send(JSON.stringify({ event: 'connected', data: {} }))
    })
    await page.goto(`/boards/${BOARD_FULL.id}`)
    await expect(footer(page)).toBeVisible()
    send(JSON.stringify({ event: 'card.children_changed', data: { parent_id: PARENT.id } }))
    await expect.poll(() => reads).toBeGreaterThan(0)
    await expect(footer(page).locator('[data-ringed="true"]')).toHaveCount(1)
    await expect(footer(page).locator('[data-ringed="true"]')).toHaveAttribute('data-segment', 'done')
    await expect(footer(page).getByTestId('rollup-live')).toHaveText('Children: 3 of 5 done')
    await expect(footer(page).locator('[data-ringed="true"]')).toHaveCount(0, { timeout: 4000 })
  })
})

// The live-change ring is a non-text cue: it needs 3:1 against what it is drawn next to. It is a
// box-shadow, so this reads the computed shadow layers. An inset or offset-less ring is drawn
// against the segment's own paint (its outline, else its fill), which is what the old
// `ring-inset` meter ring was measured against (1:1 on Doing). An offset ring is drawn against
// its offset color, which must be the card itself (#2210 round-2 audit).
async function ringMeasure(seg: Locator) {
  const s = await seg.evaluate((n) => {
    const cs = getComputedStyle(n)
    return { shadow: cs.boxShadow, bg: cs.backgroundColor, border: cs.borderTopColor, borderW: parseFloat(cs.borderTopWidth), color: cs.color }
  })
  const layers = s.shadow.split(/,(?![^(]*\))/).map((l) => {
    const color = (l.match(/(rgba?|color)\([^)]*\)/) ?? [''])[0]
    const px = [...l.replace(color, '').matchAll(/(-?[\d.]+)px/g)].map((m) => Number(m[1]))
    return { color, spread: px[3] ?? 0, inset: /inset/.test(l) }
  }).filter((l) => l.spread > 0 && !/rgba\([^)]*,\s*0\)$/.test(l.color))
  layers.sort((a, b) => b.spread - a.spread)
  const [ring, offset] = layers
  if (!ring) throw new Error(`no ring on segment: ${s.shadow}`)
  const transparent = (c: string) => /rgba\([^)]*,\s*0\)$|transparent/.test(c)
  const ownPaint = s.borderW > 0 ? s.border : !transparent(s.bg) ? s.bg : s.color
  const adjacent = ring.inset || !offset ? ownPaint : offset.color
  return { ring: ring.color, adjacent, offset: offset && !ring.inset ? offset.color : null, inset: ring.inset }
}

/** Nothing between the segment and the card clips a ring that reaches 3px outside it. */
async function ringUnclipped(seg: Locator) {
  return seg.evaluate((n) => {
    const r = n.getBoundingClientRect()
    for (let cur = n.parentElement; cur && !cur.hasAttribute('data-card-id'); cur = cur.parentElement) {
      const cs = getComputedStyle(cur)
      if (cs.overflowX === 'visible' && cs.overflowY === 'visible') continue
      const p = cur.getBoundingClientRect()
      if (r.left - 3 < p.left || r.right + 3 > p.right || r.top - 3 < p.top || r.bottom + 3 > p.bottom) return `${cur.tagName}.${cur.className}`
    }
    return null
  })
}

async function openLive(page: Page, theme: 'light' | 'dark', before: object, after: object) {
  await routeAuth(page)
  await page.addInitScript((t) => localStorage.setItem('user:prefs:theme', t), theme)
  const parent = { ...PARENT, children_rollup: { ...ROLLUP, ...before } }
  const board = { ...BOARD_FULL, card_density: 'comfortable', cards_can_have_children: true, cards: [parent] }
  await page.route(`**/api/v1/boards/${BOARD_FULL.id}/full/`, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(board) }))
  await page.route(`**/api/v1/boards/${BOARD_FULL.id}/cards/`, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ count: 1, results: [parent] }) }))
  await page.route(`**/api/v1/boards/${BOARD_FULL.id}/saved-filters/`, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) }))
  await page.route(new RegExp(`/api/v1/boards/${BOARD_FULL.id}/cards/${PARENT.id}/?$`), (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ...parent, children_rollup: { ...ROLLUP, ...after } }) }))
  let send: (m: string) => void = () => {}
  await page.routeWebSocket(`**/ws/boards/${BOARD_FULL.id}/`, (ws) => {
    send = (m) => ws.send(m)
    ws.send(JSON.stringify({ event: 'connected', data: {} }))
  })
  await page.goto(`/boards/${BOARD_FULL.id}`)
  await expect(footer(page)).toBeVisible()
  send(JSON.stringify({ event: 'card.children_changed', data: { parent_id: PARENT.id } }))
}

const FORMS = [
  // 12 children: more than ROLLUP_SEGMENT_MAX, so the proportional meter is drawn.
  { name: 'meter (12 children)', attr: 'data-segment-group', before: { total: 12, done: 4, doing: 3, todo: 3, blocked: 2 }, after: { total: 12, done: 5, doing: 4, todo: 1, blocked: 2 } },
  { name: 'segment bar (6 children)', attr: 'data-segment', before: { total: 6, done: 2, doing: 1, todo: 2, blocked: 1 }, after: { total: 6, done: 3, doing: 2, todo: 0, blocked: 1 } },
] as const

for (const theme of ['light', 'dark'] as const) {
  for (const form of FORMS) {
    test(`the live-change ring holds 3:1 against the card on Doing and Done, ${form.name} (${theme})`, async ({ page }) => {
      await openLive(page, theme, form.before, form.after)
      const f = footer(page)
      await expect(f.getByTestId(form.attr === 'data-segment-group' ? 'rollup-meter' : 'rollup-segments')).toBeVisible()
      const doing = f.locator(`[${form.attr}="doing"][data-ringed="true"]`).last()
      const done = f.locator(`[${form.attr}="done"][data-ringed="true"]`).last()
      await expect(doing).toBeVisible()
      await expect(done).toBeVisible()
      const card = await effectiveBackground(f)
      const m = { doing: await ringMeasure(doing), done: await ringMeasure(done) }
      const clipped = { doing: await ringUnclipped(doing), done: await ringUnclipped(done) }
      const ratios = {
        doing: contrastRatio(m.doing.ring, m.doing.adjacent), done: contrastRatio(m.done.ring, m.done.adjacent),
        doingVsCard: contrastRatio(m.doing.ring, card), doneVsCard: contrastRatio(m.done.ring, card),
      }
      // eslint-disable-next-line no-console
      console.log(`RING ${theme} ${form.name} ${JSON.stringify({ ...ratios, card, m })}`)
      for (const s of ['doing', 'done'] as const) {
        expect(ratios[s], `${s} ring vs what it is drawn next to`).toBeGreaterThanOrEqual(3)
        expect(ratios[`${s}VsCard`], `${s} ring vs card`).toBeGreaterThanOrEqual(3)
        expect(m[s].offset, `${s} ring offset is the card surface`).not.toBeNull()
        expect(contrastRatio(m[s].offset!, card), `${s} offset matches the card`).toBeLessThan(1.05)
        expect(clipped[s], `${s} ring clipped by`).toBeNull()
      }
    })
  }
}
