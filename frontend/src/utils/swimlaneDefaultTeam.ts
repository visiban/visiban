import type { EffectiveBoardMember, Swimlane } from "../types";

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
 * nor sent back. A stored deactivated id is kept: Edit swimlane marks it from
 * `default_team_members` (#2211) and the server refuses a team that still
 * holds it, so it must be removed, never dropped silently.
 */
export function liveTeamIds(teamIds: number[] | undefined, members: EffectiveBoardMember[]): number[] {
  const ok = new Set(assignableMembers(members).map((m) => m.user.id));
  return (teamIds ?? []).filter((id) => ok.has(id));
}

/** A member's display name, as the board shows it. */
export function memberName(user: { display_name?: string | null; username: string }): string {
  return user.display_name || user.username;
}

/** Ids of the lane's team members who are deactivated (#2211), from `default_team_members`. */
export function inactiveTeamIds(swimlane: Pick<Swimlane, "default_team_members">): Set<number> {
  return new Set((swimlane.default_team_members ?? []).filter((m) => !m.is_active).map((m) => m.id));
}

export interface LaneDefault {
  /** The person a new card in the lane is pre-assigned to, or null when nobody qualifies. */
  assignee: EffectiveBoardMember["user"] | null;
  /** Names of the other team members, listed in the caption and not assigned (#2206 decision G). */
  others: string[];
}

/**
 * What a new card created in `swimlane` is pre-assigned (#2211): the first team member, in team
 * order, who is active and can be assigned cards on this board. A card has one assignee, so the rest
 * are only named. Null when the lane has no team or nobody on it qualifies, so a lane without a team
 * renders nothing and pre-assigns nobody.
 */
export function laneDefaultAssignee(
  swimlane: Pick<Swimlane, "default_team" | "default_team_members">,
  members: EffectiveBoardMember[] | undefined,
): LaneDefault | null {
  const inactive = inactiveTeamIds(swimlane);
  const ids = liveTeamIds(swimlane.default_team, members ?? []).filter((id) => !inactive.has(id));
  if (ids.length === 0) return null;
  const byId = new Map((members ?? []).map((m) => [m.user.id, m.user]));
  const [first, ...rest] = ids;
  return { assignee: byId.get(first) ?? null, others: rest.map((id) => memberName(byId.get(id)!)) };
}

/** The lane band's "Default team: Mia, Dan" row (#2211): live, active team members' names, in team order. */
export function teamRowNames(
  swimlane: Pick<Swimlane, "default_team" | "default_team_members">,
  members: EffectiveBoardMember[] | undefined,
): string[] {
  const inactive = inactiveTeamIds(swimlane);
  const byId = new Map((members ?? []).map((m) => [m.user.id, m.user]));
  return liveTeamIds(swimlane.default_team, members ?? [])
    .filter((id) => !inactive.has(id))
    .map((id) => memberName(byId.get(id)!));
}

/** The Add card caption (#2211): where the pre-assigned member came from. */
export const laneCaption = (laneName: string) =>
  `From the ${laneName} default team. Remove anyone this card shouldn't have.`;

/** The Add child caption (#2211): the parent's lane decides; the child board's own lanes are not consulted. */
export const childCaption = (laneName: string, parentBoardName: string, childBoardName: string) =>
  `From the ${laneName} default team on ${parentBoardName}, the lane the parent is in. ${childBoardName}'s own lanes are not consulted.`;
