import client from "./client";
import { safeJoinToken, safeShareToken } from "./joinToken";
import type { Board, BoardFull, HealthHistory, HealthStatus, BoardInviteLink, CreatedBoardInviteLink, InviteEmailSent, BoardExportLogEntry, BoardMembership, BoardTemplate, BoardPublic, CardMovement, Column, Swimlane, Label, ShareActionResponse, CustomFieldDefinition, CustomFieldSet, CustomFieldType, SwimlaneCustomFieldDefinition, ThresholdDirection, DimensionResolution, TrelloImportMapping, TrelloImportPreview, TrelloImportResult, ImportOptions, ImportBoardResponse, SampleBoardSummary, BoardSummary, ChildrenSettingBlockers, BoardDeleteImpact, DefaultChildBoardOptions, SwimlaneDefaultTeamAccess } from "../types";
import type { AxiosProgressEvent } from "axios";

export type BoardRole = "admin" | "member" | "collaborator" | "viewer";

export const setBoardMember = (boardId: number, userId: number, role: BoardRole, is_moderator?: boolean) =>
  client.post<BoardMembership>(`/api/v1/boards/${boardId}/members/`, { user_id: userId, role, ...(is_moderator !== undefined && { is_moderator }) }).then((r) => r.data);

export const removeBoardMember = (boardId: number, userId: number) =>
  client.delete(`/api/v1/boards/${boardId}/members/${userId}/`);

// ------------------------------------------------------------------
// Board invites (#1444)
// ------------------------------------------------------------------

export type BoardInviteRole = "member" | "collaborator" | "viewer";

export const listBoardInviteLinks = (boardId: number) =>
  client.get<BoardInviteLink[]>(`/api/v1/boards/${boardId}/invite-links/`).then((r) => r.data);

/**
 * The board invite list caps past (used / expired / revoked) invites and says so in
 * headers (#1885): `X-Total-Count` is every invite, `X-Truncated` is true when older
 * past ones were left out (#2339). `listBoardInviteLinks` keeps its bare-array shape.
 */
export interface BoardInviteLinkPage {
  links: BoardInviteLink[];
  /** Server-reported number of invites, or `links.length` if the header is absent. */
  total: number;
  /** True when older past invites exist that are not in `links`. */
  truncated: boolean;
}

export const listBoardInviteLinksPage = (boardId: number): Promise<BoardInviteLinkPage> =>
  client.get<BoardInviteLink[]>(`/api/v1/boards/${boardId}/invite-links/`).then((r) => {
    const headerTotal = Number(r.headers?.["x-total-count"]);
    const truncated = String(r.headers?.["x-truncated"]).toLowerCase() === "true";
    return {
      links: r.data,
      total: Number.isFinite(headerTotal) ? Math.max(headerTotal, r.data.length) : r.data.length,
      truncated,
    };
  });

export const sendBoardInviteEmail = (
  boardId: number,
  data: { email: string; role?: BoardInviteRole; expiry_days?: 1 | 7 | 30 },
) =>
  client
    .post<InviteEmailSent>(`/api/v1/boards/${boardId}/invite-links/send/`, data)
    .then((r) => r.data);

/** Create a shareable invite link (#439). The response carries the raw
 * `token` once; the list never returns it. `expiry_days` is required — a
 * shareable board link never "never expires". */
export const createBoardInviteLink = (
  boardId: number,
  data: { name?: string; role?: BoardInviteRole; expiry_days: 1 | 7 | 30; single_use?: boolean },
) =>
  client
    .post<CreatedBoardInviteLink>(`/api/v1/boards/${boardId}/invite-links/`, data)
    .then((r) => r.data);

export const revokeBoardInviteLink = (boardId: number, linkId: number) =>
  client.delete(`/api/v1/boards/${boardId}/invite-links/${linkId}/`);

/** Public preview of a board invite (GET /boards/join/<token>/). 410 bodies
 * carry `code`: "used" | "expired" | "revoked"; an unknown token is a 404. */
export interface BoardJoinPreview {
  board_id: number;
  board_name: string;
  role: BoardInviteRole;
  /** Advisory: whether sign-up would accept this invite right now. */
  can_register: boolean;
}

export interface BoardJoinResult {
  board_id: number;
  board_name: string;
  role: BoardInviteRole;
  /** Whether this invite created the caller's board membership. False when
   * they already had equal or higher access. */
  created: boolean;
}

