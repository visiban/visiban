// ---------------------------------------------------------------------------
// Minimal user-preference shape consumed by the formatting utilities below.
// We use a structural subset rather than importing the full User type so this
// module stays free of circular imports and remains independently testable.
// ---------------------------------------------------------------------------

export interface UserDatePrefs {
  date_format?: string | null;
  time_format?: string | null;
  timezone?: string | null;
}

// ---------------------------------------------------------------------------
// User-preference-aware formatters
// ---------------------------------------------------------------------------

/**
 * Formats an ISO 8601 date string or Date object using the user's `date_format`
 * and `timezone` preferences. Falls back to the browser timezone when
 * `user.timezone` is missing or null, and to MM/DD/YYYY when `user.date_format`
 * is missing or null.
 *
 * Nothing stored in state or sent to the API is changed — this only affects
 * how values are rendered.
 */
export function formatDate(value: string | Date, user: UserDatePrefs | null | undefined): string {
  const d = typeof value === "string" ? new Date(value) : value;
  if (isNaN(d.getTime())) return String(value);

  const tz = user?.timezone || undefined; // undefined → browser default
  const fmt = user?.date_format || "MM/DD/YYYY";

  // Map our format tokens to Intl options, then reformat to the user's pattern.
  // We derive year/month/day parts from Intl to get proper timezone conversion.
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(d);
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
    const y = get("year");
    const m = get("month");
    const day = get("day");
    switch (fmt) {
      case "DD/MM/YYYY": return `${day}/${m}/${y}`;
      case "YYYY-MM-DD": return `${y}-${m}-${day}`;
      default: return `${m}/${day}/${y}`; // MM/DD/YYYY
    }
  } catch {
    return formatDateStr(
      d.toISOString().slice(0, 10),
      fmt,
    );
  }
}

/**
 * Formats an ISO 8601 datetime string or Date object using the user's
 * `date_format`, `time_format`, and `timezone` preferences. Appends the
 * time portion (12-hour or 24-hour) after the date.
 *
 * Nothing stored in state or sent to the API is changed — this only affects
 * how values are rendered.
 */
export function formatDateTimeUser(
  value: string | Date,
  user: UserDatePrefs | null | undefined,
): string {
  const d = typeof value === "string" ? new Date(value) : value;
  if (isNaN(d.getTime())) return String(value);

  const tz = user?.timezone || undefined;
  const timeFmt = user?.time_format || "12h";
  const datePart = formatDate(d, user);

  try {
    const hour12 = timeFmt !== "24h";
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hour: "numeric",
      minute: "2-digit",
      hour12,
    }).formatToParts(d);
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
    const hour = get("hour");
    const minute = get("minute");
    if (hour12) {
      const dayPeriod = get("dayPeriod").toUpperCase() || (parts.find((p) => p.type === "dayPeriod")?.value.toUpperCase() ?? "");
      return `${datePart} ${hour}:${minute} ${dayPeriod}`;
    }
    return `${datePart} ${hour.padStart(2, "0")}:${minute}`;
  } catch {
    // Fallback: use the non-timezone-aware formatDateTime helper
    return formatDateTime(typeof value === "string" ? value : d.toISOString(), user?.date_format ?? "MM/DD/YYYY", timeFmt);
  }
}

/**
 * Parses a user-entered date string back to ISO 8601 (YYYY-MM-DD) for API
 * submission. Handles the three supported display formats:
 *   MM/DD/YYYY, DD/MM/YYYY, YYYY-MM-DD
 *
 * Returns the original string unchanged if parsing fails, so callers can
 * surface a validation error rather than silently dropping the input.
 */
export function parseDate(input: string, dateFormat = "MM/DD/YYYY"): string {
  const s = input.trim();
  if (!s) return s;

  // Already ISO format — pass through unchanged
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;

  try {
    switch (dateFormat) {
      case "DD/MM/YYYY": {
        const [d, m, y] = s.split("/");
        if (!d || !m || !y) return input;
        return `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
      }
      case "YYYY-MM-DD":
        // Non-ISO separators (e.g. "2025.12.31") — normalise to dashes
        return s.replace(/[./]/g, "-");
      default: {
        // MM/DD/YYYY (US default)
        const [m, d, y] = s.split("/");
        if (!d || !m || !y) return input;
        return `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
      }
    }
  } catch {
    return input;
  }
}

