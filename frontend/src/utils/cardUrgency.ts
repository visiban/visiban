/**
 * Worst-offender urgency classification for the card-density redesign (#961).
 *
 * Replaces the wall-of-icons metadata layout with a single most-urgent badge.
 * Priority order, highest to lowest: overdue > due-soon > stale > recent.
 * Returns ``null`` when none of the conditions apply.
 *
 * The classifier is *pure*: it consumes already-resolved card fields plus a
 * caller-supplied "now" (defaults to ``Date.now()``) so unit tests can pin
 * deterministic timestamps without mocking the clock.
 *
 * Staleness is server-computed (``card.is_stale``) — never recompute it
 * client-side because the cutoff depends on the board's
 * ``staleness_threshold_days`` and on a server-anchored "today". Due-soon is
 * client-computed because it is purely a function of the date and the local
 * clock.
 */

export type CardUrgencyKind = "overdue" | "due-soon" | "stale" | "recent";

export type CardUrgencyTone = "danger" | "warning" | "info";

export interface CardUrgency {
  kind: CardUrgencyKind;
  /**
   * Default human-readable label. Date-based kinds (overdue / due-soon) are
   * rendered with the formatted ``dueInfo.label`` at the call site so the
   * badge carries the actual date — e.g. ``⚑ 2d late`` rather than
   * ``⚑ Overdue``. This default is used for ``stale`` and ``recent`` and as
   * a fallback when ``dueInfo`` is not yet computed.
   */
  label: string;
  /** Maps to the design-token-aware text tone. */
  tone: CardUrgencyTone;
}

interface ClassifyInput {
  due_date: string | null;
  is_stale: boolean;
  last_moved_at: string | null;
}

const DUE_SOON_WINDOW_MS = 72 * 60 * 60 * 1000; // 72h
const RECENT_WINDOW_MS = 24 * 60 * 60 * 1000; // 24h

export function classifyCardUrgency(card: ClassifyInput, now: number = Date.now()): CardUrgency | null {
  // Overdue beats everything — a date-based hard signal that doesn't bend on
  // staleness or recency.
  if (card.due_date) {
    const due = Date.parse(card.due_date);
    if (!Number.isNaN(due)) {
      if (due < now) {
        return { kind: "overdue", label: "Overdue", tone: "danger" };
      }
      if (due - now <= DUE_SOON_WINDOW_MS) {
        return { kind: "due-soon", label: "Due soon", tone: "warning" };
      }
    }
  }

  // ``is_stale`` is the server's verdict — trust it. We never recompute the
  // 7-day-style threshold client-side; that's the board admin's setting.
  // Tone is full ``warning`` (amber) per the VoC panel — Maya and Jordan both
  // flagged ``warning-soft`` (text-fg-secondary) as too quiet to scan at a
  // glance next to a calm card.
  if (card.is_stale) {
    return { kind: "stale", label: "Stale", tone: "warning" };
  }

  // Recently-moved is the calmest cue — useful as a "this just changed"
  // heads-up at lower densities where last-moved-text is hidden from the
  // card face. We only surface it for cards moved in the last 24h.
  if (card.last_moved_at) {
    const moved = Date.parse(card.last_moved_at);
    if (!Number.isNaN(moved) && now - moved < RECENT_WINDOW_MS) {
      return { kind: "recent", label: "Just moved", tone: "info" };
    }
  }

  return null;
}
