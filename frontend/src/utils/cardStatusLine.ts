/**
 * The card face's single status line (#2272): overdue, due soon or stale, with
 * a short form for the Dense tier. Pure so the wording is testable on its own.
 * Every kind carries words as well as an icon and a tone, so the state never
 * depends on color alone.
 */
export type CardStatusKind = "overdue" | "due-soon" | "stale";

export interface CardStatusLine {
  kind: CardStatusKind;
  /** Visible text, e.g. "Overdue Nov 12", "Due in 3 days", "Stale 39d". */
  text: string;
  /** Dense tier: "Overdue", "Due soon", "39d". */
  shortText: string;
  /** Screen-reader prefix needed where the short text alone would not say the state. */
  shortSrPrefix: string;
}

/** "Nov 12" from a YYYY-MM-DD date, independent of the viewer's timezone. */
export function formatShortMonthDay(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return date;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

export function buildCardStatusLine(input: {
  kind: CardStatusKind;
  dueDate: string | null;
  /** `formatDueDate(...).label`, e.g. "Due tomorrow". */
  dueLabel: string | null;
  /** Whole idle days when an aging stage applies, else 0. */
  idleDays: number;
}): CardStatusLine {
  const { kind, dueDate, dueLabel, idleDays } = input;
  if (kind === "overdue") {
    return {
      kind,
      text: dueDate ? `Overdue ${formatShortMonthDay(dueDate)}` : "Overdue",
      shortText: "Overdue",
      shortSrPrefix: "",
    };
  }
  if (kind === "due-soon") {
    return { kind, text: dueLabel ?? "Due soon", shortText: "Due soon", shortSrPrefix: "" };
  }
  return {
    kind,
    text: idleDays > 0 ? `Stale ${idleDays}d` : "Stale",
    shortText: idleDays > 0 ? `${idleDays}d` : "Stale",
    shortSrPrefix: idleDays > 0 ? "Stale " : "",
  };
}
