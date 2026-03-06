import client from "./client";
import type { User } from "../types";

export const getCurrentUser = () =>
  client.get<User>("/api/auth/user/").then((r) => r.data);

export const updateCurrentUser = (data: Partial<Pick<User, "display_name" | "first_name" | "last_name" | "email" | "username">>) =>
  client.patch<User>("/api/auth/user/", data).then((r) => r.data);

export const logout = () => client.post("/api/auth/logout/");

export const login = (email: string, password: string) =>
  client.post("/api/auth/login/", { email, password });

export const register = (email: string, password1: string, password2: string) =>
  client.post("/api/auth/registration/", { email, password1, password2 });

export const getAuthProviders = () =>
  client.get<{ google: boolean; github: boolean; gitlab: boolean }>("/api/auth/providers/").then((r) => r.data);
