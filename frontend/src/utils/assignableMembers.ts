/** Roster roles the server accepts as a card assignee: the board roles except
 * viewer, plus the synthesized `site_admin` row. Mirrors
 * `boards.utils._get_assignable_member_ids` (#1905). */
const ASSIGNABLE_ROLES: ReadonlySet<string> = new Set(["admin", "member", "collaborator", "site_admin"]);

/** Whether a roster row may be offered in an assignee picker (#1905).
 *
 * A row whose stored role is outside the known enum stays in the roster so an
 * admin can find and remove it in the Members panel, but the server grants it
 * nothing and refuses it as an assignee, so pickers skip it. All-content access
 * resolves to full access ahead of the stored role, so such a row is
 * assignable whatever it stores; the flag reaches board admins only. */
export function isAssignableMember(m: { role: string; has_all_content_access?: boolean }): boolean {
  return m.has_all_content_access === true || ASSIGNABLE_ROLES.has(m.role);
}
