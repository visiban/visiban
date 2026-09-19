import { describe, it, expect } from 'vitest'
import {
  MAX_LENS_LABELS,
  lensFilterActiveCount,
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
