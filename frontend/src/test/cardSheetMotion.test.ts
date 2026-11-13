import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  canAnimate, claimDeparture, departSheet, dropDeparture, dropOwnDeparture, makeGhost, playClose, playTransition, prefersReducedMotion,
} from '../components/Card/cardSheetMotion'
import type { SheetPlacement } from '../hooks/useCardSheetPlacement'

// #1914 — card detail sheet transitions. jsdom has no Element.animate, so a
// recording stub stands in for the Web Animations API here.

interface Recorded { el: Element; keyframes: Keyframe[]; options: KeyframeAnimationOptions; anim: { onfinish: (() => void) | null; oncancel: (() => void) | null } }
let calls: Recorded[] = []
let reduced = false

const right: SheetPlacement = { mode: 'anchored', side: 'right', left: 466, top: 104, bottom: 12, notch: { y: 100, clamped: false } }
const left: SheetPlacement = { ...right, side: 'left', left: 200 }
const docked: SheetPlacement = { mode: 'docked', side: null, left: null, top: 0, bottom: 0, notch: null }

function rect(l: number): DOMRect {
  return { x: l, y: 104, left: l, top: 104, width: 540, height: 700, right: l + 540, bottom: 804, toJSON: () => ({}) } as DOMRect
}

function makePanel(l = 466) {
  const panel = document.createElement('div')
  panel.setAttribute('role', 'dialog')
  panel.setAttribute('aria-modal', 'true')
  panel.setAttribute('aria-labelledby', 'card-detail-title')
  panel.tabIndex = -1
  panel.innerHTML = '<input id="card-detail-title" name="t" autofocus value="Card"><button data-testid="x">Close</button><a href="/x">link</a>'
  panel.getBoundingClientRect = () => rect(l)
  document.body.appendChild(panel)
  return panel
}

const ghosts = () => document.querySelectorAll('[data-card-sheet-ghost]')

beforeEach(() => {
  calls = []
  reduced = false
  ;(HTMLElement.prototype as unknown as { animate: unknown }).animate = function (this: Element, keyframes: Keyframe[], options: KeyframeAnimationOptions) {
    const anim = { onfinish: null, oncancel: null }
    calls.push({ el: this, keyframes, options, anim })
    return anim
  }
  vi.stubGlobal('matchMedia', (q: string) => ({ matches: reduced && q.includes('reduce'), media: q }))
})

afterEach(() => {
  delete (HTMLElement.prototype as unknown as { animate?: unknown }).animate
  dropDeparture()
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
})

