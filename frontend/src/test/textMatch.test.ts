import { describe, it, expect } from 'vitest'
import { compileTextMatcher, isInvalidTextPattern, unsafeRegexReason } from '../utils/textMatch'

function t(operand: string, value: string): boolean {
  const m = compileTextMatcher(operand)
  if (m.kind !== 'ok') throw new Error(`operand ${operand} is ${m.kind}`)
  return m.test(value)
}

describe('compileTextMatcher (#2227)', () => {
  it('treats blank operands as empty', () => {
    expect(compileTextMatcher('').kind).toBe('empty')
    expect(compileTextMatcher('   ').kind).toBe('empty')
    expect(compileTextMatcher(undefined).kind).toBe('empty')
  })

  it('plain text is a trimmed case-insensitive substring', () => {
    expect(t(' ROSS ', 'Ethan ross')).toBe(true)
    expect(t('ross', 'Rossi')).toBe(true)
    expect(t('ross', 'Ethan R.')).toBe(false)
    // Regex metacharacters are literal without * or ?.
    expect(t('a.c', 'abc')).toBe(false)
    expect(t('a.c', 'xa.cx')).toBe(true)
  })

  it('* matches any run and is not anchored', () => {
    expect(t('e*ross', 'Ethan Ross')).toBe(true)
    expect(t('e*ross', 'Ross Ethan')).toBe(false)
    expect(t('ross*', 'xx ross')).toBe(true)
    expect(t('a***b', 'a--b')).toBe(true)
  })

  it('? matches exactly one character', () => {
    expect(t('j?n', 'Jan')).toBe(true)
    expect(t('j?n', 'Jon')).toBe(true)
    expect(t('j?n', 'Jean')).toBe(false)
    expect(t('j?n', 'jn')).toBe(false)
  })

  it('escapes other regex metacharacters in wildcard mode', () => {
    expect(t('a.c*', 'a.c-d')).toBe(true)
    expect(t('a.c*', 'abc')).toBe(false)
    expect(t('1+1*', '1+1=2')).toBe(true)
    expect(t('1+1*', '11')).toBe(false)
    expect(t('(x)*', 'a (x) b')).toBe(true)
    expect(t('[a]?', 'q[a]z')).toBe(true)
    expect(t('[a]?', 'qaz')).toBe(false)
    expect(t('a|b*', 'a|bc')).toBe(true)
    expect(t('a|b*', 'a')).toBe(false)
    expect(t('$?^', '$x^')).toBe(true)
    expect(t('a\\*', 'a\\b')).toBe(true)
  })

  it('/regex/ uses flag i and anchors only when asked', () => {
    expect(t('/^ethan/', 'Ethan Ross')).toBe(true)
    expect(t('/^ethan/', 'Seth Ethan')).toBe(false)
    expect(t('/ross$|lee$/', 'Ethan Ross')).toBe(true)
    expect(t('/ross$|lee$/', 'Amy Lee')).toBe(true)
    expect(t('/ross$|lee$/', 'Rossi')).toBe(false)
    expect(t('/\\*/', 'a*b')).toBe(true)
    expect(t('/\\*/', 'ab')).toBe(false)
    // Whitespace around the stored value does not defeat an anchor.
    expect(t('/^ethan$/', '  Ethan  ')).toBe(true)
  })

  it('a lone or empty slash pair is plain text, not a regex', () => {
    expect(t('/', 'a/b')).toBe(true)
    expect(t('//', 'a//b')).toBe(true)
  })

  it('invalid regexes compile to invalid and never throw', () => {
    expect(compileTextMatcher('/[/').kind).toBe('invalid')
    expect(compileTextMatcher('/(/').kind).toBe('invalid')
    expect(isInvalidTextPattern('/[/')).toBe(true)
    expect(isInvalidTextPattern('ross')).toBe(false)
  })

  it('rejects nested quantifiers and backreferences instead of running them', () => {
    for (const p of ['/(a+)+$/', '/(a*)*/', '/(a|aa)+/', '/(a+){2,}/', '/((a+))+/', '/(x+x+)+y/', '/(a)\\1/', '/(?<n>a)\\k<n>/']) {
      expect(compileTextMatcher(p).kind, p).toBe('invalid')
    }
    // The classic catastrophic input would hang if it ran; it is rejected up front.
    const start = Date.now()
    expect(compileTextMatcher('/^(a+)+$/').kind).toBe('invalid')
    expect(Date.now() - start).toBeLessThan(100)
  })

  it('allows safe groups and escaped or class-bound quantifier characters', () => {
    for (const p of ['/(ab)+/', '/(a|b)/', '/(a+)?/', '/(a+)/', '/[(+]+/', '/\\(a+\\)+/', '/(a){3}/']) {
      expect(compileTextMatcher(p).kind, p).toBe('ok')
    }
    expect(unsafeRegexReason('a+b*')).toBeNull()
  })

  it('memoizes a compiled operand', () => {
    expect(compileTextMatcher('e*x')).toBe(compileTextMatcher('e*x'))
  })
})
