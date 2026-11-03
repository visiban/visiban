import { describe, expect, it } from 'vitest'
import {
  EMPTY_TOAST_STATE,
  TOAST_CAP,
  addToast,
  isAssertive,
  orderForDisplay,
  releaseGuard,
  removeToast,
  toastAnnouncement,
  toastDuration,
  toastRank,
} from '../utils/toastQueue'
import type { ToastInput, ToastRecord, ToastState } from '../utils/toastQueue'

let seq = 0
const rec = (input: Partial<ToastInput> & Pick<ToastInput, 'variant'>, extra: Partial<ToastRecord> = {}): ToastRecord => {
  seq += 1
  return { title: `t${seq}`, id: seq, seq, rev: 0, guarded: Boolean(input.action?.undo), ...input, ...extra }
}
const undo = { label: 'Undo', onAction: () => {}, undo: true }
const act = { label: 'Retry', onAction: () => {} }

const fill = (...toasts: ToastRecord[]): ToastState =>
  toasts.reduce<ToastState>((s, t) => addToast(s, t).state, EMPTY_TOAST_STATE)

describe('toast priority, timing and politeness (#2060)', () => {
  it('ranks danger = blocked > warning+action > warning > info+action > info > success', () => {
    const order = [
      toastRank({ variant: 'danger', title: '' }),
      toastRank({ variant: 'blocked', title: '' }),
      toastRank({ variant: 'warning', title: '', action: act }),
      toastRank({ variant: 'warning', title: '' }),
      toastRank({ variant: 'info', title: '', action: act }),
      toastRank({ variant: 'info', title: '' }),
      toastRank({ variant: 'success', title: '' }),
    ]
    expect(order[0]).toBe(order[1])
    for (let i = 1; i < order.length - 1; i++) expect(order[i]).toBeGreaterThan(order[i + 1])
  })

  it('times success 4 s, info 6 s, warning 8 s, Undo 12 s; blocked and danger persist', () => {
    expect(toastDuration({ variant: 'success', title: '' })).toBe(4000)
    expect(toastDuration({ variant: 'info', title: '' })).toBe(6000)
    expect(toastDuration({ variant: 'warning', title: '' })).toBe(8000)
    expect(toastDuration({ variant: 'warning', title: '', action: undo })).toBe(12000)
    expect(toastDuration({ variant: 'info', title: '', action: undo })).toBe(12000)
    expect(toastDuration({ variant: 'blocked', title: '' })).toBeNull()
    expect(toastDuration({ variant: 'danger', title: '' })).toBeNull()
    // An explicit duration wins, including null to persist.
    expect(toastDuration({ variant: 'info', title: '', durationMs: 8000 })).toBe(8000)
    expect(toastDuration({ variant: 'info', title: '', durationMs: null })).toBeNull()
  })

  it('is assertive only for blocked and danger', () => {
    expect(isAssertive({ variant: 'blocked', title: '' })).toBe(true)
    expect(isAssertive({ variant: 'danger', title: '' })).toBe(true)
    for (const v of ['success', 'info', 'warning'] as const) expect(isAssertive({ variant: v, title: '' })).toBe(false)
  })

  it('announces the title, the message and an action count, with an override', () => {
    expect(toastAnnouncement({ variant: 'warning', title: 'Over swimlane limit', message: 'Checkout now has 5 of 4', action: undo }))
      .toBe('Over swimlane limit. Checkout now has 5 of 4. Undo available.')
    expect(toastAnnouncement({ variant: 'success', title: 'Move undone.' })).toBe('Move undone.')
    expect(toastAnnouncement({ variant: 'info', title: 'x', announceText: 'Board imported. 2 import warnings.' }))
      .toBe('Board imported. 2 import warnings.')
  })
})

