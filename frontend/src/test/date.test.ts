import { describe, it, expect, vi, afterEach } from "vitest";
import { formatRelativeTime } from "../utils/date";

describe("formatRelativeTime", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function makeIso(msAgo: number): string {
    return new Date(Date.now() - msAgo).toISOString();
  }

  it('returns "just now" for less than 1 minute ago', () => {
    expect(formatRelativeTime(makeIso(30_000))).toBe("just now");
  });

  it('returns "Xm ago" for minutes', () => {
    expect(formatRelativeTime(makeIso(5 * 60_000))).toBe("5m ago");
  });

  it('returns "Xh ago" for hours', () => {
    expect(formatRelativeTime(makeIso(3 * 3_600_000))).toBe("3h ago");
  });

  it('returns "Xd ago" for days (less than 7)', () => {
    expect(formatRelativeTime(makeIso(3 * 86_400_000))).toBe("3d ago");
  });

  it('returns "Mon DD" for older dates in current year', () => {
    // Use a fixed known date that is definitely > 7 days old and in current year
    const now = new Date();
    // Use Jan 2 of this year if we are past Jan 9, else use a date earlier in the year
    const year = now.getFullYear();
    const oldDate = new Date(`${year}-01-02T00:00:00Z`);
    // Only run this sub-test if oldDate is at least 7 days in the past
    const diffDays = (Date.now() - oldDate.getTime()) / 86_400_000;
    if (diffDays < 7) {
      // Skip — cannot test this without mocking toLocaleDateString
      return;
    }
    const result = formatRelativeTime(oldDate.toISOString());
    // Result should include a 3-letter month and no year
    expect(result).toMatch(/^[A-Z][a-z]{2} \d{1,2}$/);
  });

  it('returns "Mon DD, YYYY" for dates in previous years', () => {
    const previousYear = new Date().getFullYear() - 1;
    const oldDate = new Date(`${previousYear}-06-15T00:00:00Z`);
    const result = formatRelativeTime(oldDate.toISOString());
    // Should contain the year
    expect(result).toContain(String(previousYear));
    // Should match "Mon DD, YYYY" pattern
    expect(result).toMatch(/^[A-Z][a-z]{2} \d{1,2}, \d{4}$/);
  });

  it('returns "1m ago" for exactly 1 minute ago', () => {
    expect(formatRelativeTime(makeIso(60_000))).toBe("1m ago");
  });

  it('returns "1h ago" for exactly 1 hour ago', () => {
    expect(formatRelativeTime(makeIso(3_600_000))).toBe("1h ago");
  });

  it('returns "1d ago" for exactly 1 day ago', () => {
    expect(formatRelativeTime(makeIso(86_400_000))).toBe("1d ago");
  });

  it('returns "6d ago" for 6 days ago (boundary before weekly format)', () => {
    expect(formatRelativeTime(makeIso(6 * 86_400_000))).toBe("6d ago");
  });
});
