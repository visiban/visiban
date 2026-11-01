import type { Card } from "../types";

/**
 * True when `incoming` is an older copy of a card than `current` (#1969).
 *
 * A card reaches the client on two transports: the HTTP response to the
 * user's own write, and socket frames (`card.updated`, `card.moved`, ...)
 * for everyone's writes. They are not ordered against each other, so the
 * response to the user's PATCH (version N) can land after a remote frame that
 * already carried N+1. Replacing the stored card with it would put the older
 * copy back on screen until the next event.
 *
 * Only a strictly lower version is stale. The server bumps `version` on a field
 * update or a move, but comments, attachments, checklists, relations and
 * archive/unarchive change a card's serialized counters without bumping it, so
 * an equal-version copy can still carry newer data and must replace.
 *
 * A side with no numeric version (an older payload, a hand-built card) cannot
 * be ordered, so the incoming copy is treated as fresh: the pre-#1969 behavior.
 */
export function isStaleCard(
  incoming: Pick<Card, "version"> | null | undefined,
  current: Pick<Card, "version"> | null | undefined,
): boolean {
  const a = incoming?.version;
  const b = current?.version;
  if (typeof a !== "number" || typeof b !== "number" || Number.isNaN(a) || Number.isNaN(b)) return false;
  return a < b;
}
