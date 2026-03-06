import client from "./client";
import type { User } from "../types";

export const getCurrentUser = () =>
  client.get<User>("/api/auth/user/").then((r) => r.data);

export const updateCurrentUser = (data: Partial<Pick<User, "display_name" | "first_name" | "last_name" | "email" | "username">>) =>
  client.patch<User>("/api/auth/user/", data).then((r) => r.data);

export const logout = () => client.post("/api/auth/logout/");
