import { describe, it, expect } from 'vitest'
import { safeJoinToken, safeShareToken } from '../api/joinToken'

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

describe('safeShareToken', () => {
  it('returns a UUID unchanged', () => {
    const u = '3f2504e0-4f89-41d3-9a0c-0305e82c3301'
    expect(safeShareToken(u)).toBe(u)
  })

  it.each(['', '..', 'a/b', 'a%2F', 'tok-abc', '3f2504e04f8941d39a0c0305e82c3301', '../3f2504e0-4f89-41d3-9a0c-0305e82c3301'])(
    'rejects %j',
    (t) => {
      expect(() => safeShareToken(t)).toThrow('Invalid share token')
    },
  )
})
