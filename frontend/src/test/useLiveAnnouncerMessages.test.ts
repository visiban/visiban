import { describe, it, expect } from 'vitest'
import { boardStateMessage, columnStateMessage, laneStateMessage } from '../hooks/useLiveAnnouncer'

describe('laneStateMessage', () => {
  it('pins plural, singular, zero and unknown counts', () => {
    expect(laneStateMessage(true, 3)).toBe('Collapsed all 3 lanes')
    expect(laneStateMessage(false, 1)).toBe('Expanded all 1 lane')
    expect(laneStateMessage(true, 0)).toBe('Collapsed all 0 lanes')
    expect(laneStateMessage(false)).toBe('Expanded all lanes')
  })
})

describe('columnStateMessage', () => {
  it('pins plural, singular, zero and unknown counts', () => {
    expect(columnStateMessage(true, 4)).toBe('Hid all 4 columns')
    expect(columnStateMessage(false, 1)).toBe('Showed all 1 column')
    expect(columnStateMessage(true, 0)).toBe('Hid all 0 columns')
    expect(columnStateMessage(false)).toBe('Showed all columns')
  })
})

describe('boardStateMessage', () => {
  it('names lanes and columns in one sentence, pinning the full strings', () => {
    expect(boardStateMessage(true, 3, 2)).toBe('Collapsed all 3 lanes and 2 columns')
    expect(boardStateMessage(false, 2, 5)).toBe('Expanded all 2 lanes and 5 columns')
  })
  it('handles singular counts', () => {
    expect(boardStateMessage(false, 1, 1)).toBe('Expanded all 1 lane and 1 column')
    expect(boardStateMessage(true, 1, 3)).toBe('Collapsed all 1 lane and 3 columns')
  })
  it('handles zero counts', () => {
    expect(boardStateMessage(true, 0, 0)).toBe('Collapsed all 0 lanes and 0 columns')
    expect(boardStateMessage(false, 0, 2)).toBe('Expanded all 0 lanes and 2 columns')
  })
})