// ---------------------------------------------------------------------------

export const TIMEZONE_OPTIONS: { value: string; label: string }[] = [
  { value: "UTC", label: "UTC" },
  { value: "America/New_York", label: "Eastern Time" },
  { value: "America/Chicago", label: "Central Time" },
  { value: "America/Denver", label: "Mountain Time" },
  { value: "America/Phoenix", label: "Mountain Time (no DST)" },
  { value: "America/Los_Angeles", label: "Pacific Time" },
  { value: "America/Anchorage", label: "Alaska Time" },
  { value: "Pacific/Honolulu", label: "Hawaii Time" },
  { value: "America/Toronto", label: "Eastern Time (Canada)" },
  { value: "America/Vancouver", label: "Pacific Time (Canada)" },
  { value: "America/Sao_Paulo", label: "Brasília Time" },
  { value: "America/Argentina/Buenos_Aires", label: "Argentina Time" },
  { value: "America/Mexico_City", label: "Central Time (Mexico)" },
  { value: "Europe/London", label: "London / GMT" },
  { value: "Europe/Dublin", label: "Dublin" },
  { value: "Europe/Lisbon", label: "Lisbon" },
  { value: "Europe/Paris", label: "Central European Time" },
  { value: "Europe/Berlin", label: "Berlin" },
  { value: "Europe/Amsterdam", label: "Amsterdam" },
  { value: "Europe/Brussels", label: "Brussels" },
  { value: "Europe/Rome", label: "Rome" },
  { value: "Europe/Madrid", label: "Madrid" },
  { value: "Europe/Zurich", label: "Zurich" },
  { value: "Europe/Warsaw", label: "Warsaw" },
  { value: "Europe/Stockholm", label: "Stockholm" },
  { value: "Europe/Oslo", label: "Oslo" },
  { value: "Europe/Helsinki", label: "Helsinki" },
  { value: "Europe/Athens", label: "Athens" },
  { value: "Europe/Bucharest", label: "Bucharest" },
  { value: "Europe/Kiev", label: "Kyiv" },
  { value: "Europe/Moscow", label: "Moscow" },
  { value: "Asia/Dubai", label: "Dubai" },
  { value: "Asia/Karachi", label: "Pakistan Standard Time" },
  { value: "Asia/Kolkata", label: "India Standard Time" },
  { value: "Asia/Dhaka", label: "Bangladesh Standard Time" },
  { value: "Asia/Bangkok", label: "Indochina Time" },
  { value: "Asia/Jakarta", label: "Western Indonesia Time" },
  { value: "Asia/Singapore", label: "Singapore Time" },
  { value: "Asia/Kuala_Lumpur", label: "Malaysia Time" },
  { value: "Asia/Shanghai", label: "China Standard Time" },
  { value: "Asia/Hong_Kong", label: "Hong Kong Time" },
  { value: "Asia/Taipei", label: "Taipei" },
  { value: "Asia/Tokyo", label: "Japan Standard Time" },
  { value: "Asia/Seoul", label: "Korea Standard Time" },
  { value: "Australia/Perth", label: "Australian Western Time" },
  { value: "Australia/Adelaide", label: "Australian Central Time" },
  { value: "Australia/Sydney", label: "Australian Eastern Time" },
  { value: "Australia/Melbourne", label: "Melbourne" },
  { value: "Pacific/Auckland", label: "New Zealand Time" },
  { value: "Pacific/Fiji", label: "Fiji Time" },
];

export function browserTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return "UTC";
  }
}

