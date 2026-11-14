import { describe, it, expect } from 'vitest'
import { wildcardMatch } from '../utils/textMatch'

describe('wildcardMatch (#2227)', () => {
  it('matches the whole value, case-insensitively and trimmed', () => {
    expect(wildcardMatch('ethan ross', ' ETHAN ross ')).toBe(true)
    expect(wildcardMatch('ethan', 'Ethan Ross')).toBe(false)
    expect(wildcardMatch(' Ethan* ', 'ethan ross')).toBe(true)
  })

  it('* matches any run including none; only * matches anything', () => {
    expect(wildcardMatch('*', 'anything')).toBe(true)
    expect(wildcardMatch('***', 'x')).toBe(true)
    expect(wildcardMatch('ab*cd', 'abcd')).toBe(true)
    expect(wildcardMatch('ab*cd', 'ab--cd')).toBe(true)
    expect(wildcardMatch('ab*cd', 'ab--c')).toBe(false)
  })

  it('? matches exactly one character', () => {
    expect(wildcardMatch('j?n', 'jan')).toBe(true)
    expect(wildcardMatch('j?n', 'jn')).toBe(false)
    expect(wildcardMatch('j?n', 'jean')).toBe(false)
    expect(wildcardMatch('?', '')).toBe(false)
  })

  it('empty pattern and empty value', () => {
    expect(wildcardMatch('', '')).toBe(true)
    expect(wildcardMatch('', 'a')).toBe(false)
    expect(wildcardMatch('*', '')).toBe(true)
  })

  it('every other character is literal (this is not a regex)', () => {
    expect(wildcardMatch('a.c', 'abc')).toBe(false)
    expect(wildcardMatch('a.c', 'a.c')).toBe(true)
    expect(wildcardMatch('(x)+[y]', '(x)+[y]')).toBe(true)
    expect(wildcardMatch('a|b', 'a')).toBe(false)
    expect(wildcardMatch('^a$', 'a')).toBe(false)
  })

  it('stays fast on an adversarial value', () => {
    const start = Date.now()
    expect(wildcardMatch('a*a*a*b', 'a'.repeat(100000))).toBe(false)
    expect(wildcardMatch('*a*a*a*a*a*a*a*a*b', 'a'.repeat(100000) + 'b')).toBe(true)
    expect(Date.now() - start).toBeLessThan(2000)
  })
})
