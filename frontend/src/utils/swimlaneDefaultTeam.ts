import type { EffectiveBoardMember } from "../types";

/** Board members a lane team may hold: anyone who can be assigned a card (not a viewer). */
export function assignableMembers(members: EffectiveBoardMember[]): EffectiveBoardMember[] {
  return members.filter((m) => m.role !== "viewer");
}

/**
 * The team ids still assignable on this board, in team order. A stored id
 * whose member left or became a viewer is dropped, so it is neither shown nor
 * sent back (the server would refuse it).
 */
export function liveTeamIds(teamIds: number[] | undefined, members: EffectiveBoardMember[]): number[] {
  const ok = new Set(assignableMembers(members).map((m) => m.user.id));
  return (teamIds ?? []).filter((id) => ok.has(id));
}
