import { describe, it, expect } from 'vitest'
import { EMAIL_RE } from '../constants/inviteEmail'

describe('EMAIL_RE (invite address shape, #1444)', () => {
  it.each(['a@b.co', 'first.last+tag@sub.example.com', "o'brien@example.org"])('accepts %s', (v) => {
    expect(EMAIL_RE.test(v)).toBe(true)
  })

  it.each([
    '',
    'plain',
    'no-domain@',
    '@no-local.com',
    'no-tld@host',
    'has space@example.com',
    'a@b c.com',
    'a,b@example.com',
    'a;b@example.com',
    '"Name" <a@example.com>',
    'a@@example.com',
  ])('rejects %j', (v) => {
    expect(EMAIL_RE.test(v)).toBe(false)
  })
})
