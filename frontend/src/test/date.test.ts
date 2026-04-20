import { describe, it, expect, vi, afterEach } from "vitest";
import { formatRelativeTime, formatDate, formatDateTimeUser, parseDate } from "../utils/date";
import type { UserDatePrefs } from "../utils/date";

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

// ---------------------------------------------------------------------------
// formatDate
// ---------------------------------------------------------------------------

describe("formatDate", () => {
  // Use a fixed UTC date so tests are timezone-independent.
  // 2025-07-04T00:00:00Z is midnight UTC — any timezone conversion stays on
  // the same calendar day for UTC and US timezones.
  const ISO_DATE = "2025-07-04T00:00:00Z";

  it("formats in MM/DD/YYYY by default when user has no prefs", () => {
    const result = formatDate(ISO_DATE, null);
    // Should produce some date string — exact format depends on browser's
    // UTC representation of the date, so we check pattern.
    expect(result).toMatch(/\d{2}\/\d{2}\/\d{4}/);
  });

  it("formats in MM/DD/YYYY for a user with explicit MM/DD/YYYY preference", () => {
    const user: UserDatePrefs = { date_format: "MM/DD/YYYY", timezone: "UTC" };
    expect(formatDate(ISO_DATE, user)).toBe("07/04/2025");
  });

  it("formats in DD/MM/YYYY for a user with European format", () => {
    const user: UserDatePrefs = { date_format: "DD/MM/YYYY", timezone: "UTC" };
    expect(formatDate(ISO_DATE, user)).toBe("04/07/2025");
  });

  it("formats in YYYY-MM-DD for a user with ISO format", () => {
    const user: UserDatePrefs = { date_format: "YYYY-MM-DD", timezone: "UTC" };
    expect(formatDate(ISO_DATE, user)).toBe("2025-07-04");
  });

  it("falls back to MM/DD/YYYY when date_format is null", () => {
    const user: UserDatePrefs = { date_format: null, timezone: "UTC" };
    expect(formatDate(ISO_DATE, user)).toBe("07/04/2025");
  });

  it("falls back to browser timezone when user.timezone is null", () => {
    const user: UserDatePrefs = { date_format: "YYYY-MM-DD", timezone: null };
    // Cannot assert exact value (depends on browser tz) — just check it is a valid date string.
    const result = formatDate(ISO_DATE, user);
    expect(result).toMatch(/\d{4}-\d{2}-\d{2}/);
  });

  it("returns the original value for an invalid date string", () => {
    const user: UserDatePrefs = { date_format: "MM/DD/YYYY", timezone: "UTC" };
    expect(formatDate("not-a-date", user)).toBe("not-a-date");
  });

  it("accepts a Date object", () => {
    const user: UserDatePrefs = { date_format: "YYYY-MM-DD", timezone: "UTC" };
    expect(formatDate(new Date("2025-07-04T00:00:00Z"), user)).toBe("2025-07-04");
  });
});

// ---------------------------------------------------------------------------
// formatDateTimeUser
// ---------------------------------------------------------------------------

describe("formatDateTimeUser", () => {
  const ISO = "2025-07-04T14:30:00Z"; // 2:30 PM UTC

  it("produces a string that includes both date and time parts", () => {
    const user: UserDatePrefs = { date_format: "YYYY-MM-DD", time_format: "24h", timezone: "UTC" };
    const result = formatDateTimeUser(ISO, user);
    // Should start with the date portion
    expect(result).toMatch(/^2025-07-04/);
    // Should include 14:30
    expect(result).toContain("14:30");
  });

  it("applies 12-hour format when user.time_format is 12h", () => {
    const user: UserDatePrefs = { date_format: "MM/DD/YYYY", time_format: "12h", timezone: "UTC" };
    const result = formatDateTimeUser(ISO, user);
    // 12h format should include AM/PM indicator
    expect(result).toMatch(/[APap][Mm]/);
  });

  it("applies 24-hour format when user.time_format is 24h", () => {
    const user: UserDatePrefs = { date_format: "MM/DD/YYYY", time_format: "24h", timezone: "UTC" };
    const result = formatDateTimeUser(ISO, user);
    // Should not have AM/PM
    expect(result).not.toMatch(/[APap][Mm]/);
    // Should contain 14:30
    expect(result).toContain("14:30");
  });

  it("falls back to 12h when user.time_format is null", () => {
    const user: UserDatePrefs = { date_format: "MM/DD/YYYY", time_format: null, timezone: "UTC" };
    const result = formatDateTimeUser(ISO, user);
    expect(result).toMatch(/[APap][Mm]/);
  });

  it("returns the original string for an invalid date", () => {
    expect(formatDateTimeUser("bad-date", null)).toBe("bad-date");
  });
});

// ---------------------------------------------------------------------------
// parseDate
// ---------------------------------------------------------------------------

describe("parseDate", () => {
  it("parses MM/DD/YYYY to ISO 8601", () => {
    expect(parseDate("07/04/2025", "MM/DD/YYYY")).toBe("2025-07-04");
  });

  it("parses DD/MM/YYYY to ISO 8601", () => {
    expect(parseDate("04/07/2025", "DD/MM/YYYY")).toBe("2025-07-04");
  });

  it("passes through an already-ISO date unchanged", () => {
    expect(parseDate("2025-07-04")).toBe("2025-07-04");
    expect(parseDate("2025-07-04", "MM/DD/YYYY")).toBe("2025-07-04");
    expect(parseDate("2025-07-04", "DD/MM/YYYY")).toBe("2025-07-04");
  });

  it("returns empty string for empty input", () => {
    expect(parseDate("")).toBe("");
  });

  it("returns original input when parts are missing", () => {
    expect(parseDate("07/04", "MM/DD/YYYY")).toBe("07/04");
  });

  it("round-trips an ISO string through formatDate then parseDate", () => {
    const user: UserDatePrefs = { date_format: "DD/MM/YYYY", timezone: "UTC" };
    const original = "2025-07-04";
    const displayed = formatDate(original + "T00:00:00Z", user);
    const roundTripped = parseDate(displayed, user.date_format ?? "MM/DD/YYYY");
    expect(roundTripped).toBe(original);
  });
});