describe('cardSheetMotion (#1914)', () => {
  it('detects the Web Animations API and the reduced-motion preference', () => {
    expect(canAnimate(document.createElement('div'))).toBe(true)
    expect(canAnimate(null)).toBe(false)
    expect(prefersReducedMotion()).toBe(false)
    reduced = true
    expect(prefersReducedMotion()).toBe(true)
  })

  it('makes an inert, aria-hidden ghost with no ids, roles, tab stops or form names', () => {
    const panel = makePanel()
    const ghost = makeGhost(panel)!
    expect(ghost.parentElement).toBe(document.body)
    expect(ghost).toHaveAttribute('aria-hidden', 'true')
    expect(ghost).toHaveAttribute('inert')
    expect(ghost.style.pointerEvents).toBe('none')
    expect(ghost.style.position).toBe('fixed')
    expect(ghost.style.left).toBe('466px')
    expect(ghost.getAttribute('role')).toBeNull()
    expect(ghost.getAttribute('aria-modal')).toBeNull()
    expect(ghost.querySelector('[id], [name], [autofocus], [tabindex], [data-testid], [href]')).toBeNull()
    // Only one element carries the title id: the real one.
    expect(document.querySelectorAll('#card-detail-title')).toHaveLength(1)
  })

  it('makes no ghost when nothing can animate', () => {
    const panel = makePanel()
    delete (HTMLElement.prototype as unknown as { animate?: unknown }).animate
    expect(makeGhost(panel)).toBeNull()
    expect(ghosts()).toHaveLength(0)
  })

  it('opens with 180ms ease-out and a 12px move toward the card', () => {
    const panel = makePanel()
    playTransition('open', panel, { placement: right })
    expect(calls[0].options).toMatchObject({ duration: 180, easing: 'ease-out' })
    expect(calls[0].keyframes[0]).toMatchObject({ opacity: 0, transform: 'translateX(12px)' })
    calls = []
    playTransition('open', panel, { placement: left })
    expect(calls[0].keyframes[0]).toMatchObject({ transform: 'translateX(-12px)' })
  })

  it('opens with a 120ms fade only under reduced motion', () => {
    reduced = true
    const panel = makePanel()
    playTransition('open', panel, { placement: right })
    expect(calls[0].options).toMatchObject({ duration: 120 })
    expect(calls[0].keyframes.some((k) => 'transform' in k)).toBe(false)
  })

  it('slides 220ms on the same side, cross-fading the old content out over 80ms and the new in over 120ms', () => {
    const old = makePanel(466)
    const ghost = makeGhost(old)!
    const panel = makePanel(700)
    playTransition('slide', panel, { placement: right, from: rect(466), ghost })
    const sheet = calls.find((c) => c.el === panel)!
    expect(sheet.options).toMatchObject({ duration: 220, easing: 'cubic-bezier(.2,.8,.2,1)' })
    expect(sheet.keyframes[0]).toMatchObject({ transform: 'translateX(-234px)' })
    const out = calls.find((c) => c.el === ghost)!
    expect(out.keyframes[1]).toMatchObject({ opacity: 0, offset: 80 / 220 })
    const fadeIns = calls.filter((c) => c.el.parentElement === panel)
    expect(fadeIns.length).toBe(panel.children.length)
    expect(fadeIns[0].options).toMatchObject({ duration: 120, delay: 80 })
    out.anim.onfinish?.()
    expect(ghost.isConnected).toBe(false)
  })

  it('fades out 90ms, repositions and fades in 140ms on a side flip, cloning a ghost when none was handed over', () => {
    const panel = makePanel(200)
    playTransition('fade', panel, { placement: left, from: rect(466) })
    const ghost = ghosts()[0] as HTMLElement
    expect(ghost.style.left).toBe('466px')
    const out = calls.find((c) => c.el === ghost)!
    expect(out.options).toMatchObject({ duration: 90 })
    const inn = calls.find((c) => c.el === panel)!
    expect(inn.options).toMatchObject({ duration: 140, delay: 90, fill: 'backwards' })
    out.anim.oncancel?.()
    expect(ghosts()).toHaveLength(0)
  })

  it('turns every swap into a 120ms fade out then a 120ms fade in under reduced motion', () => {
    reduced = true
    const panel = makePanel(700)
    playTransition('slide', panel, { placement: right, from: rect(466) })
    const ghost = ghosts()[0]
    expect(calls.find((c) => c.el === ghost)!.options).toMatchObject({ duration: 120 })
    expect(calls.find((c) => c.el === panel)!.options).toMatchObject({ duration: 120, delay: 120 })
    expect(calls.some((c) => c.keyframes.some((k) => 'transform' in k))).toBe(false)
  })

  it('plays nothing for "none" and drops a handed-over ghost', () => {
    const panel = makePanel()
    const ghost = makeGhost(panel)!
    playTransition('none', panel, { placement: right, ghost })
    expect(calls).toHaveLength(0)
    expect(ghost.isConnected).toBe(false)
  })

  it('closes with 140ms ease-in and an 8px move away from the card; reduced motion fades 120ms', () => {
    const ghost = makeGhost(makePanel())!
    playClose(ghost, left)
    expect(calls[0].options).toMatchObject({ duration: 140, easing: 'ease-in' })
    expect(calls[0].keyframes[1]).toMatchObject({ opacity: 0, transform: 'translateX(-8px)' })
    calls[0].anim.onfinish?.()
    expect(ghost.isConnected).toBe(false)

    reduced = true
    calls = []
    const g2 = makeGhost(makePanel())!
    playClose(g2, docked)
    expect(calls[0].options).toMatchObject({ duration: 120 })
  })

  describe('swap hand-off', () => {
    it('a departed sheet is claimed by the next card, which gets its ghost and placement', () => {
      departSheet(1, right, makePanel())
      const d = claimDeparture(2)!
      expect(d.placement).toBe(right)
      expect(d.ghost.isConnected).toBe(true)
      expect(d.rect.left).toBe(466)
      // Claimed once only.
      expect(claimDeparture(3)).toBeNull()
    })

    it('an unclaimed departure plays the close on the next frame', async () => {
      departSheet(1, right, makePanel())
      await new Promise((r) => requestAnimationFrame(() => r(null)))
      expect(calls.some((c) => c.options.duration === 140)).toBe(true)
    })

    it("the same card's departure is StrictMode's simulated unmount: dropped silently, never a swap", () => {
      departSheet(1, right, makePanel())
      expect(claimDeparture(1)).toBeNull()
      expect(ghosts()).toHaveLength(0)

      departSheet(1, right, makePanel())
      dropOwnDeparture(2)
      expect(ghosts()).toHaveLength(1)
      dropOwnDeparture(1)
      expect(ghosts()).toHaveLength(0)
    })

    it('leaves nothing behind when the panel cannot animate', () => {
      const panel = makePanel()
      delete (HTMLElement.prototype as unknown as { animate?: unknown }).animate
      departSheet(1, right, panel)
      expect(claimDeparture(2)).toBeNull()
    })
  })
})