describe('toast stacking (#2060, #1438)', () => {
  it('shows at most three and evicts the lowest-priority, oldest unprotected toast', () => {
    const a = rec({ variant: 'success' })
    const b = rec({ variant: 'info' })
    const c = rec({ variant: 'success' })
    const d = rec({ variant: 'warning' })
    const s = fill(a, b, c)
    expect(s.visible).toHaveLength(TOAST_CAP)
    const tr = addToast(s, d)
    expect(tr.evicted).toEqual([a])
    expect(tr.entered).toEqual([d])
    expect(tr.state.visible.map((t) => t.id)).toEqual([b.id, c.id, d.id])
  })

  it('never evicts blocked, danger or a guarded Undo toast; the newcomer waits', () => {
    const s = fill(rec({ variant: 'blocked' }), rec({ variant: 'danger' }), rec({ variant: 'warning', action: undo }))
    const late = rec({ variant: 'success' })
    const tr = addToast(s, late)
    expect(tr.evicted).toEqual([])
    expect(tr.entered).toEqual([])
    expect(tr.state.queued).toEqual([late])
  })

  it('a blocked or danger newcomer queues behind three blocked/danger toasts; none is evicted', () => {
    const s0 = fill(rec({ variant: 'blocked' }), rec({ variant: 'danger' }), rec({ variant: 'blocked' }))
    for (const variant of ['blocked', 'danger'] as const) {
      const late = rec({ variant })
      const tr = addToast(s0, late)
      expect(tr.evicted).toEqual([])
      expect(tr.entered).toEqual([])
      expect(tr.state.visible).toEqual(s0.visible)
      expect(tr.state.queued).toEqual([late])
    }
  })

  it('a waiting toast enters when a slot frees, highest priority first', () => {
    const s0 = fill(rec({ variant: 'blocked' }), rec({ variant: 'blocked' }), rec({ variant: 'danger' }))
    const low = rec({ variant: 'success' })
    const high = rec({ variant: 'warning' })
    const s1 = addToast(addToast(s0, low).state, high).state
    expect(s1.queued).toHaveLength(2)
    const tr = removeToast(s1, s0.visible[0].id)
    expect(tr.entered).toEqual([high])
    expect(tr.state.queued).toEqual([low])
  })

  it('an Undo toast becomes evictable once its guard is released', () => {
    const guardedUndo = rec({ variant: 'warning', action: undo })
    const s0 = fill(rec({ variant: 'blocked' }), rec({ variant: 'danger' }), guardedUndo)
    const waiting = rec({ variant: 'warning', action: act })
    const s1 = addToast(s0, waiting).state
    expect(s1.queued).toEqual([waiting])
    const tr = releaseGuard(s1, guardedUndo.id)
    expect(tr.evicted.map((t) => t.id)).toEqual([guardedUndo.id])
    expect(tr.entered).toEqual([waiting])
  })

  it('a newcomer never evicts a toast that outranks it; it waits instead', () => {
    const s = fill(rec({ variant: 'warning' }), rec({ variant: 'warning' }), rec({ variant: 'info' }))
    const low = rec({ variant: 'success' })
    const tr = addToast(s, low)
    expect(tr.evicted).toEqual([])
    expect(tr.state.queued).toEqual([low])
  })

  it('coalesces by key: replaces in place, keeps id and position, bumps rev', () => {
    const first = rec({ variant: 'blocked', key: 'move', title: 'WIP limit reached' })
    const other = rec({ variant: 'success' })
    const s = fill(first, other)
    const again = rec({ variant: 'blocked', key: 'move', title: 'Move failed' })
    const tr = addToast(s, again)
    expect(tr.replaced).toHaveLength(1)
    expect(tr.entered).toEqual([])
    const next = tr.state.visible[0]
    expect(next).toMatchObject({ id: first.id, seq: first.seq, rev: 1, title: 'Move failed' })
    expect(tr.state.visible).toHaveLength(2)
  })

  it('coalesces a waiting toast by key too', () => {
    const s0 = fill(rec({ variant: 'blocked' }), rec({ variant: 'blocked' }), rec({ variant: 'blocked' }))
    const q = rec({ variant: 'info', key: 'import', title: 'one' })
    const s1 = addToast(s0, q).state
    const s2 = addToast(s1, rec({ variant: 'info', key: 'import', title: 'two' })).state
    expect(s2.queued).toHaveLength(1)
    expect(s2.queued[0]).toMatchObject({ id: q.id, title: 'two' })
  })

  it('orders the bottom of the stack first: highest priority, ties newest nearest the bottom', () => {
    const s = fill(rec({ variant: 'success', title: 'ok' }), rec({ variant: 'danger', title: 'fail' }), rec({ variant: 'warning', title: 'warn', action: undo }))
    expect(orderForDisplay(s.visible).map((t) => t.title)).toEqual(['fail', 'warn', 'ok'])
    const ties = fill(rec({ variant: 'info', title: 'old' }), rec({ variant: 'info', title: 'new' }))
    expect(orderForDisplay(ties.visible).map((t) => t.title)).toEqual(['new', 'old'])
  })

  it('removing an unknown id changes nothing', () => {
    const s = fill(rec({ variant: 'info' }))
    expect(removeToast(s, -5).state.visible).toEqual(s.visible)
  })
})
