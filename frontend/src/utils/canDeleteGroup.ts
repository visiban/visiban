import { canDeleteBoard } from "./canDeleteBoard";

/**
 * Who may delete a group (#2129). Mirrors `GroupViewSet.destroy`: only the
 * group's owner or a user holding `can_access_all_content` may delete. A
 * non-owner group admin gets 403. It is the same owner-or-all-content rule as
 * boards, so it delegates to `canDeleteBoard` and the two cannot drift apart.
 * The server stays the authority; this only decides whether to offer the control.
 */
export function canDeleteGroup(args: {
  ownerId: number | null | undefined;
  userId: number | null | undefined;
  /** `can_access_all_content` on the signed-in user. */
  hasAllContentAccess: boolean;
}): boolean {
  return canDeleteBoard(args);
}