export const resolveBoardJoinToken = async (token: string) =>
  client.get<BoardJoinPreview>(`/api/v1/boards/join/${encodeURIComponent(safeJoinToken(token))}/`).then((r) => r.data);

export const joinBoard = async (token: string) =>
  client.post<BoardJoinResult>(`/api/v1/boards/join/${encodeURIComponent(safeJoinToken(token))}/`).then((r) => r.data);

export const listBoards = () =>
  client.get<{ results: Board[] }>("/api/v1/boards/").then((r) => r.data.results);

/** Every board the caller can see, walking all pages; for pickers that must not stop at page one (#2570). */
export const listAllBoards = async () => {
  const boards: Board[] = [];
  for (let offset = 0; ; ) {
    const { data } = await client.get<{ count: number; results: Board[] }>("/api/v1/boards/", { params: { offset, page_size: 200 } });
    boards.push(...data.results);
    offset += data.results.length;
    if (data.results.length === 0 || offset >= data.count) return boards;
  }
};

export const listBoardTemplates = () =>
  client.get<BoardTemplate[]>("/api/v1/boards/templates/").then((r) => r.data);

// Sample board gallery (#1452). The file endpoint returns the raw export; the
// caller wraps it in a File and posts it through importBoard unchanged.
export const listSampleBoards = (signal?: AbortSignal) =>
  client.get<SampleBoardSummary[]>("/api/v1/boards/samples/", { signal }).then((r) => r.data);

export const getSampleBoardFile = (id: string, signal?: AbortSignal) =>
  client.get<Blob>(`/api/v1/boards/samples/${encodeURIComponent(id)}/`, { responseType: "blob", signal }).then((r) => r.data);

export const createBoard = (data: { name: string; description?: string; template?: string; swimlane_name?: string }) =>
  client.post<Board>("/api/v1/boards/", data).then((r) => r.data);

export const getBoard = (id: number) =>
  client.get<Board>(`/api/v1/boards/${id}/`).then((r) => r.data);

/** A board's columns (#2549: the parent board's Needed options). Accepts a paginated or a bare list. */
export const getColumns = (boardId: number) =>
  client.get<Column[] | { results: Column[] }>(`/api/v1/boards/${boardId}/columns/`)
    .then((r) => (Array.isArray(r.data) ? r.data : r.data.results));

export const getBoardFull = (id: number) =>
  client.get<BoardFull>(`/api/v1/boards/${id}/full/`).then((r) => r.data);

export const updateBoard = (id: number, data: Partial<Board>) =>
  client.put<Board>(`/api/v1/boards/${id}/`, data).then((r) => r.data);

export const patchBoard = (id: number, data: Record<string, unknown>) =>
  client.patch<Board>(`/api/v1/boards/${id}/`, data).then((r) => r.data);

export const deleteBoard = (id: number) =>
  client.delete(`/api/v1/boards/${id}/`);

export const moveBoardToGroup = (boardId: number, groupId: number | null) =>
  client.post<Board>(`/api/v1/boards/${boardId}/move-group/`, { group_id: groupId }).then((r) => r.data);

export const starBoard = (id: number) =>
  client.post<Board>(`/api/v1/boards/${id}/star/`).then((r) => r.data);

export const unstarBoard = (id: number) =>
  client.delete<Board>(`/api/v1/boards/${id}/star/`).then((r) => r.data);

export const listStarredBoards = () =>
  client.get<{ results: Board[] }>("/api/v1/boards/", { params: { starred: "true" } }).then((r) => r.data.results);

// Columns
export const createColumn = (boardId: number, data: { name: string; color?: string; wip_limit?: number; weight_limit?: number }) =>
  client.post<Column>(`/api/v1/boards/${boardId}/columns/`, data).then((r) => r.data);

export const updateColumn = (boardId: number, colId: number, data: Partial<Column>) =>
  client.put<Column>(`/api/v1/boards/${boardId}/columns/${colId}/`, data).then((r) => r.data);

/** PATCH one or more column fields. Unlike `updateColumn` (PUT, which requires
 *  `name`), it sends only what it is given, so it never clobbers a concurrent
 *  edit to another field (#2156). */
export const patchColumn = (boardId: number, colId: number, data: Partial<Column>) =>
  client.patch<Column>(`/api/v1/boards/${boardId}/columns/${colId}/`, data).then((r) => r.data);