/** Returns today's date as YYYY-MM-DD in the given IANA timezone (falls back to UTC). */
export function todayInTimezone(tz: string): string {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz || "UTC",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(new Date());
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
    return `${get("year")}-${get("month")}-${get("day")}`;
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

/** Formats a YYYY-MM-DD date string according to the user's date format preference. */
export function formatDateStr(date: string, dateFormat = "MM/DD/YYYY"): string {
  const [y, m, d] = date.split("-");
  if (!y || !m || !d) return date;
  switch (dateFormat) {
    case "DD/MM/YYYY": return `${d}/${m}/${y}`;
    case "YYYY-MM-DD": return `${y}-${m}-${d}`;
    default: return `${m}/${d}/${y}`;
  }
}

/** Formats an ISO datetime string using the user's date and time format preferences. */
export function formatDateTime(isoStr: string, dateFormat = "MM/DD/YYYY", timeFormat = "12h"): string {
  const d = new Date(isoStr);
  if (isNaN(d.getTime())) return isoStr;
  const datePart = formatDateStr(d.toISOString().slice(0, 10), dateFormat);
  let hours = d.getHours();
  const mins = String(d.getMinutes()).padStart(2, "0");
  if (timeFormat === "24h") {
    return `${datePart} ${String(hours).padStart(2, "0")}:${mins}`;
  }
  const period = hours >= 12 ? "PM" : "AM";
  hours = hours % 12 || 12;
  return `${datePart} ${hours}:${mins} ${period}`;
}

/** Returns a short relative label for when a card was last moved (e.g. "moved today", "moved 3 days ago").
 *  Returns null for null/undefined input, '' for invalid date strings.
 *  < 24 h → "moved today"; 24–48 h → "moved yesterday"; 2–13 d → "moved N days ago";
 *  ≥ 14 d → "moved MM/DD" (month and day only, respecting dateFormat).
 *
 *  Note: CardItem gates on `!isRecent` (ms < 86_400_000) before calling this function,
 *  so the "moved today" branch is unreachable from that call site. The branch is kept
 *  so callers that do NOT apply the isRecent gate receive a complete, self-contained result. */
export function formatRelativeMovedAt(isoString: string | null | undefined, dateFormat = "MM/DD/YYYY"): string | null {
  if (isoString == null) return null;
  if (isoString === "") return "";
  const d = new Date(isoString);
  if (isNaN(d.getTime())) return "";
  const ms = Date.now() - d.getTime();
  const days = Math.floor(ms / 86_400_000);
  if (ms < 86_400_000) return "moved today";
  if (days < 2) return "moved yesterday";
  if (days < 14) return `moved ${days} days ago`;
  // ≥ 14 days: show month/day only (no year — year is obvious, saves space on card face)
  const [, m, day] = d.toISOString().slice(0, 10).split("-");
  if (dateFormat === "DD/MM/YYYY") return `moved ${day}/${m}`;
  return `moved ${m}/${day}`;
}

/**
 * Returns a short human-readable relative timestamp for an ISO datetime string.
 *
 * < 1 min  → "just now"
 * < 1 h    → "Xm ago"
 * < 24 h   → "Xh ago"
 * < 7 d    → "Xd ago"
 * same year → "Mon DD"  (e.g. "Apr 1")
 * older    → "Mon DD, YYYY"
 */
export function formatRelativeTime(iso: string): string {
  const parsed = new Date(iso);
  if (isNaN(parsed.getTime())) return "";
  const diff = Date.now() - parsed.getTime();
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  const now = new Date();
  if (parsed.getFullYear() === now.getFullYear()) {
    return parsed.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }
  return parsed.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

/** Returns a display label and overdue flag for a due date string (YYYY-MM-DD). */
export function formatDueDate(
  date: string,
  tz: string,
  dateFormat = "MM/DD/YYYY",
): { label: string; overdue: boolean } {
  const today = todayInTimezone(tz);
  if (date < today) return { label: `Due ${formatDateStr(date, dateFormat)}`, overdue: true };
  if (date === today) return { label: "Due today", overdue: false };
  // Show relative label for next 6 days, otherwise absolute date
  const msUntil = new Date(date + "T00:00:00Z").getTime() - new Date(today + "T00:00:00Z").getTime();
  const daysUntil = Math.round(msUntil / 86_400_000);
  if (daysUntil === 1) return { label: "Due tomorrow", overdue: false };
  if (daysUntil <= 6) return { label: `Due in ${daysUntil} days`, overdue: false };
  return { label: `Due ${formatDateStr(date, dateFormat)}`, overdue: false };
}
