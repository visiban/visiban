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
 * Overdue follows the one rule the server applies (#2313; see
 * ``backend/boards/card_signals.py``): the due date is before today's date in
 * the instance time zone, and the card is open (not archived, not in a Done
 * column). A card due today is not overdue until the instance's midnight; it is
 * "due soon" instead. ``overdueRule.test.ts`` pins the shared fixture.
 *
 * Staleness is server-computed (``card.is_stale``) — never recompute it
 * client-side because the cutoff depends on the board's
 * ``staleness_threshold_days`` and on a server-anchored "today". Due-soon is
 * client-computed because it is purely a function of the date and the local
 * clock.
 */

import { todayInTimezone } from "./date";
import { instanceTimezone } from "./instanceTimezone";

export type CardUrgencyKind = "overdue" | "due-soon" | "stale" | "recent";

export type CardUrgencyTone = "danger" | "warning" | "info";

export interface CardUrgency {
  kind: CardUrgencyKind;
  /**
   * Default human-readable label. Date-based kinds (overdue / due-soon) are
   * rendered with the formatted ``dueInfo.label`` at the call site so the
   * badge carries the actual date — e.g. ``Due 10/30/2026`` (after a flag
   * glyph) rather than ``Overdue``. This default is used for ``stale`` and ``recent`` and as
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
  /** Newest movement is the card's creation, not a move (#1576). */
  last_move_is_creation?: boolean;
  /**
   * The card is in a Done column, or archived: finished work carries no
   * overdue or due-soon signal (#2313). Optional so callers that only ever
   * see open cards need not pass it.
   */
  closed?: boolean;
}

/**
 * The overdue rule (#2313): a due date before today's date in ``tz`` (the
 * instance time zone by default), on an open card. ``dueDate`` is the API's
 * ``YYYY-MM-DD``; ISO date strings compare in date order.
 */
export function isOverdue(
  dueDate: string | null,
  closed: boolean,
  now: number = Date.now(),
  tz: string = instanceTimezone(),
): boolean {
  if (!dueDate || closed) return false;
  return dueDate.slice(0, 10) < todayInTimezone(tz, new Date(now));
}

const DUE_SOON_WINDOW_MS = 72 * 60 * 60 * 1000; // 72h
const RECENT_WINDOW_MS = 24 * 60 * 60 * 1000; // 24h

export function classifyCardUrgency(card: ClassifyInput, now: number = Date.now()): CardUrgency | null {
  // Overdue beats everything — a date-based hard signal that doesn't bend on
  // staleness or recency.
  if (card.due_date && !card.closed) {
    const due = Date.parse(card.due_date);
    if (!Number.isNaN(due)) {
      if (isOverdue(card.due_date, false, now)) {
        return { kind: "overdue", label: "Overdue", tone: "danger" };
      }
      // Not overdue yet, so a due date already behind ``now`` is today's in the
      // instance zone: due soon until its midnight.
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
  // A card's creation is recorded as a movement, but a brand-new card has not
  // "moved" — suppress the cue until a real move lands (#1576).
  if (card.last_moved_at && !card.last_move_is_creation) {
    const moved = Date.parse(card.last_moved_at);
    if (!Number.isNaN(moved) && now - moved < RECENT_WINDOW_MS) {
      return { kind: "recent", label: "Just moved", tone: "info" };
    }
  }

  return null;
}