export const deleteColumn = (boardId: number, colId: number) =>
  client.delete(`/api/v1/boards/${boardId}/columns/${colId}/`);

export const reorderColumns = (boardId: number, order: number[]) =>
  client.post<Column[]>(`/api/v1/boards/${boardId}/columns/reorder/`, { order }).then((r) => r.data);

// Swimlanes
export const createSwimlane = (boardId: number, data: { name: string; contact_email?: string; color?: string }) =>
  client.post<Swimlane>(`/api/v1/boards/${boardId}/swimlanes/`, data).then((r) => r.data);

/** Default team members skipped on the child boards this lane feeds (#2211, admins only). */
export const getSwimlaneDefaultTeamAccess = (boardId: number, swimlaneId: number) =>
  client
    .get<SwimlaneDefaultTeamAccess>(`/api/v1/boards/${boardId}/swimlanes/${swimlaneId}/default-team-access/`)
    .then((r) => r.data);

export const updateSwimlane = (boardId: number, swimlaneId: number, data: Partial<Swimlane>) =>
  client.put<Swimlane>(`/api/v1/boards/${boardId}/swimlanes/${swimlaneId}/`, data).then((r) => r.data);

// PATCH, not PUT: a body with only the changed fields (e.g. `health_status`,
// #2243) is a partial update; PUT requires `name`.
export const patchSwimlane = (boardId: number, swimlaneId: number, data: Partial<Swimlane>) =>
  client.patch<Swimlane>(`/api/v1/boards/${boardId}/swimlanes/${swimlaneId}/`, data).then((r) => r.data);

export const deleteSwimlane = (boardId: number, swimlaneId: number) =>
  client.delete(`/api/v1/boards/${boardId}/swimlanes/${swimlaneId}/`);

export const reorderSwimlanes = (boardId: number, order: number[]) =>
  client.post<Swimlane[]>(`/api/v1/boards/${boardId}/swimlanes/reorder/`, { order }).then((r) => r.data);

// Analytics
export const getBoardSummary = (id: number) =>
  client.get<BoardSummary>(`/api/v1/boards/${id}/summary/`).then((r) => r.data);

/**
 * Optional flow filters for `getBoardAnalytics`, as on the `metrics/*` endpoints (#2280).
 * `null` means "not set" (the Analytics page's filter state, #2261); both are left out of the query.
 */
export interface BoardAnalyticsFilters {
  swimlaneId?: number | null
  labelId?: number | null
}

export const getBoardAnalytics = (
  id: number,
  days = 30,
  stalledDays?: number,
  filters: BoardAnalyticsFilters = {},
  limit?: number,
) =>
  client
    .get(`/api/v1/boards/${id}/analytics/`, {
      params: {
        days,
        ...(stalledDays !== undefined && { stalled_days: stalledDays }),
        // Caps each swimlane's stalled_cards (#2429); stalled_cards_total keeps the count.
        ...(limit !== undefined && { limit }),
        ...(filters.swimlaneId != null && { swimlane_id: filters.swimlaneId }),
        ...(filters.labelId != null && { label_id: filters.labelId }),
      },
    })
    .then((r) => r.data);

export const getBoardMovements = (boardId: number, params: Record<string, string> = {}) =>
  client.get<{ results: CardMovement[]; count: number; offset: number; page_size: number }>(`/api/v1/boards/${boardId}/movements/`, { params }).then((r) => r.data);

// Export
export const exportBoardCsv = (boardId: number) => {
  window.open(`${client.defaults.baseURL}/api/v1/boards/${boardId}/export/`, '_blank');
};

export const exportBoardJson = (boardId: number) => {
  window.open(`${client.defaults.baseURL}/api/v1/boards/${boardId}/export/?format=json`, '_blank');
};

// #842 — admin-only export audit history. Paginated by the viewset's default paginator.
export const getBoardExportHistory = (
  boardId: number,
  params: Record<string, string | number> = {},
) =>
  client
    .get<{ results: BoardExportLogEntry[]; count: number; next: string | null; previous: string | null }>(
      `/api/v1/boards/${boardId}/export-history/`,
      { params },
    )
    .then((r) => r.data);

// Labels
export const listLabels = (boardId: number) =>
  client.get<Label[]>(`/api/v1/boards/${boardId}/labels/`).then((r) => r.data);

export const createLabel = (boardId: number, data: { name: string; color?: string }) =>
  client.post<Label>(`/api/v1/boards/${boardId}/labels/`, data).then((r) => r.data);

