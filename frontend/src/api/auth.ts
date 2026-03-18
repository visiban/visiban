import client from "./client";
import type { User, SiteSettings, AdminUser } from "../types";

export const getCurrentUser = () =>
  client.get<User>("/api/auth/user/").then((r) => r.data);

export const getVersion = () =>
  client.get<{ version: string }>("/api/version/").then((r) => r.data.version);

export const updateCurrentUser = (data: Partial<Pick<User, "display_name" | "first_name" | "last_name" | "email" | "username" | "timezone" | "date_format" | "time_format" | "number_locale" | "notif_card_assigned" | "notif_mentioned" | "notif_due_soon" | "notif_card_moved" | "notif_comment_added">>) =>
  client.patch<User>("/api/auth/user/", data).then((r) => r.data);

export const logout = () => client.post("/api/auth/logout/");

export const login = (username: string, password: string) =>
  client.post("/api/auth/login/", { username, password });

export const register = (email: string, password1: string, password2: string) =>
  client.post("/api/auth/registration/", { email, password1, password2 });

export const getAuthProviders = () =>
  client.get<{ google: boolean; github: boolean; gitlab: boolean }>("/api/auth/providers/").then((r) => r.data);

export const getSiteConfig = () =>
  client.get<{ registration_open: boolean }>("/api/auth/site-config/").then((r) => r.data);

export const changePassword = (current_password: string, new_password: string) =>
  client.post<{ detail: string }>("/api/auth/change-password/", { current_password, new_password }).then((r) => r.data);

export const searchUsers = (query: string) =>
  client.get<User[]>(`/api/users/?search=${encodeURIComponent(query)}`).then((r) => r.data);

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
