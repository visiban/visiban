import client from "./client";
import type { User, SiteSettings, AdminUser, AdminInviteLink, CreatedAdminInviteLink, PersonalAccessToken, CreatedPersonalAccessToken } from "../types";

export const getCurrentUser = () =>
  client.get<User>("/api/auth/user/").then((r) => r.data);

export const getVersion = () =>
  client.get<{ version: string }>("/api/version/").then((r) => r.data.version);

export const updateCurrentUser = (data: Partial<Pick<User, "display_name" | "first_name" | "last_name" | "email" | "username" | "timezone" | "date_format" | "time_format" | "number_locale" | "close_editor_on_enter" | "notif_card_assigned" | "notif_mentioned" | "notif_due_soon" | "notif_card_moved" | "notif_comment_added">>) =>
  client.patch<User>("/api/auth/user/", data).then((r) => r.data);

export const logout = () => client.post("/api/auth/logout/");

export const login = (username: string, password: string) =>
  client.post("/api/auth/login/", { username, password });

export const register = (email: string, password1: string, password2: string, invite_token?: string) =>
  client.post("/api/auth/registration/", { email, password1, password2, ...(invite_token ? { invite_token } : {}) });

export const getAuthProviders = () =>
  client.get<{ google: boolean; github: boolean; gitlab: boolean; oidc: boolean; oidc_name: string | null }>("/api/auth/providers/").then((r) => r.data);

export const getSiteConfig = () =>
  client.get<{ registration_open: boolean; registration_mode: "open" | "invite_only" | "closed" }>("/api/auth/site-config/").then((r) => r.data);

export const changePassword = (current_password: string, new_password: string) =>
  client.post<{ detail: string }>("/api/auth/change-password/", { current_password, new_password }).then((r) => r.data);

export const chooseUsername = (username: string) =>
  client.post<User>("/api/auth/choose-username/", { username }).then((r) => r.data);

// updateDefaultBoard uses /api/auth/me/ (Visiban's own CurrentUserView) rather than
// /api/auth/user/ (dj-rest-auth's built-in endpoint) because dj-rest-auth does not
// know about the Visiban-specific `default_board_id` field — only CurrentUserView's
// serializer handles it. getCurrentUser and updateCurrentUser use /api/auth/user/
// for everything else because dj-rest-auth's session/token management hooks into
// that path. Do not consolidate these two paths without migrating the dj-rest-auth
// integration first.
export const updateDefaultBoard = (boardId: number | null) =>
  client.patch<import("../types").User>("/api/auth/me/", { default_board_id: boardId }).then((r) => r.data);

export const completeTour = () =>
  client.patch<import("../types").User>("/api/auth/me/", { has_completed_tour: true }).then((r) => r.data);

export const searchUsers = (query: string) =>
  client.get<User[]>(`/api/users/?search=${encodeURIComponent(query)}`).then((r) => r.data);

// Personal Access Tokens

export const listTokens = () =>
  client.get<PersonalAccessToken[]>("/api/auth/tokens/").then((r) => r.data);

export const createToken = (name: string, expires_at?: string) =>
  client.post<CreatedPersonalAccessToken>("/api/auth/tokens/", { name, expires_at }).then((r) => r.data);

export const revokeToken = (id: number) =>
  client.delete(`/api/auth/tokens/${id}/`);

// Admin API

export const getAdminSettings = () =>
  client.get<SiteSettings>("/api/admin/settings/").then((r) => r.data);

export const patchAdminSettings = (data: Partial<SiteSettings>) =>
  client.patch<SiteSettings>("/api/admin/settings/", data).then((r) => r.data);

export const getAdminUsers = (params?: { search?: string; page?: number }) =>
  client.get<{ count: number; next: string | null; previous: string | null; results: AdminUser[] }>(
    "/api/admin/users/",
    { params }
  ).then((r) => r.data);

export const createAdminUser = (data: {
  username: string;
  email: string;
  password: string;
  force_password_reset: boolean;
}) =>
  client.post<AdminUser>("/api/admin/users/", data).then((r) => r.data);

export const patchAdminUser = (
  id: number,
  data: Partial<Pick<AdminUser, "is_active" | "is_site_admin" | "must_change_password">>
) =>
  client.patch<AdminUser>(`/api/admin/users/${id}/`, data).then((r) => r.data);

export const deactivateAdminUser = (
  id: number,
  transfers: Array<{ board_id: number; transfer_to: number }> = []
) =>
  client.post<AdminUser>(`/api/admin/users/${id}/deactivate/`, { transfers }).then((r) => r.data);

export const getAdminInviteLinks = () =>
  client.get<AdminInviteLink[]>("/api/admin/invite-links/").then((r) => r.data);

export const createAdminInviteLink = (data: {
  expires_in_days: number | null;
  single_use: boolean;
}) =>
  client.post<CreatedAdminInviteLink>("/api/admin/invite-links/", data).then((r) => r.data);

export const revokeAdminInviteLink = (id: number) =>
  client.delete<AdminInviteLink>(`/api/admin/invite-links/${id}/`).then((r) => r.data);
