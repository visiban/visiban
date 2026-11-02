import client from "./client";
import type {
  WebhookCreateResponse,
  WebhookRotateResponse,
  WebhookStatus,
  WebhookSubscription,
  WebhookTestResult,
} from "../types";

/**
 * Outbound webhooks (#863): one function per row of the API table in
 * docs/api/webhooks.md. Errors reject with the axios error; a coded refusal
 * carries `error.response.data.code` (`webhooks_disabled`, `session_required`,
 * `invalid_url`, `url_not_allowed`, `invalid_event_types`, `limit_reached`,
 * `cursor_expired`, `secret_unavailable`).
 */
const base = (boardId: number) => `/api/v1/boards/${boardId}/webhooks/`;

export interface WebhookWriteBody {
  name?: string;
  url?: string;
  /** Empty array = all subscribable events. */
  event_types?: string[];
}

export type WebhookResumeFrom = "cursor" | "latest";

/** Always 200 for a board admin, whether or not webhooks are on. */
export const getWebhookStatus = (boardId: number) =>
  client.get<WebhookStatus>(`${base(boardId)}status/`).then((r) => r.data);

export const listWebhooks = (boardId: number) =>
  client.get<WebhookSubscription[]>(base(boardId)).then((r) => r.data);

/** The only response that carries the full URL and the signing secret. */
export const createWebhook = (boardId: number, body: WebhookWriteBody & { url: string }) =>
  client.post<WebhookCreateResponse>(base(boardId), body).then((r) => r.data);

/** Send only the changed keys. Changing `url` makes the caller the owner. */
export const updateWebhook = (boardId: number, id: number, body: WebhookWriteBody) =>
  client.patch<WebhookSubscription>(`${base(boardId)}${id}/`, body).then((r) => r.data);

export const deleteWebhook = (boardId: number, id: number) =>
  client.delete(`${base(boardId)}${id}/`);

export const disableWebhook = (boardId: number, id: number) =>
  client.post<WebhookSubscription>(`${base(boardId)}${id}/disable/`).then((r) => r.data);

/**
 * Turn a webhook on again. Taking over after `creator_lost_access` needs the
 * caller's `currentPassword` (or, for an SSO-only account, a recent provider
 * sign-in: the server answers 403 `recent_login_required` otherwise).
 */
export const reenableWebhook = (
  boardId: number,
  id: number,
  resumeFrom: WebhookResumeFrom,
  currentPassword?: string,
) =>
  client
    .post<WebhookSubscription>(`${base(boardId)}${id}/reenable/`, {
      resume_from: resumeFrom,
      ...(currentPassword ? { current_password: currentPassword } : {}),
    })
    .then((r) => r.data);

/** The new secret, shown once. The old one stops working at once. */
export const rotateWebhookSecret = (boardId: number, id: number) =>
  client.post<WebhookRotateResponse>(`${base(boardId)}${id}/rotate/`).then((r) => r.data);

export const testWebhook = (boardId: number, id: number) =>
  client.post<WebhookTestResult>(`${base(boardId)}${id}/test/`).then((r) => r.data);
