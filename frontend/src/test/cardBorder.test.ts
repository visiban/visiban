import { describe, it, expect } from 'vitest'
import { classifyCardBorder } from '../utils/cardUrgency'

const NOW = Date.parse('2026-05-02T12:00:00Z')
const OVERDUE = '2026-05-01T00:00:00Z'
const SOON = '2026-05-03T00:00:00Z'
const FAR = '2026-06-01T00:00:00Z'

const base = { due_date: null as string | null, is_stale: false, last_moved_at: null as string | null, manuallyBlocked: false }
const comfy = { density: 'comfortable' as const }

describe('classifyCardBorder (#977)', () => {
  it('manual blocked beats overdue, due soon and priority', () => {
    expect(classifyCardBorder({ ...base, manuallyBlocked: true, due_date: OVERDUE }, comfy, NOW)).toBe('blocked')
    expect(classifyCardBorder({ ...base, manuallyBlocked: true, due_date: SOON }, comfy, NOW)).toBe('blocked')
    expect(classifyCardBorder({ ...base, manuallyBlocked: true }, comfy, NOW)).toBe('blocked')
  })

  it('overdue beats due soon and priority at comfortable', () => {
    expect(classifyCardBorder({ ...base, due_date: OVERDUE }, comfy, NOW)).toBe('overdue')
  })

  it('due soon beats priority at comfortable', () => {
    expect(classifyCardBorder({ ...base, due_date: SOON }, comfy, NOW)).toBe('due-soon')
  })

  it('stale, recent move and far due date never change the border', () => {
    expect(classifyCardBorder({ ...base, is_stale: true }, comfy, NOW)).toBe('priority')
    expect(classifyCardBorder({ ...base, last_moved_at: '2026-05-02T10:00:00Z' }, comfy, NOW)).toBe('priority')
    expect(classifyCardBorder({ ...base, due_date: FAR }, comfy, NOW)).toBe('priority')
    expect(classifyCardBorder({ ...base, due_date: SOON, is_stale: true }, comfy, NOW)).toBe('due-soon')
  })

  it.each(['standard', 'dense'] as const)('%s density keeps the priority border for dated cards', (density) => {
    expect(classifyCardBorder({ ...base, due_date: OVERDUE }, { density }, NOW)).toBe('priority')
    expect(classifyCardBorder({ ...base, due_date: SOON }, { density }, NOW)).toBe('priority')
  })

  it.each(['comfortable', 'standard', 'dense'] as const)('manual block still wins at %s density', (density) => {
    expect(classifyCardBorder({ ...base, manuallyBlocked: true, due_date: OVERDUE }, { density }, NOW)).toBe('blocked')
  })

  it('compact layout is not tinted by dates', () => {
    expect(classifyCardBorder({ ...base, due_date: OVERDUE }, { ...comfy, compact: true }, NOW)).toBe('priority')
    expect(classifyCardBorder({ ...base, due_date: SOON }, { ...comfy, compact: true }, NOW)).toBe('priority')
  })
})
