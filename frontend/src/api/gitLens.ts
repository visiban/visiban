import client from "./client";
import type { LensConnection, LensData, LensProvider } from "../types";

/**
 * Read the lens connection for a board. Resolves to the connection, or rejects
 * with a 404 when no lens is configured (callers distinguish via the error
 * response status).
 */
export const getLensConnection = (boardId: number) =>
  client.get<LensConnection>(`/api/v1/git-lens/connections/${boardId}/`).then((r) => r.data);

/** Create or replace the lens connection for a board (admins only). */
export const putLensConnection = (
  boardId: number,
  data: {
    provider: LensProvider;
    repo_slug: string;
    column_dim?: string;
    swimlane_dim?: string;
  },
) =>
  client.put<LensConnection>(`/api/v1/git-lens/connections/${boardId}/`, data).then((r) => r.data);

/** Detach the lens connection from a board (admins only). */
export const deleteLensConnection = (boardId: number) =>
  client.delete(`/api/v1/git-lens/connections/${boardId}/`);

/**
 * Fetch the rendered, read-only lens board. ``column_dim`` / ``swimlane_dim``
 * are optional ad-hoc pivot overrides — when omitted the board's saved default
 * pivot is used. Provider/auth/rate-limit failures reject with the axios error
 * carrying ``error.response.data.code`` ("auth_required" | "rate_limited" |
 * "lens_error" | "repo_not_found"); useLensData reads that code.
 */
export const getLensBoard = (
  boardId: number,
  pivot?: {
    column_dim?: string;
    swimlane_dim?: string;
    // Server-side filters. Text search is client-side and not sent here.
    state?: string;
    milestone?: string;
  },
) =>
  client
    .get<LensData>(`/api/v1/git-lens/board/${boardId}/`, {
      params: {
        ...(pivot?.column_dim ? { column_dim: pivot.column_dim } : {}),
        ...(pivot?.swimlane_dim ? { swimlane_dim: pivot.swimlane_dim } : {}),
        ...(pivot?.state ? { state: pivot.state } : {}),
        ...(pivot?.milestone ? { milestone: pivot.milestone } : {}),
      },
    })
    .then((r) => r.data);
