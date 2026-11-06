import { describe, it, expect } from 'vitest'
import { safeJoinToken } from '../api/joinToken'

describe('safeJoinToken', () => {
  it.each([
    'vbnb_' + 'a1b2c3d4e5'.repeat(4),
    'vbng_' + 'f'.repeat(40),
    'abc123',
    'url-safe_Token-9',
  ])('returns %s unchanged', (t) => {
    expect(safeJoinToken(t)).toBe(t)
  })

  it.each(['', '..', '.', 'a/b', 'a%2F', 'a?b', 'a#b', 'a b', '../x?y=1', 'a'.repeat(257)])(
    'rejects %j',
    (t) => {
      expect(() => safeJoinToken(t)).toThrow('Invalid join token')
    },
  )
})
