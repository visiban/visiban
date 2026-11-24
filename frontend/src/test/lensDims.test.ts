import { describe, it, expect } from 'vitest'
import {
  MAX_LENS_LABELS,
  lensFilterActiveCount,
  parseLensClosedLimit,
  DEFAULT_LENS_CLOSED_LIMIT,
  parseLensLabels,
  serializeLensLabels,
} from '../components/Board/Lens/lensDims'

describe('parseLensLabels', () => {
  it('returns an empty list for absent or blank input', () => {
    expect(parseLensLabels(null)).toEqual([])
    expect(parseLensLabels('')).toEqual([])
    expect(parseLensLabels(',, ,')).toEqual([])
  })

  it('trims, dedupes, and sorts', () => {
    // Sorting is not cosmetic: the server hashes the sorted list into the board
    // cache key, so ?labels=b,a and ?labels=a,b must be one entry and one fetch.
    expect(parseLensLabels(' bug , backend,bug')).toEqual(['backend', 'bug'])
    expect(parseLensLabels('b,a')).toEqual(parseLensLabels('a,b'))
  })

  it('dedupes before capping, so a repeated label is not a wasted slot', () => {
    expect(parseLensLabels('z,z,z,z,z,y')).toEqual(['y', 'z'])
  })

  it('caps the label count to match the server', () => {
    expect(parseLensLabels('a,b,c,d,e,f,g')).toHaveLength(MAX_LENS_LABELS)
  })

  it('sorts with localeCompare, not a bare .sort()\'s UTF-16 code-unit order (#1372)', () => {
    // A bare `.sort()` would put every uppercase letter before every lowercase one
    // ("Bug" before "ant"). The server independently re-sorts `labels` for its own
    // cache key (_board_cache_key derives it from _parse_filters, not from the raw
    // query string), so this comparator only needs to be deterministic here — but
    // it should read naturally to a person looking at the canonical `?labels=` value.
    expect(parseLensLabels('Bug,ant,café')).toEqual(['ant', 'Bug', 'café'])
  })
})

describe('serializeLensLabels', () => {
  it('round-trips through the canonical form regardless of input order', () => {
    expect(serializeLensLabels(['bug', 'backend'])).toBe('backend,bug')
    expect(serializeLensLabels(['backend', 'bug'])).toBe('backend,bug')
    expect(serializeLensLabels([])).toBe('')
  })
})

describe('lensFilterActiveCount', () => {
  const count = (qs: string) => lensFilterActiveCount(new URLSearchParams(qs))

  it('is zero with no filters', () => {
    expect(count('')).toBe(0)
    expect(count('column_dim=pipeline&swimlane_dim=label')).toBe(0)
  })

  it('counts one per active dimension, not one per selected label', () => {
    expect(count('labels=a,b,c')).toBe(1)
    expect(count('state=open&milestone=1.2&labels=a,b&assignee=alice&q=x')).toBe(5)
  })

  it('ignores blank and unrecognized values', () => {
    expect(count('state=bogus&milestone=&labels=&assignee=%20&q=%20')).toBe(0)
  })
})

describe('parseLensClosedLimit (#1581)', () => {
  it('accepts every choice and falls back to the server default otherwise', () => {
    for (const v of ['0', '20', '50', '100', 'all']) expect(parseLensClosedLimit(v)).toBe(v)
    for (const v of [null, '', '7', '-1', 'ALL', ' 20']) expect(parseLensClosedLimit(v)).toBe(DEFAULT_LENS_CLOSED_LIMIT)
    expect(DEFAULT_LENS_CLOSED_LIMIT).toBe('50')
  })

  it('counts a non-default closed limit as a filter, only with no state filter', () => {
    const count = (qs: string) => lensFilterActiveCount(new URLSearchParams(qs))
    expect(count('closed_limit=0')).toBe(1)
    expect(count('closed_limit=all')).toBe(1)
    expect(count('closed_limit=50')).toBe(0)
    expect(count('closed_limit=bogus')).toBe(0)
    // A state filter makes the limit moot, so it is not counted twice.
    expect(count('state=open&closed_limit=0')).toBe(1)
  })
})
