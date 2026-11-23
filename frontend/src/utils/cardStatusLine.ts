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

/**
 * A planned child's status line (#2371), shown only when the card has no overdue, due-soon or stale line. Its date
 * is inactive while planned, so it never feeds those. Order: date passed while planned (warning) > needed now
 * (warning; the Stale line replaces it once stale) > planned (tertiary, the quietest). No glyph: the clock means
 * Stale or idle only (#2206 rule 4). The parent's column is named only when the viewer can open the parent.
 */
export interface PlannedStatusLine {
  kind: "planned-passed" | "needed-now" | "planned";
  tone: "warning" | "tertiary";
  text: string;
  /** The Dense form: the state and the stage only (`Planned · Proposal`); `text` goes in `title`. */
  shortText: string;
}

export function buildPlannedStatusLine(
  card: {
    planned?: boolean; needed_now?: boolean; needed_at_column_name?: string | null; due_date: string | null;
    needed_now_reason?: "parent" | "cancelled" | null;
    is_stale: boolean; parent?: { hidden: boolean; column_name?: string } | null;
  },
  today: string,
): PlannedStatusLine | null {
  const due = card.due_date ? card.due_date.slice(0, 10) : null;
  if (card.planned) {
    if (due && due < today) {
      const text = `${formatShortMonthDay(due)} passed while planned`;
      return { kind: "planned-passed", tone: "warning", text, shortText: text };
    }
    const name = card.needed_at_column_name;
    const stage = name ? `Planned for ${name}` : "Planned for a later stage";
    return {
      kind: "planned", tone: "tertiary",
      text: due ? `${stage} · ${formatShortMonthDay(due)}, counts once needed` : stage,
      shortText: name ? `Planned · ${name}` : "Planned",
    };
  }
  if (card.needed_now && !card.is_stale) {
    // Only a parent-caused release names the parent; a cancelled plan (its column deleted, or
    // "Needed: Now") says a neutral "Needed now", since the parent did not move. With no
    // reason (an older payload) the face cannot tell, so it stays neutral too.
    let text = "Needed now";
    if (card.needed_now_reason === "parent") {
      const column = card.parent && !card.parent.hidden ? card.parent.column_name : undefined;
      // A viewer who can't open the parent learns only that it moved (§2).
      text = column ? `Needed now: parent is in ${column}` : "Needed now: the parent moved on";
    }
    return { kind: "needed-now", tone: "warning", text, shortText: "Needed now" };
  }
  return null;
}
