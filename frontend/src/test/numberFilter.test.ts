import { describe, it, expect } from 'vitest'
import {
  displayedNumberFilterMode,
  finiteBound,
  isNumberRangeInverted,
  numberFilterDisplay,
  numberFilterMode,
  numberInputStep,
  switchNumberFilterMode,
  type NumberFilterMode,
  type NumberFilterValue,
} from '../utils/numberFilter'

// #2357 — the number filter's pure helpers. Matching is covered in
// filterCardsCustomFields.test.ts, load validation in usePersistedFilters.test.ts.
const eq = (equals: string): NumberFilterValue => ({ kind: 'number', equals })
const range = (min: string, max: string): NumberFilterValue => ({ kind: 'number', equals: '', op: 'between', min, max })

describe('numberFilter helpers (#2357)', () => {
  it('derives the displayed mode from the stored entry', () => {
    expect(numberFilterMode(eq('3'))).toBe('eq')
    expect(numberFilterMode({ kind: 'number', equals: '3', op: 'eq' })).toBe('eq')
    expect(numberFilterMode(range('3', '8'))).toBe('between')
    expect(numberFilterMode(range('3', ''))).toBe('gte')
    expect(numberFilterMode(range('', '8'))).toBe('lte')
    expect(numberFilterMode(range('', ''))).toBe('between')
    expect(numberFilterMode({ kind: 'number', equals: '', op: 'empty' })).toBe('empty')
  })

  it('keeps a picked at least / at most while its bound is still blank', () => {
    expect(displayedNumberFilterMode(range('', ''), 'gte')).toBe('gte')
    expect(displayedNumberFilterMode(range('', ''), 'lte')).toBe('lte')
    expect(displayedNumberFilterMode(range('3', ''), 'between')).toBe('between')
    expect(displayedNumberFilterMode(range('3', '8'), 'gte')).toBe('between')
    expect(displayedNumberFilterMode(eq('3'), 'gte')).toBe('eq')
  })

  it('every non-eq switch writes equals: "" so an older SPA reads the entry as inactive', () => {
    const modes: NumberFilterMode[] = ['between', 'gte', 'lte', 'empty', 'not_empty']
    for (const m of modes) {
      const next = switchNumberFilterMode(eq('7'), m)
      expect(next.equals).toBe('')
      expect(next.op).toBe(m === 'gte' || m === 'lte' ? 'between' : m)
      expect(JSON.parse(JSON.stringify(next)).equals).toBe('')
    }
  })

  it('carries typed values across operator switches', () => {
    expect(switchNumberFilterMode(eq('7'), 'between')).toEqual(range('7', ''))
    expect(switchNumberFilterMode(eq('7'), 'gte')).toEqual(range('7', ''))
    expect(switchNumberFilterMode(eq('7'), 'lte')).toEqual(range('', '7'))
    expect(switchNumberFilterMode(range('3', '8'), 'eq')).toEqual(eq('3'))
    expect(switchNumberFilterMode(range('', '8'), 'eq')).toEqual(eq('8'))
    expect(switchNumberFilterMode(range('3', ''), 'lte')).toEqual(range('', '3'))
    expect(switchNumberFilterMode(range('', '8'), 'gte')).toEqual(range('8', ''))
    expect(switchNumberFilterMode(range('3', '8'), 'gte')).toEqual(range('3', ''))
    expect(switchNumberFilterMode(range('3', '8'), 'lte')).toEqual(range('', '8'))
    expect(switchNumberFilterMode(range('3', '8'), 'empty')).toEqual({ kind: 'number', equals: '', op: 'empty' })
    expect(switchNumberFilterMode({ kind: 'number', equals: '', op: 'empty' }, 'eq')).toEqual(eq(''))
    expect(switchNumberFilterMode({ kind: 'number', equals: '', op: 'not_empty' }, 'between')).toEqual(range('', ''))
    expect(switchNumberFilterMode(range('3', '8'), 'between')).toEqual(range('3', '8'))
    // An explicit "from" wins over the derived one: "between" showing only a min, switched to "at most".
    expect(switchNumberFilterMode(range('3', ''), 'lte', 'between')).toEqual(range('', ''))
  })

  it('treats blank and non-finite bounds as absent', () => {
    expect(finiteBound(undefined)).toBeNull()
    expect(finiteBound('  ')).toBeNull()
    expect(finiteBound('abc')).toBeNull()
    expect(finiteBound('Infinity')).toBeNull()
    expect(finiteBound('-2.5')).toBe(-2.5)
  })

  it('flags min > max only when both bounds are finite', () => {
    expect(isNumberRangeInverted(range('8', '3'))).toBe(true)
    expect(isNumberRangeInverted(range('3', '8'))).toBe(false)
    expect(isNumberRangeInverted(range('3', '3'))).toBe(false)
    expect(isNumberRangeInverted(range('8', ''))).toBe(false)
    expect(isNumberRangeInverted(eq('8'))).toBe(false)
  })

  it('formats display text through the field formatter', () => {
    const fmt = (raw: string) => `$${raw}`
    expect(numberFilterDisplay(range('3', '8'), fmt)).toBe('$3–$8')
    expect(numberFilterDisplay(range('abc', '8'), fmt)).toBe('≤ $8')
    expect(numberFilterDisplay(eq('4'), fmt)).toBe('$4')
  })

  it('derives the input step from number_decimals', () => {
    expect(numberInputStep(2)).toBe('0.01')
    expect(numberInputStep(1)).toBe('0.1')
    expect(numberInputStep(0)).toBe('1')
    expect(numberInputStep(null)).toBe('any')
    expect(numberInputStep(undefined)).toBe('any')
  })
})
