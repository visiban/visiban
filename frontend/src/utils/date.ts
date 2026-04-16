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
  const diff = Date.now() - new Date(iso).getTime();
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  const date = new Date(iso);
  const now = new Date();
  if (date.getFullYear() === now.getFullYear()) {
    return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
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
