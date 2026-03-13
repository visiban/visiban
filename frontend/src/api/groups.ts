import client from "./client";
import type { Group, GroupLabel, GroupMembership, GroupInviteLink, Board, Priority } from "../types";

export const listGroups = () =>
  client.get<{ results: Group[] }>("/api/groups/").then((r) => r.data.results);

export const createGroup = (data: { name: string; parent?: number | null }) =>
  client.post<Group>("/api/groups/", data).then((r) => r.data);

export const getGroup = (id: number) =>
  client.get<Group>(`/api/groups/${id}/`).then((r) => r.data);

export const updateGroup = (id: number, data: { name: string }) =>
  client.patch<Group>(`/api/groups/${id}/`, data).then((r) => r.data);

export const deleteGroup = (id: number) =>
  client.delete(`/api/groups/${id}/`);

export const getGroupMembers = (id: number) =>
  client.get<GroupMembership[]>(`/api/groups/${id}/members/`).then((r) => r.data);

export const removeGroupMember = (groupId: number, userId: number) =>
  client.delete(`/api/groups/${groupId}/members/${userId}/`);

export const updateGroupMemberRole = (groupId: number, userId: number, role: "admin" | "member" | "collaborator" | "viewer") =>
  client.patch<GroupMembership>(`/api/groups/${groupId}/members/${userId}/`, { role }).then((r) => r.data);

export const getSubgroups = (id: number) =>
  client.get<Group[]>(`/api/groups/${id}/subgroups/`).then((r) => r.data);

export const getGroupBoards = (id: number) =>
  client.get<Board[]>(`/api/groups/${id}/boards/`).then((r) => r.data);

export const createGroupBoard = (id: number, data: { name: string; description?: string; template?: string }) =>
  client.post<Board>(`/api/groups/${id}/boards/`, data).then((r) => r.data);

export const listInviteLinks = (groupId: number) =>
  client.get<GroupInviteLink[]>(`/api/groups/${groupId}/invite-links/`).then((r) => r.data);

export const createInviteLink = (
  groupId: number,
  data: { name?: string; role?: "admin" | "member" | "collaborator" | "viewer"; expiry_days?: number | null },
) =>
  client
    .post<GroupInviteLink>(`/api/groups/${groupId}/invite-links/`, data)
    .then((r) => r.data);

export const revokeInviteLink = (groupId: number, linkId: number) =>
  client.delete(`/api/groups/${groupId}/invite-links/${linkId}/`);

export const resolveJoinToken = (token: string) =>
  client.get<{ group_id: number; group_name: string }>(`/api/groups/join/${token}/`).then((r) => r.data);

export const joinGroup = (token: string) =>
  client.post<Group>(`/api/groups/join/${token}/`).then((r) => r.data);

export const transferGroupOwnership = (groupId: number, newOwnerId: number, confirmation: string) =>
  client.post(`/api/groups/${groupId}/transfer-ownership/`, { new_owner_id: newOwnerId, confirmation }).then((r) => r.data);

// ------------------------------------------------------------------
// Group labels (shared label library)
// ------------------------------------------------------------------

export const getGroupLabels = (id: number) =>
  client.get<GroupLabel[]>(`/api/groups/${id}/labels/`).then((r) => r.data);

export const createGroupLabel = (id: number, data: { name: string; color: string }) =>
  client.post<GroupLabel>(`/api/groups/${id}/labels/`, data).then((r) => r.data);

export const updateGroupLabel = (groupId: number, labelId: number, data: { name?: string; color?: string }) =>
  client.patch<GroupLabel>(`/api/groups/${groupId}/labels/${labelId}/`, data).then((r) => r.data);

export const deleteGroupLabel = (groupId: number, labelId: number) =>
  client.delete(`/api/groups/${groupId}/labels/${labelId}/`);

// ------------------------------------------------------------------
// Board defaults (default member role, allowed priorities)
// ------------------------------------------------------------------

export const updateGroupBoardDefaults = (
  id: number,
  data: { default_board_member_role?: "admin" | "member" | "collaborator" | "viewer"; allowed_priorities?: Priority[] },
) =>
  client.patch<Group>(`/api/groups/${id}/board-defaults/`, data).then((r) => r.data);
