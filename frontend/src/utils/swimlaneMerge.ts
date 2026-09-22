import type { Swimlane, SwimlaneCustomFieldDefinition } from "../types";

/**
 * Merge a `swimlane.updated` broadcast payload onto the copy already held in
 * local board state (#1140).
 *
 * **Why this cannot be a plain replace.** Every swimlane broadcast is built
 * from the *public* `SwimlaneSerializer` (see
 * `backend/boards/views/swimlanes.py`), never the admin one, because a board's
 * WebSocket group holds every role at once and an admin-shaped payload would
 * hand `contact_email`, `notes`, and every `is_admin_only` field value
 * straight to a connected viewer. That is correct on the wire and wrong on
 * arrival: an admin who replaces their row wholesale with the public payload
 * silently loses exactly the fields the payload was stripped of. Renaming a
 * swimlane in one tab would blank the account owner and ARR in another.
 *
 * So: take the payload verbatim for everything it carries, and keep the
 * locally-held values it could not legally have contained.
 *
 * This also fixes the same pre-existing bug for `contact_email` and `notes`,
 * which predates row fields — before #1140 it only cost a vanished email line,
 * which is why nobody chased it.
 *
 * **Cost, accepted:** an admin who *clears* an admin-only value in another tab
 * does not propagate that clear to this one until the next `/full/` fetch.
 * Stale-but-present beats correct-but-vanished, because the stale value is
 * visibly wrong and one refresh from right, whereas the vanished one looks
 * like data loss and invites the user to re-enter what is already stored.
 */
export function mergeSwimlaneFromBroadcast(
  existing: Swimlane[],
  incoming: Swimlane,
  definitions: SwimlaneCustomFieldDefinition[] | undefined,
): Swimlane {
  const prior = existing.find((s) => s.id === incoming.id);
  if (!prior) return incoming;

  const adminOnlyIds = new Set(
    (definitions ?? []).filter((d) => d.is_admin_only).map((d) => d.id),
  );
  const incomingValues = incoming.custom_field_values ?? [];
  const carried = new Set(incomingValues.map((v) => v.field_definition));

  // Keep a prior value only when it is admin-only *and* absent from the
  // payload. An admin-only value present in the payload would mean the
  // server's visibility rule changed, in which case the payload wins.
  const preserved = (prior.custom_field_values ?? []).filter(
    (v) => adminOnlyIds.has(v.field_definition) && !carried.has(v.field_definition),
  );

  return {
    ...incoming,
    contact_email: incoming.contact_email ?? prior.contact_email,
    notes: incoming.notes ?? prior.notes,
    custom_field_values: [...incomingValues, ...preserved],
  };
}