// Field sets (#2570)
export type FieldSetWrite = Partial<Pick<CustomFieldSet, "name" | "description" | "default_size" | "scope" | "swimlanes" | "field_ids">>;
export const listFieldSets = (boardId: number) =>
  client.get<CustomFieldSet[]>(`/api/v1/boards/${boardId}/field-sets/`).then((r) => r.data);
export const createFieldSet = (boardId: number, data: FieldSetWrite) =>
  client.post<CustomFieldSet>(`/api/v1/boards/${boardId}/field-sets/`, data).then((r) => r.data);
export const updateFieldSet = (boardId: number, setId: number, data: FieldSetWrite) =>
  client.patch<CustomFieldSet>(`/api/v1/boards/${boardId}/field-sets/${setId}/`, data).then((r) => r.data);
export const deleteFieldSet = (boardId: number, setId: number) =>
  client.delete(`/api/v1/boards/${boardId}/field-sets/${setId}/`);
export const reorderFieldSets = (boardId: number, order: number[]) =>
  client.post<CustomFieldSet[]>(`/api/v1/boards/${boardId}/field-sets/reorder/`, { order }).then((r) => r.data);
export const copyFieldSet = (boardId: number, data: { source_board: number; source_set: number; name?: string }) =>
  client.post<CustomFieldSet>(`/api/v1/boards/${boardId}/field-sets/copy/`, data).then((r) => r.data);

// Custom fields (#371)
export const listCustomFieldDefinitions = (boardId: number) =>
  client.get<CustomFieldDefinition[]>(`/api/v1/boards/${boardId}/custom-fields/`).then((r) => r.data);

/** One definition, with a fresh server-computed `has_values` (#2202). */
export const getCustomFieldDefinition = (boardId: number, fieldId: number) =>
  client.get<CustomFieldDefinition>(`/api/v1/boards/${boardId}/custom-fields/${fieldId}/`).then((r) => r.data);

export const createCustomFieldDefinition = (boardId: number, data: {
  name: string;
  field_type: CustomFieldType;
  choices?: string[];
  help_text?: string;
  number_prefix?: string;
  number_suffix?: string;
  number_decimals?: number | null;
  choice_colors?: Record<string, string>;
  threshold_direction?: ThresholdDirection;
  threshold_warn?: number | null;
  threshold_alert?: number | null;
  threshold_warn_days?: number | null;
  threshold_alert_days?: number | null;
  /** #1921: a dimension dropdown (a track). */
  is_dimension?: boolean;
  choice_resolutions?: Record<string, DimensionResolution>;
}) =>
  client.post<CustomFieldDefinition>(`/api/v1/boards/${boardId}/custom-fields/`, data).then((r) => r.data);

export const updateCustomFieldDefinition = (
  boardId: number,
  fieldId: number,
  data: Partial<Pick<CustomFieldDefinition, "name" | "field_type" | "choices" | "help_text" | "show_on_card" | "number_prefix" | "number_suffix" | "number_decimals" | "choice_colors" | "choice_resolutions" | "threshold_direction" | "threshold_warn" | "threshold_alert" | "threshold_warn_days" | "threshold_alert_days">>
) =>
  client.patch<CustomFieldDefinition>(`/api/v1/boards/${boardId}/custom-fields/${fieldId}/`, data).then((r) => r.data);

export const deleteCustomFieldDefinition = (boardId: number, fieldId: number) =>
  client.delete(`/api/v1/boards/${boardId}/custom-fields/${fieldId}/`);

export const reorderCustomFields = (boardId: number, order: number[]) =>
  client.post<CustomFieldDefinition[]>(`/api/v1/boards/${boardId}/custom-fields/reorder/`, { order }).then((r) => r.data);

// Swimlane (row) custom fields (#1140). A separate endpoint from the card
// fields above, not a scoped variant of it: the two are independent per-board
// schemas with their own caps and their own id space. Row *values* need no
// endpoint here — they ride on updateSwimlane.
export const listSwimlaneCustomFieldDefinitions = (boardId: number) =>
  client.get<SwimlaneCustomFieldDefinition[]>(`/api/v1/boards/${boardId}/swimlane-custom-fields/`).then((r) => r.data);

