/**
 * Shared invite display constants (#439): the admin Invite Links and Board
 * Invites tabs and the invite panel label roles and statuses the same way.
 */

/** Status pill tones for the admin invite tables (`rounded-full` pills). */
export const INVITE_STATUS_STYLES: Record<"pending" | "used" | "expired" | "revoked", string> = {
  pending: "bg-success/20 text-success",
  used: "bg-fg-muted/20 text-fg-tertiary",
  expired: "bg-danger/20 text-danger",
  revoked: "bg-fg-muted/20 text-fg-muted",
};

/** Display labels for invite roles. Board invites never grant admin; group links can. */
export const INVITE_ROLE_LABELS: Record<string, string> = {
  admin: "Admin",
  member: "Member",
  collaborator: "Collaborator",
  viewer: "Viewer",
};
