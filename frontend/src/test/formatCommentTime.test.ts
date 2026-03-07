import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { formatCommentTime } from '../components/Card/CardDetail'

describe('formatCommentTime', () => {
  const FIXED_NOW = new Date('2026-03-07T12:00:00Z').getTime()

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(FIXED_NOW)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('returns "just now" for a timestamp less than 1 minute ago', () => {
    const iso = new Date(FIXED_NOW - 30_000).toISOString()
    expect(formatCommentTime(iso)).toBe('just now')
  })

  it('returns minutes ago for timestamps under 1 hour', () => {
    const iso = new Date(FIXED_NOW - 5 * 60_000).toISOString()
    expect(formatCommentTime(iso)).toBe('5m ago')
  })

  it('returns hours ago for timestamps under 24 hours', () => {
    const iso = new Date(FIXED_NOW - 3 * 3600_000).toISOString()
    expect(formatCommentTime(iso)).toBe('3h ago')
  })

  it('returns absolute date for timestamps older than 24 hours', () => {
    const iso = new Date(FIXED_NOW - 25 * 3600_000).toISOString()
    const result = formatCommentTime(iso)
    // Should not contain "ago" — should be a formatted date string
    expect(result).not.toMatch(/ago/)
    expect(result.length).toBeGreaterThan(5)
  })

  it('returns "just now" for exactly 0 minutes ago', () => {
    const iso = new Date(FIXED_NOW).toISOString()
    expect(formatCommentTime(iso)).toBe('just now')
  })

  it('returns "1m ago" for exactly 1 minute ago', () => {
    const iso = new Date(FIXED_NOW - 60_000).toISOString()
    expect(formatCommentTime(iso)).toBe('1m ago')
  })

  it('returns "1h ago" for exactly 60 minutes ago', () => {
    const iso = new Date(FIXED_NOW - 60 * 60_000).toISOString()
    expect(formatCommentTime(iso)).toBe('1h ago')
  })
})
