import { describe, it, expect } from 'vitest'
import { userDisplayName } from '../types'
import { PRIORITY_COLORS, COLUMN_COLORS, PALETTE_COLORS } from '../constants/colors'

// ---------------------------------------------------------------------------
// userDisplayName (types/index.ts)
// ---------------------------------------------------------------------------

describe('userDisplayName', () => {
  it('returns display_name when set', () => {
    expect(
      userDisplayName({ display_name: 'Alice B.', first_name: 'Alice', username: 'alice' }),
    ).toBe('Alice B.')
  })

  it('falls back to first_name when display_name is empty', () => {
    expect(
      userDisplayName({ display_name: '', first_name: 'Bob', username: 'bob' }),
    ).toBe('Bob')
  })

  it('falls back to username when both display_name and first_name are empty', () => {
    expect(
      userDisplayName({ display_name: '', first_name: '', username: 'charlie' }),
    ).toBe('charlie')
  })
})

// ---------------------------------------------------------------------------
// Color constants (constants/colors.ts)
// ---------------------------------------------------------------------------

describe('PRIORITY_COLORS', () => {
  it('defines colors for all four priority levels', () => {
    expect(Object.keys(PRIORITY_COLORS).sort()).toEqual(['high', 'low', 'medium', 'urgent'])
  })

  it('returns valid hex color strings', () => {
    Object.values(PRIORITY_COLORS).forEach((color) => {
      expect(color).toMatch(/^#[0-9A-Fa-f]{6}$/)
    })
  })
})

describe('COLUMN_COLORS', () => {
  it('contains 6 colors', () => {
    expect(COLUMN_COLORS).toHaveLength(6)
  })

  it('all values are valid hex colors', () => {
    COLUMN_COLORS.forEach((color) => {
      expect(color).toMatch(/^#[0-9A-Fa-f]{6}$/)
    })
  })
})

describe('PALETTE_COLORS', () => {
  it('contains 8 colors', () => {
    expect(PALETTE_COLORS).toHaveLength(8)
  })

  it('is a superset of COLUMN_COLORS', () => {
    COLUMN_COLORS.forEach((color) => {
      expect(PALETTE_COLORS).toContain(color)
    })
  })
})
