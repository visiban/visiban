import { canDeleteBoard } from "./canDeleteBoard";

/**
 * Who may delete a group (#2129). Offers the control to the group's owner or a
 * user holding `can_access_all_content`, the same owner-or-all-content rule as
 * boards, so it delegates to `canDeleteBoard` and the two cannot drift apart.
 * The server decides: `GroupViewSet.destroy` additionally requires the owner to
 * hold an admin membership on the group itself, and answers 403 otherwise (as
 * it does for a non-owner group admin). This only decides whether to offer the control.
 */
export function canDeleteGroup(args: {
  ownerId: number | null | undefined;
  userId: number | null | undefined;
  /** `can_access_all_content` on the signed-in user. */
  hasAllContentAccess: boolean;
}): boolean {
  return canDeleteBoard(args);
}
