/**
 * Shared invite display constants (#439): the admin Invite Links and Board
 * Invites tabs and the invite panel label roles and statuses the same way.
 */

/** Status pill tones for the admin invite tables (`rounded-full` pills). */
export const INVITE_STATUS_STYLES: Record<"pending" | "used" | "expired" | "revoked", string> = {
  pending: "bg-success/20 text-success-on-tint",
  used: "bg-fg-muted/20 text-muted-on-tint",
  expired: "bg-danger/20 text-danger-on-tint",
  // line-through: revoked and used share a neutral tint and, since #2030, the same muted-on-tint text
  // (fg-tertiary on the retuned dark fg-muted/20 fill fell to 4.20:1), so the strike and the word tell them apart
  revoked: "bg-fg-muted/20 text-muted-on-tint line-through",
};

/** Display labels for invite roles. Board invites never grant admin; group links can. */
export const INVITE_ROLE_LABELS: Record<string, string> = {
  admin: "Admin",
  member: "Member",
  collaborator: "Collaborator",
  viewer: "Viewer",
};