export const createSwimlaneCustomFieldDefinition = (boardId: number, data: {
  name: string;
  field_type: CustomFieldType;
  choices?: string[];
  help_text?: string;
  is_admin_only?: boolean;
  number_prefix?: string;
  number_suffix?: string;
  number_decimals?: number | null;
  choice_colors?: Record<string, string>;
}) =>
  client.post<SwimlaneCustomFieldDefinition>(`/api/v1/boards/${boardId}/swimlane-custom-fields/`, data).then((r) => r.data);

export const updateSwimlaneCustomFieldDefinition = (
  boardId: number,
  fieldId: number,
  data: Partial<Pick<SwimlaneCustomFieldDefinition, "name" | "field_type" | "choices" | "help_text" | "show_on_row" | "is_admin_only" | "number_prefix" | "number_suffix" | "number_decimals" | "choice_colors" | "band_visibility">>
) =>
  client.patch<SwimlaneCustomFieldDefinition>(`/api/v1/boards/${boardId}/swimlane-custom-fields/${fieldId}/`, data).then((r) => r.data);

export const deleteSwimlaneCustomFieldDefinition = (boardId: number, fieldId: number) =>
  client.delete(`/api/v1/boards/${boardId}/swimlane-custom-fields/${fieldId}/`);

export const reorderSwimlaneCustomFields = (boardId: number, order: number[]) =>
  client.post<SwimlaneCustomFieldDefinition[]>(`/api/v1/boards/${boardId}/swimlane-custom-fields/reorder/`, { order }).then((r) => r.data);

export const importBoard = (file: File, name?: string, groupId?: number, options?: ImportOptions) => {
  const formData = new FormData();
  formData.append('file', file);
  if (name) formData.append('name', name);
  if (groupId) formData.append('group_id', String(groupId));
  // Selective import (#119): the endpoint is multipart, so options travel as a
  // JSON string. Omitted entirely when everything is included (the default)
  // and no date shift is requested (#1452), so a default import sends exactly
  // what it did before the field existed. Any date-shift key (#1452, #1949:
  // shift_dates, shift_dates_from, shift_dates_to) is a real request and is sent.
  const dateShift = options?.shift_dates !== undefined || !!options?.shift_dates_from || !!options?.shift_dates_to;
  if (options && (Object.values(options).some((v) => v === false) || dateShift)) {
    formData.append('options', JSON.stringify(options));
  }
  return client.post<ImportBoardResponse>('/api/v1/boards/import/', formData).then((r) => r.data);
};

// Trello import (#456). Stateless two-step flow: preview with dry_run, then
// re-upload the same file with the chosen mapping to confirm.
const TRELLO_IMPORT_URL = "/api/v1/boards/import/trello/";

interface TrelloRequestOptions {
  groupId?: number;
  signal?: AbortSignal;
  onUploadProgress?: (e: AxiosProgressEvent) => void;
}

export const previewTrelloImport = (file: File, opts: TrelloRequestOptions = {}) => {
  const formData = new FormData();
  formData.append("file", file);
  if (opts.groupId) formData.append("group_id", String(opts.groupId));
  return client
    .post<TrelloImportPreview>(`${TRELLO_IMPORT_URL}?dry_run=true`, formData, {
      signal: opts.signal,
      onUploadProgress: opts.onUploadProgress,
    })
    .then((r) => r.data);
};

export const confirmTrelloImport = (
  file: File,
  params: { name?: string; mapping: TrelloImportMapping; fileSha256?: string },
  opts: TrelloRequestOptions = {},
) => {
  const formData = new FormData();
  formData.append("file", file);
  if (params.name) formData.append("name", params.name);
  if (opts.groupId) formData.append("group_id", String(opts.groupId));
  formData.append("mapping", JSON.stringify(params.mapping));
  if (params.fileSha256) formData.append("file_sha256", params.fileSha256);
  return client
    .post<TrelloImportResult>(`${TRELLO_IMPORT_URL}?confirm=true`, formData, {
      signal: opts.signal,
      onUploadProgress: opts.onUploadProgress,
      // The import runs synchronously server-side; allow a large board time
      // to finish rather than inheriting any future global default.
      timeout: 300_000,
    })
    .then((r) => r.data);
};

// Share link
export const getPublicBoard = async (token: string) =>
  client.get<BoardPublic>(`/api/share/${safeShareToken(token)}/`).then((r) => r.data);

