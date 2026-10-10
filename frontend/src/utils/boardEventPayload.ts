/**
 * Per-user fields that the backend serializes into `board.updated` /
 * `board.created` payloads using the ACTING user's request context (#1559).
 * Every subscriber receives the actor's value, so merging it into local state
 * shows one user's star on another user's screen. The wire payload is
 * unchanged (1.x WebSocket contract); clients drop these fields before merging
 * and read per-user state from dedicated events instead (`board.star_changed`).
 *
 * Add the next per-user field here so every consumer picks it up.
 */
const PER_USER_BOARD_FIELDS = ["is_starred"] as const;

/** Strip per-user fields from a board.updated payload before merging into state. */
export function stripPerUserBoardFields<T extends object>(payload: T): Omit<T, "is_starred"> {
  const copy = { ...payload } as Record<string, unknown>;
  for (const f of PER_USER_BOARD_FIELDS) delete copy[f];
  return copy as Omit<T, "is_starred">;
}

/**
 * Normalize a board.created payload for a board the subscriber has not seen:
 * the creator's per-user values are replaced with neutral defaults.
 */
export function neutralizePerUserBoardFields<T extends object>(payload: T): T {
  return { ...stripPerUserBoardFields(payload), is_starred: false } as T;
}
