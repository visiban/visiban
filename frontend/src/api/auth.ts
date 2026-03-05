import client from "./client";
import type { User } from "../types";

export const getCurrentUser = () =>
  client.get<User>("/api/auth/user/").then((r) => r.data);

export const logout = () => client.post("/api/auth/logout/");