// expiresInDays = null → never expires; allowed values: 7, 30, 90.
// The backend rejects anything else with 400 — keep this list in sync.
// The default here stays null to match the API, where a missing or null
// expires_in_days means "never expires"; the Sharing tab pre-selects 30 days
// and passes it explicitly (#1865).
export type ShareTtlDays = 7 | 30 | 90 | null;

export const enableBoardSharing = (boardId: number, expiresInDays: ShareTtlDays = null) =>
  client
    .post<ShareActionResponse>(`/api/v1/boards/${boardId}/share/`, { expires_in_days: expiresInDays })
    .then((r) => r.data);

export const disableBoardSharing = (boardId: number) =>
  client.delete(`/api/v1/boards/${boardId}/share/`);

/**
 * Set or confirm the board's health status (#2242): the explicit action, the
 * only write that records a reconfirm (same status) or a note. `status` null
 * clears the board's own value (inherit). Board admin only.
 */
export const setBoardHealthStatus = (id: number, data: { status: HealthStatus | null; note?: string | null }) =>
  client.post<Board>(`/api/v1/boards/${id}/health-status/`, data).then((r) => r.data);

/** The board's last 20 health status changes, newest first (#2242). Any board role. */
export const getBoardHealthHistory = (id: number) =>
  client.get<HealthHistory>(`/api/v1/boards/${id}/health-history/`).then((r) => r.data);

/**
 * Recompute the board's auto health status now (#2245): the same code path as
 * the nightly job. Board admin only; 409 `health_auto_disabled` while auto
 * health is off; throttled to 30 per hour per user (429).
 */
export const recomputeBoardHealth = (id: number) =>
  client.post<{ board: Board; swimlanes: Swimlane[] }>(`/api/v1/boards/${id}/health-recompute/`).then((r) => r.data);

/** Body of `PUT .../columns/{id}/stage/` (#1102/#1921). Every key optional; omitted = unchanged. */
export interface StageSettingsBody {
  /** `[]` (a plain column) or 2 to 4 entries; an entry with `id` keeps (and may rename) that sub-column. */
  sub_columns?: { id?: number; name: string }[];
  /** Ordered ids of the board's dimension fields. */
  tracks?: number[];
  /** Replaces the lane exceptions for this stage's tracks. */
  not_applicable?: { swimlane_id: number; field_id: number }[];
}

/** One sub-column's cards, active and archived, from `GET .../stage-card-counts/` (#2368). */
export interface StageSubColumnCardCount {
  id: number;
  cards: number;
  archived_cards: number;
}

/**
 * Board admins only (#2368). Per-sub-column counts, archived cards included,
 * for the Stage settings "N cards will move" summary: a stage save remaps
 * archived cards too, and the board payload does not carry them.
 */
export const getStageCardCounts = (boardId: number, colId: number) =>
  client.get<{ sub_columns: StageSubColumnCardCount[] }>(
    `/api/v1/boards/${boardId}/columns/${colId}/stage-card-counts/`,
  ).then((r) => r.data.sub_columns);

/** Board admins only. The response's `remapped` lists cards whose `gates_passed` changed. */
export const saveColumnStage = (boardId: number, colId: number, data: StageSettingsBody) =>
  client.put<{ column: Column; remapped: { id: number; gates_passed: number; version: number }[] }>(
    `/api/v1/boards/${boardId}/columns/${colId}/stage/`, data,
  ).then((r) => r.data);

// ── Two-tier child cards (#2208) ─────────────────────────────────────────────

/** `GET /boards/{id}/children-setting-blockers/` (board admin). */
export const getChildrenSettingBlockers = (id: number) =>
  client.get<ChildrenSettingBlockers>(`/api/v1/boards/${id}/children-setting-blockers/`).then((r) => r.data);

/**
 * `GET /boards/{id}/default-child-board-options/` (board admin): boards the viewer may choose as the default.
 * `boards` holds at most 100, by name, always including the current default when it qualifies; `boards_total`
 * (#2449, since 1.3; absent from older servers) counts every qualifying board, for "Showing 100 of N".
 */
export const getDefaultChildBoardOptions = (id: number) =>
  client.get<DefaultChildBoardOptions>(`/api/v1/boards/${id}/default-child-board-options/`).then((r) => r.data);

/** `GET /boards/{id}/delete-impact/` (board owner or site admin). */
export const getBoardDeleteImpact = (id: number) =>
  client.get<BoardDeleteImpact>(`/api/v1/boards/${id}/delete-impact/`).then((r) => r.data);
