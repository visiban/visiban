/**
 * Shared invite display constants (#439): the admin Invite Links and Board
 * Invites tabs and the invite panel label roles and statuses the same way.
 */

/** Status pill tones for the admin invite tables (`rounded-full` pills). */
export const INVITE_STATUS_STYLES: Record<"pending" | "used" | "expired" | "revoked", string> = {
  pending: "bg-success/20 text-success-on-tint",
  used: "bg-fg-muted/20 text-fg-tertiary",
  expired: "bg-danger/20 text-danger-on-tint",
  // line-through: revoked and used share a neutral tint, and their text tones are close in light mode
  revoked: "bg-fg-muted/20 text-muted-on-tint line-through",
};

/** Display labels for invite roles. Board invites never grant admin; group links can. */
export const INVITE_ROLE_LABELS: Record<string, string> = {
  admin: "Admin",
  member: "Member",
  collaborator: "Collaborator",
  viewer: "Viewer",
};
