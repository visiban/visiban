import client from "./client";
import type { Notification } from "../types";

export const listNotifications = () =>
  client.get<Notification[]>("/api/notifications/").then((r) => r.data);

export const getUnreadCount = () =>
  client.get<{ count: number }>("/api/notifications/unread-count/").then((r) => r.data.count);

export const markRead = (ids: number[]) =>
  client.post("/api/notifications/mark-read/", { ids }).then((r) => r.data);

export const markAllRead = () =>
  client.post("/api/notifications/mark-read/", { all: true }).then((r) => r.data);
