import { describe, it, expect } from 'vitest'
import { deriveExternalRef, isHttpUrl, validateRef } from '../utils/externalRef'

describe('isHttpUrl (#352)', () => {
  it.each([
    'https://github.com/o/r/pull/1',
    'http://gitlab.internal:8080/team/app/-/merge_requests/7',
    'HTTPS://GitHub.com/o/r/pull/1',
  ])('accepts %s', (url) => {
    expect(isHttpUrl(url)).toBe(true)
  })

  it.each([
    'javascript:alert(1)',
    'JaVaScRiPt:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'vbscript:msgbox(1)',
    'ftp://example.com/x',
    '//evil.example.com/x',
    '/relative',
    'github.com/o/r/pull/1',
    'https://user:pw@github.com/o/r/pull/1',
    '',
  ])('rejects %s', (url) => {
    expect(isHttpUrl(url)).toBe(false)
  })

  it('rejects null/undefined', () => {
    expect(isHttpUrl(null)).toBe(false)
    expect(isHttpUrl(undefined)).toBe(false)
  })

  it('rejects URLs over 2048 characters', () => {
    expect(isHttpUrl('https://github.com/' + 'a'.repeat(2048))).toBe(false)
  })
})

describe('validateRef (#352)', () => {
  it('requires a value', () => {
    expect(validateRef('   ')).toBe('Reference is required.')
  })
  it('rejects inner whitespace', () => {
    expect(validateRef('o/r #1')).toBe("Reference can't contain spaces.")
  })
  it('accepts a trimmed ref', () => {
    expect(validateRef('  o/r#1  ')).toBeNull()
  })
  it('rejects over-length refs', () => {
    expect(validateRef('a'.repeat(256))).not.toBeNull()
  })
})

describe('deriveExternalRef (#352)', () => {
  it('derives a GitHub PR', () => {
    expect(deriveExternalRef('https://github.com/acme/web/pull/12')).toEqual({ provider: 'github', ref: 'acme/web#12' })
  })
  it('ignores trailing segments, query and hash', () => {
    expect(deriveExternalRef('https://github.com/acme/web/pull/12/files?diff=split#r1')).toEqual({ provider: 'github', ref: 'acme/web#12' })
  })
  it('derives a GitLab MR and keeps subgroups', () => {
    expect(deriveExternalRef('https://gitlab.com/group/sub/proj/-/merge_requests/45/diffs')).toEqual({ provider: 'gitlab', ref: 'group/sub/proj!45' })
  })
  it('derives a self-hosted GitLab MR', () => {
    expect(deriveExternalRef('https://git.example.com/team/app/-/merge_requests/7')).toEqual({ provider: 'gitlab', ref: 'team/app!7' })
  })
  it('returns null for a GitHub non-PR URL', () => {
    expect(deriveExternalRef('https://github.com/acme/web/issues/12')).toBeNull()
  })
  it('returns null for an unknown host', () => {
    expect(deriveExternalRef('https://tracker.example.com/PROJ-42')).toBeNull()
  })
  it('returns null for a non-http URL', () => {
    expect(deriveExternalRef('javascript:alert(1)')).toBeNull()
  })
})
