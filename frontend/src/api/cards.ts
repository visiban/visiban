import client from "./client";
import type { Card, CardActivity, CardAttachment, CardBlock, CardChecklistItem, CardMovement, CardComment, CardRelation, CardRelationDirection, Priority, CardTimelineEntry, CustomFieldValue, CardExternalRef } from "../types";

export interface CardPatch {
  title?: string;
  description?: string;
  priority?: Priority;
  due_date?: string | null;
  assignee_id?: number | null;
  label_ids?: number[];
  weight?: number;
  /**
   * Full replacement array, not a delta (#371) — matches every other list
   * field on this type. Callers rebuild the whole array client-side (existing
   * values with the target field's entry inserted/replaced/removed) before
   * sending; see `frontend/src/utils/customFieldValue.ts` for the merge helper.
   */
  custom_field_values?: CustomFieldValue[];
  /**
   * MR/PR link (#352). An object is a full replace (all three keys required);
   * `null` removes the link; omit the key to leave it untouched.
   */
  external_ref?: CardExternalRef | null;
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

/** Block a card with a required reason (#1149). Resolves to the updated card. */
export const blockCard = (boardId: number, cardId: number, reason: string) =>
  client.post<Card>(`/api/v1/boards/${boardId}/cards/${cardId}/block/`, { reason }).then((r) => r.data);

/** Clear a card's manual block, with an optional resolution (#1149). */
export const unblockCard = (boardId: number, cardId: number, resolution = "") =>
  client.post<Card>(`/api/v1/boards/${boardId}/cards/${cardId}/unblock/`, { resolution }).then((r) => r.data);

/** Every manual block of a card, newest first (#1149). */
export const getCardBlocks = (boardId: number, cardId: number) =>
  client.get<CardBlock[]>(`/api/v1/boards/${boardId}/cards/${cardId}/blocks/`).then((r) => r.data);

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

// Relations (#449)
//
// Fetched on demand rather than riding on the board payload: a card carries
// only the scalar `blocker_count`, so the full list costs one request when the
// detail panel opens instead of an array on every card of every board load.
// Each row is resolved to `cardId`'s point of view — the same relation reads as
// `blocks` from one end and `blocked_by` from the other.
export const getCardRelations = (boardId: number, cardId: number) =>
  client.get<CardRelation[]>(`/api/v1/boards/${boardId}/cards/${cardId}/relations/`).then((r) => r.data);

// `direction` is stated from `cardId`'s point of view — `blocked_by` records
// "the other card blocks this one". The server decides which end is stored as
// `from_card` and normalizes `relates_to` by card id, so the caller never has
// to know the storage layout.
export const addCardRelation = (
  boardId: number,
  cardId: number,
  toCard: number,
  direction: CardRelationDirection,
) =>
  client
    .post<CardRelation>(`/api/v1/boards/${boardId}/cards/${cardId}/relations/`, {
      to_card: toCard,
      direction,
    })
    .then((r) => r.data);

// Deletable from either end — both cards display the relation, so both can
// unlink it. `relationId` is the id returned by getCardRelations().
export const deleteCardRelation = (boardId: number, cardId: number, relationId: number) =>
  client.delete(`/api/v1/boards/${boardId}/cards/${cardId}/relations/${relationId}/`);

export const searchCards = (boardId: number, query: string, signal?: AbortSignal): Promise<Card[]> =>
  client.get<Card[]>(`/api/v1/boards/${boardId}/cards/`, { params: { search: query }, signal })
    .then((r) => r.data);

/** Rows the card list endpoint returns per request (its server-side cap, #1724). */
export const CARD_SEARCH_PAGE_SIZE = 200;
/** Upper bound on pages walked for one search, so a runaway query cannot loop forever. */
export const CARD_SEARCH_MAX_PAGES = 25;

export interface AllCardSearchResult {
  cards: Card[];
  /** True when matches exist that are NOT in `cards` (page ceiling hit). */
  truncated: boolean;
  /** Server-reported number of matches (X-Total-Count), or `cards.length` if absent. */
  total: number;
}

/**
 * Search the whole board and return every match, walking `limit`/`offset`
 * pages while the server reports `X-Truncated: true` (#1763). The endpoint caps
 * one response at 200 rows, so a single request silently drops matches on a
 * large board. Bounded by CARD_SEARCH_MAX_PAGES; if the ceiling is hit the
 * result is flagged `truncated` so the caller can tell the user. A non-abort
 * failure on page 2+ also returns the partial matches flagged `truncated`.
 */
export async function searchAllCards(
  boardId: number,
  query: string,
  signal?: AbortSignal,
): Promise<AllCardSearchResult> {
  const cards: Card[] = [];
  let total = 0;
  for (let page = 0; page < CARD_SEARCH_MAX_PAGES; page++) {
    let r;
    try {
      r = await client.get<Card[]>(`/api/v1/boards/${boardId}/cards/`, {
        params: { search: query, limit: CARD_SEARCH_PAGE_SIZE, offset: cards.length },
        signal,
      });
    } catch (err) {
      // Page 1 failing, or an abort, keeps the caller's existing policy. A failure on a
      // later page (e.g. a 429) returns what was gathered, flagged truncated, so the
      // filter still applies and the notice appears instead of the filter silently
      // dropping and showing every card.
      const e = err as { name?: string };
      const aborted = e?.name === "CanceledError" || e?.name === "AbortError" || signal?.aborted;
      if (page === 0 || aborted) throw err;
      // A truncated result has more matches than were loaded, even if the total header was missing.
      return { cards, truncated: true, total: Math.max(total, cards.length + 1) };
    }
    cards.push(...r.data);
    const headerTotal = Number(r.headers?.["x-total-count"]);
    if (Number.isFinite(headerTotal)) total = headerTotal;
    const truncated = String(r.headers?.["x-truncated"]).toLowerCase() === "true";
    // An empty page while "truncated" would loop without progress; stop and flag it.
    if (!truncated) return { cards, truncated: false, total: Math.max(total, cards.length) };
    if (r.data.length === 0) break;
  }
  return { cards, truncated: true, total: Math.max(total, cards.length) };
}

/** The timeline's `event_types` filter groups (`views/cards.py` `_TIMELINE_EVENT_GROUPS`). */
export type TimelineEventGroup = "move" | "comment" | "field" | "checklist" | "attachment" | "system";

/** Per-group totals, independent of `event_types`; their sum is the unfiltered `count` (#967). */
export type TimelineCounts = Record<TimelineEventGroup, number>;

export interface TimelinePage {
  count: number;
  next: string | null;
  previous: string | null;
  results: CardTimelineEntry[];
  /** Since 1.3 (#967). Present only when the request sent `include_counts: true`. */
  counts?: TimelineCounts;
}

export const getCardTimeline = (
  boardId: number,
  cardId: number,
  params?: { limit?: number; offset?: number; event_types?: string; include_counts?: boolean }
): Promise<TimelinePage> =>
  client
    .get<TimelinePage>(`/api/v1/boards/${boardId}/cards/${cardId}/timeline/`, { params })
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
