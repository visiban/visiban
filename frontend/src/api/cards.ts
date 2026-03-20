import client from "./client";
import type { Card, CardActivity, CardAttachment, CardChecklistItem, CardMovement, CardComment, Priority } from "../types";

export interface CardPatch {
  title?: string;
  description?: string;
  priority?: Priority;
  due_date?: string | null;
  assignee_id?: number | null;
  label_ids?: number[];
  weight?: number;
}

export const createCard = (boardId: number, data: {
  column: number;
  swimlane: number;
  title: string;
  description?: string;
  priority?: string;
  due_date?: string;
}) => client.post<Card>(`/api/boards/${boardId}/cards/`, data).then((r) => r.data);

export const updateCard = (boardId: number, cardId: number, data: CardPatch) =>
  client.patch<Card>(`/api/boards/${boardId}/cards/${cardId}/`, data).then((r) => r.data);

export const deleteCard = (boardId: number, cardId: number) =>
  client.delete(`/api/boards/${boardId}/cards/${cardId}/`);

export const moveCard = (boardId: number, cardId: number, data: {
  column_id: number;
  swimlane_id: number;
  position: number;
}, force?: boolean) => client.post<{ card: Card; movement?: CardMovement }>(
  `/api/boards/${boardId}/cards/${cardId}/move/${force ? "?force=true" : ""}`, data
).then((r) => r.data);

export const getCardMovements = (boardId: number, cardId: number) =>
  client.get<CardMovement[]>(`/api/boards/${boardId}/cards/${cardId}/movements/`).then((r) => r.data);

export const getCardComments = (boardId: number, cardId: number) =>
  client.get<CardComment[]>(`/api/boards/${boardId}/cards/${cardId}/comments/`).then((r) => r.data);

export const addCardComment = (boardId: number, cardId: number, body: string) =>
  client.post<CardComment>(`/api/boards/${boardId}/cards/${cardId}/comments/`, { body }).then((r) => r.data);

export const getCardActivities = (boardId: number, cardId: number) =>
  client.get<CardActivity[]>(`/api/boards/${boardId}/cards/${cardId}/activities/`).then((r) => r.data);

export const getCardAttachments = (boardId: number, cardId: number) =>
  client.get<CardAttachment[]>(`/api/boards/${boardId}/cards/${cardId}/attachments/`).then((r) => r.data);

export const uploadCardAttachment = (boardId: number, cardId: number, file: File) => {
  const form = new FormData();
  form.append("file", file);
  return client.post<CardAttachment>(`/api/boards/${boardId}/cards/${cardId}/attachments/`, form, {
    headers: { "Content-Type": "multipart/form-data" },
  }).then((r) => r.data);
};

export const deleteCardAttachment = (boardId: number, cardId: number, attachmentId: number) =>
  client.delete(`/api/boards/${boardId}/cards/${cardId}/attachments/${attachmentId}/`);

export const archiveCard = (boardId: number, cardId: number) =>
  client.post<Card>(`/api/boards/${boardId}/cards/${cardId}/archive/`).then((r) => r.data);

export const unarchiveCard = (boardId: number, cardId: number) =>
  client.post<Card>(`/api/boards/${boardId}/cards/${cardId}/unarchive/`).then((r) => r.data);

export const getArchivedCards = (boardId: number) =>
  client.get<Card[]>(`/api/boards/${boardId}/cards/archived/`).then((r) => r.data);

// Checklists
export const getChecklist = (boardId: number, cardId: number) =>
  client.get<CardChecklistItem[]>(`/api/boards/${boardId}/cards/${cardId}/checklist/`).then((r) => r.data);

export const addChecklistItem = (boardId: number, cardId: number, text: string) =>
  client.post<CardChecklistItem>(`/api/boards/${boardId}/cards/${cardId}/checklist/`, { text }).then((r) => r.data);

export const updateChecklistItem = (boardId: number, cardId: number, itemId: number, data: Partial<CardChecklistItem>) =>
  client.patch<CardChecklistItem>(`/api/boards/${boardId}/cards/${cardId}/checklist/${itemId}/`, data).then((r) => r.data);

export const deleteChecklistItem = (boardId: number, cardId: number, itemId: number) =>
  client.delete(`/api/boards/${boardId}/cards/${cardId}/checklist/${itemId}/`);
