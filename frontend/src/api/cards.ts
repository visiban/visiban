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
}) => client.post<Card>(`/api/v1/boards/${boardId}/cards/`, data).then((r) => r.data);

export const updateCard = (boardId: number, cardId: number, data: CardPatch) =>
  client.patch<Card>(`/api/v1/boards/${boardId}/cards/${cardId}/`, data).then((r) => r.data);

export const deleteCard = (boardId: number, cardId: number) =>
  client.delete(`/api/v1/boards/${boardId}/cards/${cardId}/`);

export const moveCard = (boardId: number, cardId: number, data: {
  column_id: number;
  swimlane_id: number;
  position: number;
  version?: number;
}, force?: boolean) => client.post<{ card: Card; movement?: CardMovement }>(
  `/api/v1/boards/${boardId}/cards/${cardId}/move/${force ? "?force=true" : ""}`, data
).then((r) => r.data);

export const getCardMovements = (boardId: number, cardId: number) =>
  client.get<CardMovement[]>(`/api/v1/boards/${boardId}/cards/${cardId}/movements/`).then((r) => r.data);

export const getCardComments = (boardId: number, cardId: number) =>
  client.get<CardComment[]>(`/api/v1/boards/${boardId}/cards/${cardId}/comments/`).then((r) => r.data);

export const addCardComment = (boardId: number, cardId: number, body: string) =>
  client.post<CardComment>(`/api/v1/boards/${boardId}/cards/${cardId}/comments/`, { body }).then((r) => r.data);

export const deleteComment = (boardId: number, cardId: number, commentId: number) =>
  client.delete(`/api/v1/boards/${boardId}/cards/${cardId}/comments/${commentId}/`);

export const getCardActivities = (boardId: number, cardId: number) =>
  client.get<CardActivity[]>(`/api/v1/boards/${boardId}/cards/${cardId}/activities/`).then((r) => r.data);

export const getCardAttachments = (boardId: number, cardId: number) =>
  client.get<CardAttachment[]>(`/api/v1/boards/${boardId}/cards/${cardId}/attachments/`).then((r) => r.data);

export const uploadCardAttachment = (boardId: number, cardId: number, file: File) => {
  const form = new FormData();
  form.append("file", file);
  return client.post<CardAttachment>(`/api/v1/boards/${boardId}/cards/${cardId}/attachments/`, form, {
    headers: { "Content-Type": "multipart/form-data" },
  }).then((r) => r.data);
};

export const deleteCardAttachment = (boardId: number, cardId: number, attachmentId: number) =>
  client.delete(`/api/v1/boards/${boardId}/cards/${cardId}/attachments/${attachmentId}/`);

export const archiveCard = (boardId: number, cardId: number) =>
  client.post<Card>(`/api/v1/boards/${boardId}/cards/${cardId}/archive/`).then((r) => r.data);

export const unarchiveCard = (boardId: number, cardId: number) =>
  client.post<Card>(`/api/v1/boards/${boardId}/cards/${cardId}/unarchive/`).then((r) => r.data);

export interface ArchivedCardsPage {
  count: number;
  offset: number;
  page_size: number;
  results: Card[];
}

export const getArchivedCards = (boardId: number, offset = 0) =>
  client
    .get<ArchivedCardsPage>(`/api/v1/boards/${boardId}/cards/archived/`, { params: { offset } })
    .then((r) => r.data);

// Checklists
export const getChecklist = (boardId: number, cardId: number) =>
  client.get<CardChecklistItem[]>(`/api/v1/boards/${boardId}/cards/${cardId}/checklist/`).then((r) => r.data);

export const addChecklistItem = (boardId: number, cardId: number, text: string) =>
  client.post<CardChecklistItem>(`/api/v1/boards/${boardId}/cards/${cardId}/checklist/`, { text }).then((r) => r.data);

export const updateChecklistItem = (boardId: number, cardId: number, itemId: number, data: Partial<CardChecklistItem>) =>
  client.patch<CardChecklistItem>(`/api/v1/boards/${boardId}/cards/${cardId}/checklist/${itemId}/`, data).then((r) => r.data);

export const deleteChecklistItem = (boardId: number, cardId: number, itemId: number) =>
  client.delete(`/api/v1/boards/${boardId}/cards/${cardId}/checklist/${itemId}/`);

export const searchCards = (boardId: number, query: string, signal?: AbortSignal): Promise<Card[]> =>
  client.get<Card[]>(`/api/v1/boards/${boardId}/cards/`, { params: { search: query }, signal })
    .then((r) => r.data);

export interface CardStatus {
  archived: boolean;
}

/**
 * Fetches minimal status for a card that is not present in the live board state.
 * Used to distinguish between deleted cards and archived ones so the UI can show
 * a contextual "Card not found" message. Returns null on network error (fail-silent).
 */
export const getCardStatus = (boardId: number, cardId: number): Promise<CardStatus | null> =>
  client
    .get<CardStatus>(`/api/v1/boards/${boardId}/cards/${cardId}/status/`)
    .then((r) => r.data)
    .catch(() => null);
