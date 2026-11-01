import type { BoardFull, ShareLinkUpdatedPayload } from "../types";

/**
 * Per-user fields that the backend serializes into `board.updated` /
 * `board.created` payloads using the ACTING user's request context (#1559).
 * Since #1705 the server sends them only to the acting user's sockets and
 * omits them for everyone else, but the actor's own copy still carries a
 * value that may be stale next to `board.star_changed`, and older servers
 * send it to every subscriber. Clients therefore drop these fields before
 * merging and read per-user state from dedicated events instead
 * (`board.star_changed`).
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
 *
 * Known trade-off: this also applies to a board moved INTO the group that the
 * viewer may already have starred. Its row shows unstarred until the next
 * reload or `board.star_changed`; accepted because the alternative is showing
 * the creator's star to everyone.
 */
export function neutralizePerUserBoardFields<T extends object>(
  payload: T,
): Omit<T, "is_starred"> & { is_starred: boolean } {
  return { ...stripPerUserBoardFields(payload), is_starred: false } as Omit<T, "is_starred"> & { is_starred: boolean };
}

/**
 * Map a `share_link.updated` payload (#1967) onto the `/full/` share fields,
 * so it merges into board state like the Sharing tab's own `onShareChanged`
 * patch. The wire names differ from the `/full/` names because the server
 * strips `share_link_active` / `share_token_expires_at` from every frame.
 * Fails closed: anything but `active: true` reads as no link, and an expiry
 * is kept only for an active link.
 */
export function shareLinkPatchFromEvent(
  payload: Partial<ShareLinkUpdatedPayload> | null | undefined,
): Pick<BoardFull, "share_link_active" | "share_token_expires_at"> {
  const active = payload?.active === true;
  const expiresAt = active && typeof payload?.expires_at === "string" ? payload.expires_at : null;
  return { share_link_active: active, share_token_expires_at: expiresAt };
}

/**
 * The rotation signal of a `share_link.updated` payload (#1967): the issue
 * time of the link an enable or rotate just created, or null for any change
 * that issued no link (revoke, server-side clear, expiry edit). Fails closed:
 * null unless the link is active and `issued_at` is a string.
 */
export function shareLinkIssuedAtFromEvent(
  payload: Partial<ShareLinkUpdatedPayload> | null | undefined,
): string | null {
  return payload?.active === true && typeof payload.issued_at === "string" ? payload.issued_at : null;
}
