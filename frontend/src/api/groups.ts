import client from "./client";
import type { Group, GroupLabel, GroupMembership, GroupInviteLink, Board, Priority } from "../types";

export const listGroups = () =>
  client.get<{ results: Group[] }>("/api/v1/groups/").then((r) => r.data.results);

export const createGroup = (data: { name: string; description?: string; parent?: number | null }) =>
  client.post<Group>("/api/v1/groups/", data).then((r) => r.data);

export const getGroup = (id: number) =>
  client.get<Group>(`/api/v1/groups/${id}/`).then((r) => r.data);

export const updateGroup = (id: number, data: { name?: string; description?: string }) =>
  client.patch<Group>(`/api/v1/groups/${id}/`, data).then((r) => r.data);

export const deleteGroup = (id: number) =>
  client.delete(`/api/v1/groups/${id}/`);

export const getGroupMembers = (id: number) =>
  client.get<GroupMembership[]>(`/api/v1/groups/${id}/members/`).then((r) => r.data);

export const removeGroupMember = (groupId: number, userId: number) =>
  client.delete(`/api/v1/groups/${groupId}/members/${userId}/`);

export const updateGroupMemberRole = (groupId: number, userId: number, role: "admin" | "member" | "collaborator" | "viewer") =>
  client.patch<GroupMembership>(`/api/v1/groups/${groupId}/members/${userId}/`, { role }).then((r) => r.data);

export const getSubgroups = (id: number) =>
  client.get<Group[]>(`/api/v1/groups/${id}/subgroups/`).then((r) => r.data);

export const getGroupBoards = (id: number) =>
  client.get<Board[]>(`/api/v1/groups/${id}/boards/`).then((r) => r.data);

export const getGroupDescendantBoards = (id: number) =>
  client.get<Board[]>(`/api/v1/groups/${id}/descendant-boards/`).then((r) => r.data);

export const createGroupBoard = (id: number, data: { name: string; description?: string; template?: string; swimlane_name?: string }) =>
  client.post<Board>(`/api/v1/groups/${id}/boards/`, data).then((r) => r.data);

export const listInviteLinks = (groupId: number) =>
  client.get<GroupInviteLink[]>(`/api/v1/groups/${groupId}/invite-links/`).then((r) => r.data);

export const createInviteLink = (
  groupId: number,
  data: { name?: string; role?: "admin" | "member" | "collaborator" | "viewer"; expiry_days?: number | null; single_use?: boolean },
) =>
  client
    .post<GroupInviteLink>(`/api/v1/groups/${groupId}/invite-links/`, data)
    .then((r) => r.data);

export const revokeInviteLink = (groupId: number, linkId: number) =>
  client.delete(`/api/v1/groups/${groupId}/invite-links/${linkId}/`);

export const resolveJoinToken = (token: string) =>
  client.get<{ group_id: number; group_name: string }>(`/api/v1/groups/join/${token}/`).then((r) => r.data);

export const joinGroup = (token: string) =>
  client.post<Group>(`/api/v1/groups/join/${token}/`).then((r) => r.data);

export const transferGroupOwnership = (groupId: number, newOwnerId: number, confirmation: string) =>
  client.post(`/api/v1/groups/${groupId}/transfer-ownership/`, { new_owner_id: newOwnerId, confirmation }).then((r) => r.data);

// ------------------------------------------------------------------
// Group labels (shared label library)
// ------------------------------------------------------------------

export const getGroupLabels = (id: number) =>
  client.get<GroupLabel[]>(`/api/v1/groups/${id}/labels/`).then((r) => r.data);

export const createGroupLabel = (id: number, data: { name: string; color: string }) =>
  client.post<GroupLabel>(`/api/v1/groups/${id}/labels/`, data).then((r) => r.data);

export const updateGroupLabel = (groupId: number, labelId: number, data: { name?: string; color?: string }) =>
  client.patch<GroupLabel>(`/api/v1/groups/${groupId}/labels/${labelId}/`, data).then((r) => r.data);

export const deleteGroupLabel = (groupId: number, labelId: number) =>
  client.delete(`/api/v1/groups/${groupId}/labels/${labelId}/`);

// ------------------------------------------------------------------
// Board defaults (default member role, allowed priorities)
// ------------------------------------------------------------------

export const updateGroupBoardDefaults = (
  id: number,
  data: { default_board_member_role?: "admin" | "member" | "collaborator" | "viewer"; allowed_priorities?: Priority[] },
) =>
  client.patch<Group>(`/api/v1/groups/${id}/board-defaults/`, data).then((r) => r.data);

// ------------------------------------------------------------------
// Group favorites (star / unstar)
// ------------------------------------------------------------------

export const starGroup = (id: number) =>
  client.post(`/api/v1/groups/${id}/star/`).then((r) => r.data);

export const unstarGroup = (id: number) =>
  client.delete(`/api/v1/groups/${id}/star/`);

export const listStarredGroups = () =>
  client.get<{ results: Group[] }>("/api/v1/groups/?starred=true").then((r) => r.data.results);
