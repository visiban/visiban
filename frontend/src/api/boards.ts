import client from "./client";
import type { Board, BoardFull, Column, Customer, Label } from "../types";

export const listBoards = () =>
  client.get<Board[]>("/api/boards/").then((r) => r.data);

export const createBoard = (data: { name: string; description?: string }) =>
  client.post<Board>("/api/boards/", data).then((r) => r.data);

export const getBoard = (id: number) =>
  client.get<Board>(`/api/boards/${id}/`).then((r) => r.data);

export const getBoardFull = (id: number) =>
  client.get<BoardFull>(`/api/boards/${id}/full/`).then((r) => r.data);

export const updateBoard = (id: number, data: Partial<Board>) =>
  client.put<Board>(`/api/boards/${id}/`, data).then((r) => r.data);

export const deleteBoard = (id: number) =>
  client.delete(`/api/boards/${id}/`);

// Columns
export const createColumn = (boardId: number, data: { name: string; color?: string; wip_limit?: number }) =>
  client.post<Column>(`/api/boards/${boardId}/columns/`, data).then((r) => r.data);

export const updateColumn = (boardId: number, colId: number, data: Partial<Column>) =>
  client.put<Column>(`/api/boards/${boardId}/columns/${colId}/`, data).then((r) => r.data);

export const deleteColumn = (boardId: number, colId: number) =>
  client.delete(`/api/boards/${boardId}/columns/${colId}/`);

export const reorderColumns = (boardId: number, order: number[]) =>
  client.post<Column[]>(`/api/boards/${boardId}/columns/reorder/`, { order }).then((r) => r.data);

// Customers
export const createCustomer = (boardId: number, data: { name: string; contact_email?: string; color?: string }) =>
  client.post<Customer>(`/api/boards/${boardId}/customers/`, data).then((r) => r.data);

export const updateCustomer = (boardId: number, custId: number, data: Partial<Customer>) =>
  client.put<Customer>(`/api/boards/${boardId}/customers/${custId}/`, data).then((r) => r.data);

export const deleteCustomer = (boardId: number, custId: number) =>
  client.delete(`/api/boards/${boardId}/customers/${custId}/`);

export const reorderCustomers = (boardId: number, order: number[]) =>
  client.post<Customer[]>(`/api/boards/${boardId}/customers/reorder/`, { order }).then((r) => r.data);

// Labels
export const listLabels = (boardId: number) =>
  client.get<Label[]>(`/api/boards/${boardId}/labels/`).then((r) => r.data);

export const createLabel = (boardId: number, data: { name: string; color?: string }) =>
  client.post<Label>(`/api/boards/${boardId}/labels/`, data).then((r) => r.data);
