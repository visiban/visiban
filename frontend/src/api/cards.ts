import client from "./client";
import type { Card, CardMovement, CardComment, Priority } from "../types";

export interface CardPatch {
  title?: string;
  description?: string;
  priority?: Priority;
  due_date?: string | null;
  assignee_id?: number | null;
  label_ids?: number[];
}

export const createCard = (boardId: number, data: {
  column: number;
  customer: number;
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
  customer_id: number;
  position: number;
}) => client.post<{ card: Card; movement?: CardMovement }>(
  `/api/boards/${boardId}/cards/${cardId}/move/`, data
).then((r) => r.data);

export const getCardMovements = (boardId: number, cardId: number) =>
  client.get<CardMovement[]>(`/api/boards/${boardId}/cards/${cardId}/movements/`).then((r) => r.data);

export const getCardComments = (boardId: number, cardId: number) =>
  client.get<CardComment[]>(`/api/boards/${boardId}/cards/${cardId}/comments/`).then((r) => r.data);

export const addCardComment = (boardId: number, cardId: number, body: string) =>
  client.post<CardComment>(`/api/boards/${boardId}/cards/${cardId}/comments/`, { body }).then((r) => r.data);
