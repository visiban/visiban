import client from "./client";
import type { User, SiteSettings, AdminUser, AdminInviteLink, CreatedAdminInviteLink, PersonalAccessToken, CreatedPersonalAccessToken } from "../types";

export const getCurrentUser = () =>
  client.get<User>("/api/v1/auth/user/").then((r) => r.data);

export const getVersion = () =>
  client.get<{ version: string }>("/api/v1/version/").then((r) => r.data.version);

export const updateCurrentUser = (data: Partial<Pick<User, "display_name" | "first_name" | "last_name" | "email" | "username" | "timezone" | "date_format" | "time_format" | "number_locale" | "close_editor_on_enter" | "theme" | "notif_card_assigned" | "notif_mentioned" | "notif_due_soon" | "notif_card_moved" | "notif_comment_added" | "notif_board_invite">>) =>
  client.patch<User>("/api/v1/auth/user/", data).then((r) => r.data);

export const logout = () => client.post("/api/v1/auth/logout/");

export const login = (username: string, password: string) =>
  client.post("/api/v1/auth/login/", { username, password });

export const register = (email: string, password1: string, password2: string, invite_token?: string) =>
  client.post("/api/v1/auth/registration/", { email, password1, password2, ...(invite_token ? { invite_token } : {}) });

export const getAuthProviders = () =>
  client.get<{ google: boolean; github: boolean; gitlab: boolean; oidc: boolean; oidc_name: string | null }>("/api/v1/auth/providers/").then((r) => r.data);

export const getSiteConfig = () =>
  client.get<{ registration_open: boolean; registration_mode: "open" | "invite_only" | "closed" }>("/api/v1/auth/site-config/").then((r) => r.data);

export const changePassword = (current_password: string, new_password: string) =>
  client.post<{ detail: string }>("/api/v1/auth/change-password/", { current_password, new_password }).then((r) => r.data);

export const requestPasswordReset = (email: string): Promise<void> =>
  client.post("/api/v1/auth/password/reset/", { email }).then(() => undefined);

export const confirmPasswordReset = (uid: string, token: string, new_password1: string, new_password2: string): Promise<void> =>
  client.post("/api/v1/auth/password/reset/confirm/", { uid, token, new_password1, new_password2 }).then(() => undefined);

export const verifyEmail = (key: string): Promise<void> =>
  client.post("/api/v1/auth/registration/verify-email/", { key }).then(() => undefined);

export const chooseUsername = (username: string) =>
  client.post<User>("/api/v1/auth/choose-username/", { username }).then((r) => r.data);

// updateDefaultBoard uses /api/v1/auth/me/ (Visiban's own CurrentUserView) rather than
// /api/v1/auth/user/ (dj-rest-auth's built-in endpoint) because dj-rest-auth does not
// know about the Visiban-specific `default_board_id` field — only CurrentUserView's
// serializer handles it. getCurrentUser and updateCurrentUser use /api/v1/auth/user/
// for everything else because dj-rest-auth's session/token management hooks into
// that path. Do not consolidate these two paths without migrating the dj-rest-auth
// integration first.
export const updateDefaultBoard = (boardId: number | null) =>
  client.patch<import("../types").User>("/api/v1/auth/me/", { default_board_id: boardId }).then((r) => r.data);

export const completeTour = () =>
  client.patch<import("../types").User>("/api/v1/auth/me/", { has_completed_tour: true }).then((r) => r.data);

export const resetTour = (): Promise<void> =>
  client.patch("/api/v1/auth/me/", { has_completed_tour: false }).then(() => undefined);

export const searchUsers = (query: string) =>
  client.get<User[]>(`/api/v1/users/?search=${encodeURIComponent(query)}`).then((r) => r.data);

// Personal Access Tokens

export const listTokens = () =>
  client.get<PersonalAccessToken[]>("/api/v1/auth/tokens/").then((r) => r.data);

export const createToken = (name: string, expires_at?: string) =>
  client.post<CreatedPersonalAccessToken>("/api/v1/auth/tokens/", { name, expires_at }).then((r) => r.data);

export const revokeToken = (id: number) =>
  client.delete(`/api/v1/auth/tokens/${id}/`);

// Admin API

export const getAdminSettings = () =>
  client.get<SiteSettings>("/api/v1/admin/settings/").then((r) => r.data);

export const patchAdminSettings = (data: Partial<SiteSettings>) =>
  client.patch<SiteSettings>("/api/v1/admin/settings/", data).then((r) => r.data);

export const getAdminUsers = (params?: { search?: string; offset?: number }) =>
  client.get<{ count: number; offset: number; page_size: number; results: AdminUser[] }>(
    "/api/v1/admin/users/",
    { params }
  ).then((r) => r.data);

export const createAdminUser = (data: {
  username: string;
  email: string;
  password: string;
  force_password_reset: boolean;
}) =>
  client.post<AdminUser>("/api/v1/admin/users/", data).then((r) => r.data);

export const patchAdminUser = (
  id: number,
  data: Partial<Pick<AdminUser, "is_active" | "is_site_admin" | "must_change_password">>
) =>
  client.patch<AdminUser>(`/api/v1/admin/users/${id}/`, data).then((r) => r.data);

export const deactivateAdminUser = (
  id: number,
  transfers: Array<{ board_id: number; transfer_to: number }> = []
) =>
  client.post<AdminUser>(`/api/v1/admin/users/${id}/deactivate/`, { transfers }).then((r) => r.data);

export const getAdminInviteLinks = () =>
  client.get<AdminInviteLink[]>("/api/v1/admin/invite-links/").then((r) => r.data);

export const createAdminInviteLink = (data: {
  expires_in_days: number | null;
  single_use: boolean;
}) =>
  client.post<CreatedAdminInviteLink>("/api/v1/admin/invite-links/", data).then((r) => r.data);

export const revokeAdminInviteLink = (id: number) =>
  client.delete<AdminInviteLink>(`/api/v1/admin/invite-links/${id}/`).then((r) => r.data);
