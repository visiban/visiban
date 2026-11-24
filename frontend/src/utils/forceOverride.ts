import type { BoardOrSiteRole, Card } from "../types";

/**
 * Who may "Move anyway" past a Block WIP or weight limit (#1923). The one
 * client-side copy of the server's `_require_force`: every surface that offers
 * a forced move asks here. The server re-checks; this only decides what to show.
 */
export type OverrideEligibility =
  | { kind: "admin" }
  | { kind: "assignee" }
  /** The assignee, but they assigned the card to themselves. */
  | { kind: "self_assigned" }
  /** Another member, on a card whose assignee can override. */
  | { kind: "other_member"; assigneeName: string }
  | { kind: "none" };

export const NO_OVERRIDE: OverrideEligibility = { kind: "none" };
export const ADMIN_OVERRIDE: OverrideEligibility = { kind: "admin" };

export const OVERRIDE_REASON_MAX_LENGTH = 500;

export function isAdminRole(role: BoardOrSiteRole | string | null | undefined): boolean {
  return role === "admin" || role === "site_admin";
}

/** Fails closed: any missing input (user, card, switch, assigner) is no override. */
export function overrideEligibility({ role, userId, allowAssigneeOverride, card }: {
  role: BoardOrSiteRole | null | undefined;
  userId: number | null | undefined;
  allowAssigneeOverride: boolean | undefined;
  card: Pick<Card, "assignee" | "assigned_by"> | null | undefined;
}): OverrideEligibility {
  if (isAdminRole(role)) return ADMIN_OVERRIDE;
  if (role !== "member" || userId == null || allowAssigneeOverride !== true) return NO_OVERRIDE;
  const assignee = card?.assignee;
  const assignedBy = card?.assigned_by;
  if (!assignee || assignedBy == null) return NO_OVERRIDE;
  if (assignee.id === userId) return assignedBy === userId ? { kind: "self_assigned" } : { kind: "assignee" };
  // Only name an assignee who could in fact override.
  if (assignedBy === assignee.id) return NO_OVERRIDE;
  return { kind: "other_member", assigneeName: assignee.display_name || assignee.username };
}

/** True when this viewer gets a "Move anyway" control. */
export function canOverride(e: OverrideEligibility): e is { kind: "admin" } | { kind: "assignee" } {
  return e.kind === "admin" || e.kind === "assignee";
}

/** The control's label, or null when there is none. */
export function overrideLabel(e: OverrideEligibility): string | null {
  if (e.kind === "admin") return "Move anyway (admin override)";
  if (e.kind === "assignee") return "Move anyway (assignee override)";
  return null;
}

/** Why a member has no control and who does, or null. */
export function overrideHint(e: OverrideEligibility): string | null {
  if (e.kind === "self_assigned") return "You assigned this card to yourself, so a board admin needs to move it anyway.";
  if (e.kind === "other_member") return `Ask ${e.assigneeName} (the card's assignee) or a board admin to move it anyway.`;
  return null;
}
