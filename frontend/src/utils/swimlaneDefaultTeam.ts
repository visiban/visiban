import type { EffectiveBoardMember } from "../types";

/**
 * Board members a lane team may hold: listed members who are not viewers.
 * Roster rows with role "site_admin" exist only for readers with instance-wide
 * access and are people who are not listed on the board, which the server
 * refuses, so they are not offered.
 */
export function assignableMembers(members: EffectiveBoardMember[]): EffectiveBoardMember[] {
  return members.filter((m) => m.role !== "viewer" && m.role !== "site_admin");
}

/**
 * The team ids that can be shown, in team order: an id whose person is not in
 * the board's member list or is a viewer is dropped, so it is neither shown
 * nor sent back. The member payload does not say who is deactivated, so a
 * stored deactivated id is still shown and sent, and the server refuses it
 * until it is removed from the team.
 */
export function liveTeamIds(teamIds: number[] | undefined, members: EffectiveBoardMember[]): number[] {
  const ok = new Set(assignableMembers(members).map((m) => m.user.id));
  return (teamIds ?? []).filter((id) => ok.has(id));
}
