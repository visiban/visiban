/**
 * Who may delete a board (#2034). One predicate for every surface that offers
 * a board delete (the board switcher and Board Settings' Danger Zone), so they
 * cannot drift apart.
 *
 * It mirrors `BoardViewSet.destroy`: only the board's owner or a user holding
 * `can_access_all_content` (the computed `site_admin` role) may delete. A
 * non-owner board admin gets 403, and the separate `is_site_admin` account
 * flag does not grant it. The server stays the authority; this only decides
 * whether to offer the control.
 */
export function canDeleteBoard(args: {
  ownerId: number | null | undefined;
  userId: number | null | undefined;
  /** `can_access_all_content` on the user, or the `site_admin` role on the board. */
  hasAllContentAccess: boolean;
}): boolean {
  if (args.hasAllContentAccess) return true;
  return args.userId != null && args.ownerId != null && args.ownerId === args.userId;
}
