/**
 * Blocked-state helpers (#1149).
 *
 * A card is blocked manually (`blocked_at` set, with a reason) or by one or
 * more active `blocks` relations (#449, `blocker_count`). The card face, the
 * "Blocked only" filter and the Summary count all show the union, as one
 * signal (frontend/CLAUDE.md § System signals).
 */
import type { Card } from "../types";

const MINUTE = 60_000;
/** The reason is cut to this many characters in the indicator's name (#1149). */
export const BLOCKED_LABEL_REASON_MAX = 120;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

type BlockSource = Pick<Card, "blocked_at" | "blocker_count">;

/**
 * True when the card is blocked manually or by a relation.
 *
 * Recomputed from the two sources rather than read from the server's
 * `is_blocked`, because the card detail panel adjusts `blocker_count`
 * optimistically when a relation is added or removed, and the derived flag
 * would lag until the next server copy arrives.
 */
export function isCardBlocked(card: BlockSource): boolean {
  return card.blocked_at != null || card.blocker_count > 0;
}

/** True when the card has an open manual block. */
export function isManuallyBlocked(card: Pick<Card, "blocked_at">): boolean {
  return card.blocked_at != null;
}

/** Milliseconds since `blockedAt`, never negative (a skewed client clock reads as 0). */
export function blockedElapsedMs(blockedAt: string, now: number = Date.now()): number {
  const start = Date.parse(blockedAt);
  if (Number.isNaN(start)) return 0;
  return Math.max(0, now - start);
}

/**
 * A compact duration: the largest unit, plus the next one when `units` is 2.
 *
 * `units: 1` is the card-face form ("3d", "5h", "12m"); `units: 2` the
 * accessible name and the detail banner ("3d 5h", "5h 12m"). Under a minute
 * reads "<1m" so a fresh block never shows "0m".
 */
export function formatBlockedDuration(ms: number, units: 1 | 2 = 2): string {
  if (ms < MINUTE) return "<1m";
  const days = Math.floor(ms / DAY);
  const hours = Math.floor((ms % DAY) / HOUR);
  const minutes = Math.floor((ms % HOUR) / MINUTE);
  const parts: string[] = [];
  if (days > 0) {
    parts.push(`${days}d`);
    if (units === 2 && hours > 0) parts.push(`${hours}h`);
  } else if (hours > 0) {
    parts.push(`${hours}h`);
    if (units === 2 && minutes > 0) parts.push(`${minutes}m`);
  } else {
    parts.push(`${minutes}m`);
  }
  return parts.join(" ");
}

/**
 * The accessible name (and `title`) of the card-face blocked indicator.
 *
 * Manual: "Blocked 3d 5h: {reason}". Relation only: "Blocked by 2 cards"
 * (the #449 wording, unchanged). Both: the manual form, then the relation
 * count, so neither source is hidden from a screen-reader user.
 */
export function blockedIndicatorLabel(
  card: Pick<Card, "blocked_at" | "blocked_reason" | "blocker_count">,
  now: number = Date.now(),
): string {
  const relation =
    card.blocker_count > 0
      ? card.blocker_count === 1
        ? "Blocked by 1 card"
        : `Blocked by ${card.blocker_count} cards`
      : "";
  if (card.blocked_at == null) return relation;
  const elapsed = formatBlockedDuration(blockedElapsedMs(card.blocked_at, now), 2);
  // Cut so every blocked card in a column scan does not read a paragraph;
  // the full reason is in the card detail banner.
  const full = (card.blocked_reason ?? "").trim();
  const reason = full.length > BLOCKED_LABEL_REASON_MAX
    ? `${full.slice(0, BLOCKED_LABEL_REASON_MAX - 1).trimEnd()}…`
    : full;
  const manual = reason ? `Blocked ${elapsed}: ${reason}` : `Blocked ${elapsed}`;
  if (!relation) return manual;
  return `${manual}. ${card.blocker_count === 1 ? "Also blocked by 1 card" : `Also blocked by ${card.blocker_count} cards`}`;
}
