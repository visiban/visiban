import client from "./client";
import type { Notification } from "../types";

export const listNotifications = () =>
  client.get<Notification[]>("/api/v1/notifications/").then((r) => r.data);

export const getUnreadCount = () =>
  client.get<{ count: number }>("/api/v1/notifications/unread-count/").then((r) => r.data.count);

export const markRead = (ids: number[]) =>
  client.post("/api/v1/notifications/mark-read/", { ids }).then((r) => r.data);

export const markAllRead = () =>
  client.post("/api/v1/notifications/mark-read/", { all: true }).then((r) => r.data);
