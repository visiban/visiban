import { describe, it, expect } from 'vitest'
import { wildcardMatch } from '../utils/textMatch'

describe('wildcardMatch (#2227)', () => {
  it('matches any part of the value, case-insensitively and trimmed', () => {
    expect(wildcardMatch('ethan ross', ' ETHAN ross ')).toBe(true)
    expect(wildcardMatch('ethan', 'Ethan Ross')).toBe(true)
    expect(wildcardMatch('ethan', 'Seth Ethan')).toBe(true)
    expect(wildcardMatch('Ethan*', 'Seth Ethan')).toBe(true)
    expect(wildcardMatch(' Ethan* ', 'ethan ross')).toBe(true)
    expect(wildcardMatch('ethan', 'Eth')).toBe(false)
    expect(wildcardMatch('e*ross', 'Ross Ethan')).toBe(false)
    expect(wildcardMatch('e*ross', 'Eve Gross')).toBe(true)
  })

  it('* matches any run including none', () => {
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
    expect(wildcardMatch('j?n', 'jan smith')).toBe(true)
    expect(wildcardMatch('?', '')).toBe(false)
  })

  it('empty pattern and empty value', () => {
    expect(wildcardMatch('', '')).toBe(true)
    expect(wildcardMatch('', 'a')).toBe(true)
    expect(wildcardMatch('*', '')).toBe(true)
  })

  it('every other character is literal (this is not a regex)', () => {
    expect(wildcardMatch('a.c', 'abc')).toBe(false)
    expect(wildcardMatch('a.c', 'xa.cx')).toBe(true)
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

  it('counts ? as one character (code point), not one UTF-16 unit', () => {
    expect(wildcardMatch('j?n', 'j\u{1F600}n')).toBe(true)
    expect(wildcardMatch('j??n', 'j\u{1F600}n')).toBe(false)
    expect(wildcardMatch('j?n', 'xj\u{1F600}nx')).toBe(true)
    expect(wildcardMatch('?', '\u{1F600}')).toBe(true)
    expect(wildcardMatch('j*n', 'j\u{1F600}\u{1F600}n')).toBe(true)
    expect(wildcardMatch('j??n', 'j\u{1F600}\u{1F600}n')).toBe(true)
  })
})
