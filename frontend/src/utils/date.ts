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

/** Returns a display label and overdue flag for a due date string (YYYY-MM-DD). */
export function formatDueDate(
  date: string,
  tz: string,
): { label: string; overdue: boolean } {
  const today = todayInTimezone(tz);
  if (date < today) return { label: `Due ${date}`, overdue: true };
  if (date === today) return { label: "Due today", overdue: false };
  // Show relative label for next 6 days, otherwise absolute date
  const msUntil = new Date(date + "T00:00:00Z").getTime() - new Date(today + "T00:00:00Z").getTime();
  const daysUntil = Math.round(msUntil / 86_400_000);
  if (daysUntil === 1) return { label: "Due tomorrow", overdue: false };
  if (daysUntil <= 6) return { label: `Due in ${daysUntil} days`, overdue: false };
  return { label: `Due ${date}`, overdue: false };
}
