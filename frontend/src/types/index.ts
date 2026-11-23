/**
 * Slim user shape embedded in board resources (cards, movements, comments, etc.).
 * Only fields that are safe to expose to all board members are included.
 * Matches BoardUserSerializer on the backend.
 *
 * For the full authenticated-user profile shape (notification prefs, UI prefs, etc.)
 * see the User interface below — that shape is returned exclusively by /api/auth/me/.
 */
export interface BoardUser {
  id: number;
  username: string;
  display_name: string;
  // Empty string ("") is the "no avatar" sentinel per the 1.0 API contract.
  // The backend uses blank=True (not null=True) on avatar_url; null will never
  // be returned. Treat "" as "no avatar" — never check for null/undefined here.
  avatar_url: string;
}

/** Public pre-login instance config from GET /api/v1/auth/site-config/. */
export interface SiteConfig {
  registration_open: boolean;
  registration_mode: "open" | "invite_only" | "closed";
  /** True when the instance runs as a public demo (DEMO_MODE, #1034). */
  demo_mode: boolean;
  /** Demo credentials for the login banner; null unless demo_mode and a password are configured. */
  demo_login: { username: string; password: string } | null;
  /** Cron expression of the demo reset (DEMO_RESET_SCHEDULE, #1179); null unless demo_mode. */
  demo_reset_schedule?: string | null;
  /** Next demo reset, ISO 8601 UTC, computed server-side (#1179); null unless demo_mode. */
  demo_next_reset_at?: string | null;
  /** True when admins can email invite links (#731): INVITE_EMAIL_ENABLED on,
   * DEMO_MODE off, and outbound mail configured. A UI hint, not a guarantee. */
  invite_email_available: boolean;
  /**
   * INSTANCE_TIMEZONE: the IANA zone whose date decides when a card turns
   * overdue (#2313). Optional: absent from a server older than 1.3.
   */
  instance_timezone?: string;
  /**
   * Whether the Issue Board Lens is enabled instance-wide (GIT_LENS_ENABLED).
   * Same value as `User.git_lens_enabled` (#1872).
   */
  git_lens_enabled: boolean;
  /**
   * Whether the instance is in read-only maintenance mode (#1872). Same value
   * as the deprecated `User.maintenance_mode`.
   */
  maintenance_mode: boolean;
  /**
   * The maintenance notice (#1872). Non-empty whenever maintenance_mode is
   * true, "" otherwise. Plain text: render as a text node, never as HTML.
   */
  maintenance_message: string;
}

export interface User {
  id: number;
  username: string;
  email: string;
  first_name: string;
  last_name: string;
  // Empty string ("") is the "no avatar" sentinel — never null. See BoardUser above.
  avatar_url: string;
  display_name: string;
  is_site_admin: boolean;
  can_access_all_content?: boolean;
  /**
   * Whether this account is a superuser. Sent only for the signed-in account
   * (GET /auth/user/, CurrentUserSerializer), never on an embedded user. The
   * admin users page reads it to leave out what the API refuses a site admin
   * on a superuser account (#1644). Read-only.
   */
  is_superuser?: boolean;
  must_change_password: boolean;
  must_change_username: boolean;
  has_usable_password?: boolean;
  timezone?: string;
  date_format?: string;
  time_format?: string;
  number_locale?: string;
  notif_card_assigned?: boolean;
  notif_mentioned?: boolean;
  notif_due_soon?: boolean;
  notif_card_moved?: boolean;
  notif_comment_added?: boolean;
  notif_board_invite?: boolean;
  // Split out of notif_due_soon in 1.2 (#356): that flag labels itself as the
  // due-date warning but was the only gate on the staleness scan.
  notif_stale?: boolean;
  // Per-event email delivery opt-ins (#356). Optional, like every other notif_*
  // field, and all default to false on the server.
  email_notif_card_assigned?: boolean;
  email_notif_mentioned?: boolean;
  email_notif_due_soon?: boolean;
  email_notif_card_moved?: boolean;
  email_notif_comment_added?: boolean;
  close_editor_on_enter?: boolean;
  has_completed_tour?: boolean;
  /**
   * Appearance preference. Drives theme selection client-side. Backed by a
   * non-nullable DB column with default "system"; older clients that do not
   * send this field on PATCH are unaffected. See issue #183.
   */
  theme?: "system" | "dark" | "light";
  /** PK of the board to open automatically on login, or null if not set. */
  default_board_id?: number | null;
  /** Whether file uploads are enabled instance-wide. Reflects SiteSetting.uploads_enabled. */
  uploads_enabled?: boolean;
  /**
   * Whether the read-only issue board lens (GitHub/GitLab) is enabled
   * instance-wide. Reflects the GIT_LENS_ENABLED feature flag, surfaced on the
   * current-user object so the frontend can gate the Lens view tab without a
   * second round-trip. See git_lens app.
   */
  git_lens_enabled?: boolean;
  /**
   * Whether the instance is in maintenance mode. Reflects
   * SiteSetting.maintenance_mode. While true, every non-admin write is
   * rejected with 503; site admins are exempt but still see the notice.
   *
   * @deprecated read from site-config (`SiteConfig.maintenance_mode`, GET /api/v1/auth/site-config/).
   * Still sent for the 1.x contract (#1872); removal needs a major version.
   * The bundled UI reads site-config instead (#1913).
   */
  maintenance_mode?: boolean;
  /**
   * The notice to show while maintenance_mode is true. Guaranteed non-empty by
   * the server whenever maintenance_mode is true — it substitutes a built-in
   * default for a blank operator message — so the client needs no fallback
   * string of its own. Plain text: render as a text node, never as HTML.
   *
   * @deprecated read from site-config (`SiteConfig.maintenance_message`, GET /api/v1/auth/site-config/).
   * Still sent for the 1.x contract (#1872); removal needs a major version.
   * The bundled UI reads site-config instead (#1913).
   */
  maintenance_message?: string;
  /**
   * Whether the instance is a public hosted demo (#1179). While true, the
   * server's demo fence refuses every write except card create/edit/move,
   * archive and checklist changes, answering 403 `demo_read_only`.
   *
   * @deprecated read from site-config (`SiteConfig.demo_mode`, GET /api/v1/auth/site-config/).
   * Still sent for the 1.x contract (#1872); removal needs a major version.
   * The bundled UI reads site-config instead (#1913).
   */
  demo_mode?: boolean;
  /**
   * Next scheduled demo reset, ISO 8601 UTC, computed server-side from the
   * reset cron. Null unless demo_mode. A fixed instant for the session's life:
   * the reset that would change it also ends the session.
   *
   * @deprecated read from site-config (`SiteConfig.demo_next_reset_at`, GET /api/v1/auth/site-config/).
   * Still sent for the 1.x contract (#1872); removal needs a major version.
   * The bundled UI reads site-config instead (#1913).
   */
  demo_next_reset_at?: string | null;
  /**
   * An email change awaiting confirmation, or null (#1273). Set only when the
   * install requires verified addresses (EMAIL_VERIFICATION=mandatory): a new
   * address sent on PATCH is held here, and `email` keeps the current address,
   * until the user follows the link mailed to the new one. Read-only.
   */
  pending_email?: string | null;
  /**
   * A provider this session tried to sign in with whose email matched this
   * account, while the one-time "Connect {Provider}?" prompt is still owed,
   * or null (#1314). Server-owned: cleared by DELETE /auth/me/pending-connect/
   * or any connect attempt, expires after 10 minutes. Read-only.
   */
  pending_connect_provider?: string | null;
  /**
   * How the provider names the account that tried (its username, else its
   * email), shown in the connect prompt so an unfamiliar account can be
   * declined (#1314). Null whenever pending_connect_provider is.
   */
  pending_connect_identity?: string | null;
}

/** A sign-in provider id, as the backend reports it (#1314). */
export type ProviderId = "google" | "github" | "gitlab" | "oidc";

/** One row of GET /auth/me/connected-accounts/ (#1314). Mirrors
 *  ConnectedAccountSerializer; `email`/`connected_at` are always present and
 *  null on a disconnected row (#1871). */
export interface ConnectedAccount {
  provider: string;
  connected: boolean;
  email: string | null;
  connected_at: string | null;
}

/** A scope a personal access token can carry. Strictly non-hierarchical — no
 *  scope implies any other, and `admin` does not satisfy `mcp:read`. Mirrors
 *  PAT_SCOPES in backend/accounts/models.py. */
export type PersonalAccessTokenScope =
  | "read"
  | "write"
  | "admin"
  | "mcp:read"
  | "mcp:write";

export interface PersonalAccessToken {
  id: number;
  name: string;
  /** First 8 characters of the raw token — safe to display. */
  prefix: string;
  created_at: string;
  last_used_at: string | null;
  expires_at: string | null;
  /**
   * Scopes this token carries, or `null` for a legacy token issued before
   * scopes existed. `null` is not the same as `[]`: a legacy token keeps the
   * owner's full REST authority, whereas an empty array is an explicit grant
   * of nothing. Both states are reachable from the API, so both must be
   * handled here.
   */
  scopes: PersonalAccessTokenScope[] | null;
}

/** Returned only on token creation — includes the one-time raw value. */
export interface CreatedPersonalAccessToken extends PersonalAccessToken {
  token: string;
}

export interface BoardTemplateColumn {
  name: string;
  color: string;
  position: number;
  // Optional: present on a template's terminal column(s) (e.g. "Done",
  // "Closed Won"). Additive field — added when BoardTemplate rows became
  // the single source for both listing and applying templates (#1115).
  is_done?: boolean;
}

export interface BoardTemplate {
  // NOTE: id is a UUID string (not an integer), intentionally different from other entities.
  // Templates use a UUID primary key as their stable external identifier — no separate uid field.
  id: string;
  name: string;
  slug: string;
  description: string;
  icon: string;
  lane_label: string;
  lane_placeholder: string;
  columns_json: BoardTemplateColumn[];
  sort_order: number;
}

export function userDisplayName(user: Pick<User, "display_name" | "username"> & { first_name?: string }): string {
  return user.display_name || user.first_name || user.username;
}

/** A real membership row, as `/boards/{id}/members/` returns it. */
export interface BoardMembership {
  id: number;
  user: BoardUser;
  role: BoardRole;
  /** Omitted for a requester below admin/site_admin (#920) — not always present. */
  is_moderator?: boolean;
  /**
   * The member's instance-level site-admin flag (#1290) — the signal the
   * member endpoints use to lock a row. Not the same as `role: "site_admin"`,
   * which reflects all-content access. Omitted for a requester below
   * admin/site_admin, with no self-row exception.
   */
  is_site_admin?: boolean;
  joined_at: string;
}

/**
 * One row of `BoardFull.members` — the board's *effective* roster, not its
 * membership rows (#1137). Group-inherited members and the board owner are
 * included with no membership row behind them, so `id` is `null` for those.
 * For a site-admin reader only, users with all-content access who hold no
 * other role are listed too, with `id: null` and `role: "site_admin"` (#1714). Every `BoardMembership`
 * is a valid `EffectiveBoardMember`, which is what lets a `/members/` response
 * be merged straight into `board.members`.
 */
export interface EffectiveBoardMember {
  id: number | null;
  user: BoardUser;
  role: BoardOrSiteRole;
  /** Omitted for a requester below admin/site_admin (#920) — not always present. */
  is_moderator?: boolean;
  /**
   * The member's instance-level site-admin flag (#1290) — the signal the
   * member endpoints use to lock a row. Not the same as `role: "site_admin"`,
   * which reflects all-content access. Omitted for a requester below
   * admin/site_admin, with no self-row exception, and for a board admin who
   * is not a site admin on rows with `id: null` (#1714).
   */
  is_site_admin?: boolean;
  /**
   * Whether the member has all-content access (#1301), which always resolves
   * to full access and overrides `role` (the stored board role when a
   * membership exists). Present only for a board admin or site admin reader
   * (or an instance site admin); a row with
   * `role: "site_admin"` has it implicitly.
   */
  has_all_content_access?: boolean;
  joined_at: string;
}

export type SiteRole = "site_admin";

export interface Column {
  id: number;
  uid: string;
  name: string;
  position: number;
  color: string;
  wip_limit: number | null;
  weight_limit: number | null;
  allow_card_creation: boolean;
  is_done: boolean;
  /** Explicit column policy (#1101), or null for none. Advisory: the server
   *  never refuses a move for it. */
  policy: ColumnPolicy | null;
  /** Gated stage (#1102). Always sent by the server since 1.3; optional here so pre-1.3 fixtures and cached payloads type-check. `[]` on a plain column, else at least two, in order. A card's `gates_passed` is its index here. */
  sub_columns?: SubColumn[];
  /** Dimension fields shown as tracks on this stage (#1921), in order. */
  tracks?: StageTrack[];
}

/** One sub-column of a gated stage (#1102). */
export interface SubColumn {
  id: number;
  uid: string;
  position: number;
  name: string;
}

/** A dimension field bound to a stage as a track (#1921). */
export interface StageTrack {
  id: number;
  field_id: number;
  field_uid: string;
  name: string;
  position: number;
}

/** Resolution of a dimension field's choice (#1921). Unset and unmapped resolve to `open`. UI copy says "done" for `satisfied`. */
export type DimensionResolution = "open" | "satisfied" | "not_applicable";

/** One gate passed or reopened (#1102); REST move, `card_moved` WS and MCP share this shape. */
export interface CardGateTransition {
  id: number;
  card_uid: string;
  card_title: string;
  column: number | null;
  column_name: string;
  column_uid: string;
  sub_column_name: string;
  sub_column_uid: string;
  kind: "pass" | "reopen";
  from_index: number;
  to_index: number;
  reason: string;
  cause: "move" | "stage_edited" | "import";
  movement: number | null;
  actor: string | null;
  created_at: string;
  imported_from_username: string | null;
}

/** A column as the anonymous share link serves it (`PublicColumnSerializer`,
 *  nested on `BoardPublic.columns`): every `Column` field except `policy`
 *  (#1101). A dedicated interface rather than `Omit<>`, so the
 *  serializer-ts-parity gate can compare it (the #1296 `PublicSwimlane`
 *  precedent). */
export interface PublicColumn {
  id: number;
  uid: string;
  name: string;
  position: number;
  color: string;
  wip_limit: number | null;
  weight_limit: number | null;
  allow_card_creation: boolean;
  is_done: boolean;
  /** Gated stage (#1102): the sub-columns a share-link viewer sees. `[]` on a plain column. Optional so pre-1.3 fixtures type-check. */
  sub_columns?: SubColumn[];
  /** Dimension fields shown as tracks on this stage (#1921), in order. */
  tracks?: StageTrack[];
}

/** How a column policy's entry criteria are used on a move into the column. */
export type ColumnPolicyMode = "advisory" | "confirm";

/** `Column.policy` (#1101): the versioned shape the serializer validates.
 *  At most 8 criteria per list, each at most 200 characters. */
export interface ColumnPolicy {
  v: 1;
  entry: string[];
  done: string[];
  mode: ColumnPolicyMode;
}

export interface Swimlane {
  id: number;
  uid: string;
  name: string;
  contact_email?: string;
  notes?: string;
  position: number;
  color: string;
  is_collapsed: boolean;
  created_at: string;
  /**
   * Row field values (#1140). `field_definition` is a
   * `SwimlaneCustomFieldDefinition.id` — never a `CustomFieldDefinition.id`;
   * the two are independent id spaces.
   *
   * Filtered by the server, not the client: a definition marked
   * `is_admin_only` is absent here entirely for members and viewers, so there
   * is nothing to hide client-side.
   *
   * Optional defensively: every serializer that reaches this interface today
   * (`SwimlaneSerializer`, `SwimlaneAdminSerializer`) always emits the key, so
   * nothing currently omits it. It used to be optional for a real reason —
   * the anonymous share-link serializer (`PublicSwimlaneSerializer`) omits it
   * entirely — but as of #1296 `BoardPublic.swimlanes` is typed
   * `PublicSwimlane[]`, a dedicated interface, so that reason no longer
   * applies to `Swimlane` itself. Left `?` rather than tightened, since
   * narrowing an existing field's optionality is out of scope for the gate
   * fix that prompted this comment. Read a missing value as "not visible to
   * me", never as "this row has none", if a future variant does omit it.
   */
  custom_field_values?: SwimlaneCustomFieldValue[];
  /** The row's own WIP limit (#1150); null means no limit. */
  wip_limit: number | null;
  /** The row's own weight limit (#1150); null means no limit. */
  weight_limit: number | null;
  /**
   * How the row's limits are enforced (#1150): `block` (board admins can
   * override), `hard` (the WIP limit has no override), or null to inherit the
   * board's enforce_* flags, as a column does.
   */
  limit_enforcement: SwimlaneLimitEnforcement | null;
  /**
   * Ids of the columns whose cards count toward the row's limits, sorted;
   * null means every column whose `is_done` is false (#1150).
   */
  limit_column_ids: number[] | null;
  /**
   * The lane's manual health status (#2243), the pin, or null for no pin.
   * Never inherited from the board. On an auto-health board (#2245) the
   * board's computed status is the worst of its lanes' effective statuses.
   */
  health_status: HealthStatus | null;
  /** #2245 — the pin if set, else `computed_health_status`, else null. */
  effective_health_status: HealthStatus | null;
  /** #2245 — "manual" (the pin), "computed", or null for no status. */
  health_status_origin: SwimlaneHealthStatusOrigin | null;
  /** #1921 — dimension field ids marked not applicable for every card in this lane. Optional: absent on the public share. */
  not_applicable_field_ids?: number[];
  /** #2245 — what the rule computed, readable while pinned; null when auto is off, never computed, or no open cards. */
  computed_health_status: HealthStatus | null;
  /** #2245 — when the lane was last computed; null = never computed. */
  health_computed_at: string | null;
  /** #2245 — the open-card counts behind `computed_health_status`. */
  health_computed_counts: HealthComputedCounts | null;
  /**
   * #2211 — user ids of the lane's default team, in team order. The first
   * eligible member is pre-assigned to new cards and children (#2206 G).
   * Optional: absent on the public share.
   */
  default_team?: number[];
  /**
   * #2211 — the same team as `{id, is_active}`, so a deactivated member is
   * shown, never pre-assigned, and removed before the team can be saved.
   * Optional: absent on the public share.
   */
  default_team_members?: SwimlaneTeamMemberState[];
}

/** One `Swimlane.default_team_members` entry (#2211). */
export interface SwimlaneTeamMemberState {
  id: number;
  is_active: boolean;
}

/** `GET /boards/{b}/swimlanes/{id}/default-team-access/` (#2211, admins). */
export interface SwimlaneDefaultTeamAccess {
  members: { id: number; boards: { id: number; name: string }[]; hidden_count: number }[];
}

export type SwimlaneLimitEnforcement = "block" | "hard";

/**
 * Swimlane shape served to unauthenticated share-link visitors
 * (`PublicSwimlaneSerializer`, nested on `BoardPublic.swimlanes`, #1140,
 * #1296). Deliberately narrower than `Swimlane`, not a partial view of it:
 * `contact_email`, `notes`, and `custom_field_values` are never present, not
 * merely hidden, because a share-link visitor is unauthenticated and the
 * board owner may not know who they are — the same reasoning
 * `PublicCard` applies to card values. Previously `BoardPublic.swimlanes`
 * was mistyped as the wider `Swimlane[]`, which the array-item-type check
 * added in #1296 (`scripts/check-serializer-ts-parity.py`) now catches.
 */
export interface PublicSwimlane {
  id: number;
  uid: string;
  name: string;
  position: number;
  color: string;
  is_collapsed: boolean;
  created_at: string;
}

export interface Label {
  id: number;
  uid: string;
  name: string;
  color: string;
}

export type Priority = "low" | "medium" | "high" | "urgent";

export type CustomFieldType =
  | "text"
  | "number"
  | "date"
  | "dropdown"
  | "checkbox"
  // #1390. Text-backed and validated server-side as an absolute http(s) URL.
  // Code that switches on this union must keep a default branch that renders
  // the raw value as text — a newer server may send a type this build lacks.
  | "url"
  // #1391. Several of `choices` at once. Still a string on the wire: a
  // canonical JSON array string (`'["a","b"]'`), parsed with
  // `parseMultiSelect` in utils/customFieldValue.ts.
  | "multi_select";

/**
 * A board's declaration of one typed custom field (#371). Mirrors
 * `CustomFieldDefinitionSerializer`; arrives with the board on `/full/`.
 */
export interface CustomFieldDefinition {
  id: number;
  uid: string;
  name: string;
  field_type: CustomFieldType;
  /** Permitted values; non-empty only when `field_type` is `"dropdown"` or `"multi_select"`. */
  choices: string[];
  /** Display order within the board. Changed only via the reorder endpoint. */
  position: number;
  /** Pin this field's value to the card face. At most 2 per board. */
  show_on_card: boolean;
  /**
   * Read-only (#2202): true when any card, archived cards included, holds a
   * value for this field, so the server refuses a `field_type` change.
   * Optional because a payload from a server before 1.3 does not carry it.
   */
  has_values?: boolean;
  /** Declared but not enforced in v1 — see the serializer. */
  is_required: boolean;
  help_text: string;
  /** Display-only text shown before a number value, e.g. `"$"` (#1391). `""` = none. Never stripped. */
  number_prefix: string;
  /** Display-only text shown after a number value, e.g. `" h"` (#1391). `""` = none. Never stripped. */
  number_suffix: string;
  /** Fixed decimal places (0-10) for display; `null` = show the number as typed (#1391). */
  number_decimals: number | null;
  /**
   * Per-choice display color (#1391): `{choice text: color}` — keys are a
   * subset of `choices`; each value is a `CHOICE_COLOR_KEYS` key or, since
   * #2096, a custom upper-case `#RRGGBB`. Read it through `resolveChoiceColor`.
   * `{}` when none is set; a choice with no entry renders with its automatic dot.
   */
  choice_colors: Record<string, string>;
  /**
   * Threshold marking (#1122): `""` = off. `"above"` marks a value at or over
   * a threshold, `"below"` one at or under it. Card fields only; display-only.
   */
  threshold_direction: ThresholdDirection;
  /** Number fields: warning / alert threshold (finite), `null` = unset. */
  threshold_warn: number | null;
  threshold_alert: number | null;
  /** Date fields: signed day offset from today in the viewer's timezone (`-3` = 3 days ago), `null` = unset. */
  threshold_warn_days: number | null;
  threshold_alert_days: number | null;
  created_at: string;
  /** #1921 — a dropdown whose choices resolve to a `DimensionResolution`; tracks are dimensions. */
  is_dimension?: boolean;
  /** #1921 — `{choice: resolution}`, keys a subset of `choices`; `{}` on non-dimensions. */
  choice_resolutions?: Record<string, DimensionResolution>;
}

/** `CustomFieldDefinition.threshold_direction` (#1122). `""` = thresholds off. */
export type ThresholdDirection = "" | "above" | "below";

/**
 * One card's value for one definition (#371). Every type is carried as a
 * string: numbers as written, dates as `YYYY-MM-DD`, checkboxes as
 * `"true"` / `"false"`, multi-selects as a JSON array string (#1391). A field with no value has no entry at all rather than
 * an entry holding `""`.
 *
 * The same shape is accepted on a card PATCH, so the representation the client
 * receives can be sent straight back; sending `""` clears a field.
 */
export interface CustomFieldValue {
  /** `CustomFieldDefinition.id` — look the schema up in `BoardFull`. */
  field_definition: number;
  value: string;
}

/**
 * The definition subset the value display, input, and formatting helpers
 * actually read. Satisfied by both `CustomFieldDefinition` (#371) and
 * `SwimlaneCustomFieldDefinition` (#1140), so those helpers work on either
 * without being made generic or duplicated.
 */
export interface FieldDefinitionShape {
  name: string;
  field_type: CustomFieldType;
  choices: string[];
  help_text: string;
  /**
   * #1391 number formatting. Optional in this *shape* only — both full
   * definition interfaces declare them — so a helper given a partial
   * definition renders the number exactly as typed.
   */
  number_prefix?: string;
  number_suffix?: string;
  number_decimals?: number | null;
  /** #1391 per-choice colors; optional here for the same reason as the number options. */
  choice_colors?: Record<string, string>;
  /**
   * #1122 threshold marking. Optional here — only card-field definitions
   * declare them (swimlane fields have no thresholds) — and absent means off.
   */
  threshold_direction?: ThresholdDirection;
  threshold_warn?: number | null;
  threshold_alert?: number | null;
  threshold_warn_days?: number | null;
  threshold_alert_days?: number | null;
}

/**
 * A board's declaration of one typed field on swimlane *rows* (#1140). Mirrors
 * `SwimlaneCustomFieldDefinitionSerializer`; arrives with the board on
 * `/full/` as `swimlane_custom_field_definitions`.
 *
 * Deliberately a separate set from `CustomFieldDefinition`: card fields and row
 * fields are independent per-board schemas with their own caps, their own
 * endpoints, and their own uniqueness, so a board may legitimately define a
 * card field and a row field with the same name. Reuses `CustomFieldType`
 * rather than declaring a second union — there is one type system.
 */
export interface SwimlaneCustomFieldDefinition {
  id: number;
  uid: string;
  name: string;
  field_type: CustomFieldType;
  /** Permitted values; non-empty only when `field_type` is `"dropdown"` or `"multi_select"`. */
  choices: string[];
  /** Display order within the board. Changed only via the reorder endpoint. */
  position: number;
  /** Legacy pin flag (at most 8 per board, server-enforced). Kept in the API (1.0 contract)
   *  but no longer read or written by the UI: the swimlane band shows fields by order (#2303). */
  show_on_row: boolean;
  /**
   * When true (the default), this field's values are served only to board
   * admins — members and viewers receive the swimlane without them. Not a
   * rendering hint: the value is absent from the payload, so there is nothing
   * to hide client-side.
   */
  is_admin_only: boolean;
  /** Declared but not enforced in v1 — see the serializer. */
  is_required: boolean;
  help_text: string;
  /** Display-only text shown before a number value, e.g. `"$"` (#1391). `""` = none. Never stripped. */
  number_prefix: string;
  /** Display-only text shown after a number value, e.g. `" h"` (#1391). `""` = none. Never stripped. */
  number_suffix: string;
  /** Fixed decimal places (0-10) for display; `null` = show the number as typed (#1391). */
  number_decimals: number | null;
  /**
   * Per-choice display color (#1391): `{choice text: color}` — keys are a
   * subset of `choices`; each value is a `CHOICE_COLOR_KEYS` key or, since
   * #2096, a custom upper-case `#RRGGBB`. Read it through `resolveChoiceColor`.
   * `{}` when none is set; a choice with no entry renders with its automatic dot.
   */
  choice_colors: Record<string, string>;
  /**
   * Where the field shows on a lane band (#2439): `null` = derived from position (every
   * pre-1.3 row). Read it through `resolveLaneTiers`, never directly: a board whose rows are
   * all `null` keeps the pre-1.3 band, and a `null` row on a tiered board is never Band.
   * Optional only so that a payload from a pre-#2439 server (mid rolling deploy) still types;
   * absent reads exactly like `null`. The serializer always sends it.
   */
  band_visibility?: LaneTier | null;
  created_at: string;
}

/** A swimlane field's tier on the lane band (#2439). */
export type LaneTier = "band" | "details" | "hidden";

/**
 * One swimlane's value for one row-field definition (#1140). Same string
 * carriage as `CustomFieldValue`, and the same "no entry rather than an empty
 * entry" rule for an unset field.
 */
export interface SwimlaneCustomFieldValue {
  /** `SwimlaneCustomFieldDefinition.id` — schema is on `BoardFull`. */
  field_definition: number;
  value: string;
}

/** One end of a card relation, as returned by `getCardRelations()` (#449). */
export interface RelatedCardRef {
  id: number;
  uid: string;
  title: string;
  /** Column id, so the caller can show where the linked card currently sits. */
  column: number;
  /**
   * True when the linked card has been archived. Such a relation is still
   * listed (flagged) rather than hidden, so a link left dangling by an archive
   * is visible enough to remove. Archived blockers do NOT count toward
   * `Card.blocker_count`.
   */
  archived: boolean;
}

/** The two relation types storable in v1. `duplicates` is deferred. */
export type CardRelationType = 'blocks' | 'relates_to';

/**
 * A relation stated from the point of view of one card. This — not
 * `CardRelationType` — is what the create endpoint takes, because "X blocks
 * this card" has to be expressible from this card's panel.
 */
export type CardRelationDirection = 'blocks' | 'blocked_by' | 'relates_to';

/**
 * A relation resolved to the point of view of the card it was fetched for
 * (#449). The backend stores one canonical direction per relation and derives
 * the inverse at read time, so the same relation `id` appears as `blocks` from
 * one card and `blocked_by` from the other.
 */
export interface CardRelation {
  id: number;
  relation_type: CardRelationType;
  direction: CardRelationDirection;
  card: RelatedCardRef;
  created_at: string;
}

/**
 * Machine-checkable `code` slugs on a 400 from the relations endpoint. The
 * frontend maps these to copy rather than string-matching `detail`.
 */
export type CardRelationErrorCode =
  | 'self_relation'
  | 'cross_board'
  | 'archived_card'
  | 'relation_exists'
  | 'relation_cycle';

export interface CardChecklistItem {
  id: number;
  text: string;
  is_checked: boolean;
  position: number;
  created_by: BoardUser | null;
  /** #445: the item's assignee (nested read). Writes send `assignee_id`, a write-only
   *  serializer field limited server-side to assignable members; it is never in a response. */
  assignee: BoardUser | null;
  /** #445: `YYYY-MM-DD`, or null. Feeds only the checklist face suffix, never card urgency. */
  due_date: string | null;
}

export interface CardAttachment {
  id: number;
  filename: string;
  size: number;
  url: string;
  uploaded_by: BoardUser | null;
  uploaded_at: string;
}

/** Forge an external ref points at (#352). `other` covers any non-GitLab/GitHub host. */
export type ExternalRefProvider = 'gitlab' | 'github' | 'other';

/**
 * A card's link to a merge request / pull request (#352). Stable public API
 * contract — the enterprise auto-link integration reads and writes this exact
 * shape. `url` is validated server-side to http/https only, but the client
 * still re-checks it with `isHttpUrl()` before rendering it as an `href`.
 */
export interface CardExternalRef {
  provider: ExternalRefProvider;
  /** Freeform display ref, e.g. `owner/repo#123` or `group/project!45`. */
  ref: string;
  url: string;
}

export interface Card {
  id: number;
  uid: string;
  column: number;
  swimlane: number;
  title: string;
  description: string;
  priority: Priority;
  assignee: BoardUser | null;
  labels: Label[];
  due_date: string | null;
  weight: number;
  position: number;
  created_by: BoardUser | null;
  created_at: string;
  updated_at: string;
  last_moved_at: string | null;
  /** True when the newest movement is the card's creation, not a move (#1576).
   *  Optional: absent in payloads that predate the field; treat as false. */
  last_move_is_creation?: boolean;
  /** Start of the card's open visit to its column (#459), the dwell overlay's clock.
   *  Null for a card in a done column or with no measured visit; never reset by a
   *  swimlane-only move, so it is not `last_moved_at`. Optional: absent in payloads
   *  that predate the field. */
  column_entered_at?: string | null;
  attachment_count: number;
  checklist_total: number;
  checklist_done: number;
  /** #445: sorted `YYYY-MM-DD` due dates of unchecked checklist items. The face
   *  derives "overdue" in the viewer's timezone. Optional: absent in payloads
   *  that predate the field (cached boards, older servers); treat as []. */
  checklist_open_due_dates?: string[];
  /** #445: assignee ids of unchecked checklist items, one per item. The face
   *  derives "mine" for the viewer. Optional for the same reason; treat as []. */
  checklist_open_assignee_ids?: number[];
  is_stale: boolean;
  archived_at: string | null;
  version: number;
  custom_field_values: CustomFieldValue[];
  /**
   * Number of active (non-archived) cards blocking this one (#449). Drives the
   * card-face blocked indicator. Only the `blocks` relation type counts, and
   * only in the direction where this card is the blocked end — `relates_to`
   * never contributes. The relation *list* is deliberately not on this
   * interface: it is served by `getCardRelations()` when the detail panel
   * opens, so a board payload carries one integer per card rather than an
   * array.
   */
  blocker_count: number;
  /**
   * MR/PR link (#352), or null when the card has none. Required, like every
   * other serializer field: the backend always emits the key.
   */
  external_ref: CardExternalRef | null;
  /**
   * True when the card is blocked manually (`blocked_at` set) or by at least
   * one active `blocks` relation (`blocker_count > 0`) (#1149). Server-derived;
   * prefer `isCardBlocked()` on the client, which recomputes it from the two
   * sources so an optimistic `blocker_count` change is reflected at once.
   */
  is_blocked: boolean;
  /** When the open manual block started, or null when not manually blocked (#1149). */
  blocked_at: string | null;
  /** The open manual block's reason; `""` when not manually blocked (#1149). */
  blocked_reason: string;
  /** Gated stages (#1102): index of the card's sub-column in `column.sub_columns`; 0 on a plain column. */
  gates_passed?: number;
  /**
   * This card's parent, resolved for the viewer (#1104, since 1.3). `null` = no
   * parent. Present only on `/full/`, the card list, retrieve and `archived/`;
   * absent (`undefined`) from write responses and every `card.*` frame, so a
   * store that replaces a card wholesale must carry the last value read over.
   */
  parent?: CardParent | null;
  /**
   * Progress of this card's children, resolved for the viewer (#2210, since 1.3).
   * Present only on a parent-tier board's `/full/`, card list and retrieve;
   * absent from write responses, frames and share links, so a store that
   * replaces a card wholesale carries the last value over (like `parent`).
   */
  children_rollup?: CardChildrenRollup;
}

/** Child progress when the viewer can open the child board (#2210). States partition `total`. */
export interface CardChildrenRollupVisible {
  visible: true;
  total: number;
  done: number;
  doing: number;
  todo: number;
  blocked: number;
  last_moved_at: string | null;
}

/** Children on a board the viewer cannot open: the count only (#2210). */
export interface CardChildrenRollupHidden {
  visible: false;
  total: number;
}

export type CardChildrenRollup = CardChildrenRollupVisible | CardChildrenRollupHidden;

/** A parent card the viewer can open (#1104). */
export interface CardParentVisible {
  hidden: false;
  id: number;
  title: string;
  board_id: number;
  board_name: string;
  column_id: number;
  column_name: string;
  swimlane_id: number;
  swimlane_name: string;
  archived: boolean;
  /** What the parent's board calls its cards (#2212), raw; "" means "Parent". Use `parentItemNames`. */
  board_parent_name_singular: string;
  /**
   * The parent's live children on THIS card's board, this card included (#2443, since 1.3):
   * "2 of 5 siblings done". Computed for the viewer over this board only; null when the
   * viewer holds no role here. Optional: absent from responses of servers before #2443.
   */
  siblings_total?: number | null;
  /** How many of `siblings_total` are done: in a done column and not blocked, the rollup's rule (#2443). */
  siblings_done?: number | null;
}

/** A parent card on a board the viewer cannot open: no other key is sent (#1104). */
export interface CardParentHidden {
  hidden: true;
}

export type CardParent = CardParentVisible | CardParentHidden;

/** A row of `GET /boards/{id}/parent-boards/` (#1104). */
export interface ParentBoardOption {
  id: number;
  name: string;
  /** What this board calls one of its cards (#2212), raw; "" means "Parent". */
  parent_name_singular: string;
  /** What this board calls its cards, plural (#2212), raw; "" means "Parents". */
  parent_name_plural: string;
}

/** Closed field types of a card-detail extension section (#2212, experimental). */
export type CardExtensionFieldType = 'text' | 'number' | 'date' | 'choice';

/** One read-only field of a card-detail extension section (#2212). */
export interface CardExtensionField {
  key: string;
  label: string;
  type: CardExtensionFieldType;
  value: string | number | null;
  display?: string;
  choices?: string[];
}

/** One extension's section, `GET /boards/{b}/cards/{c}/extensions/` (#2212). */
export interface CardExtensionSection {
  id: string;
  title: string;
  fields: CardExtensionField[];
}

/** `GET /boards/{b}/cards/{c}/extensions/` (#2212). */
export interface CardExtensionSectionList {
  sections: CardExtensionSection[];
}

/** A row of `GET /boards/{b}/cards/{id}/parent-candidates/` (#1104). */
export interface ParentCandidate {
  id: number;
  title: string;
  column_id: number;
  column_name: string;
  swimlane_id: number;
  swimlane_name: string;
  assignee: BoardUser | null;
  disabled_reason: "children_on_other_board" | "children_limit" | null;
  children_board_name: string | null;
}

/** A row of `GET /boards/{b}/cards/{id}/child-candidates/`: Link existing (#2209). */
export interface ChildCandidate {
  id: number;
  title: string;
  column_id: number;
  column_name: string;
  swimlane_id: number;
  swimlane_name: string;
  assignee: BoardUser | null;
  disabled_reason: "link_exists" | "already_has_parent" | "parent_archived" | "children_limit" | null;
  /** For `already_has_parent`: that parent's title when the viewer can open its board, else null. */
  parent_title: string | null;
}

/** One child in `GET /boards/{b}/cards/{id}/children/` when the viewer can open the child board (#1104, #2209). */
export interface CardChildRow {
  id: number;
  title: string;
  board_id: number;
  column_id: number;
  column_name: string;
  swimlane_id: number;
  swimlane_name: string;
  archived: boolean;
  position: number;
  assignee: BoardUser | null;
  blocked: boolean;
  blocked_at: string | null;
  /** Since 1.3 (#2209): the child board's own card face (priority, due date, labels). */
  priority: Priority;
  due_date: string | null;
  labels: Pick<Label, "id" | "name" | "color">[];
}

/** A column of the child board, with the count of its whole column (#2209). */
export interface CardChildrenColumn {
  id: number;
  name: string;
  color: string;
  wip_limit: number | null;
  is_done: boolean;
  card_count: number;
}

/** The children read (#1104). `board` is sent only when `visible` (#2209). */
export interface CardChildrenRead {
  count: number;
  visible: boolean;
  offset: number;
  limit: number;
  results: CardChildRow[];
  board?: {
    id: number;
    name: string;
    role: BoardRole | "site_admin";
    /** Since 1.3 (#2209): the child board's WIP mode, which the Move picker honors. */
    enforce_wip_limits: boolean;
    enforce_wip_hard: boolean;
    columns: CardChildrenColumn[];
  };
}

/** `board_total` of `GET /boards/{id}/children-view/` (#2370): children you can open, plus `hidden`. */
export interface ChildrenViewTotals {
  /** Not done: to do, doing and blocked. */
  in_progress: number;
  total: number;
  blocked: number;
  /** Live children on boards you can't open: a count only. */
  hidden: number;
}

/** One lane's rollup in Children mode (#2370). States count only children you can open. */
export interface ChildrenViewLane extends ChildrenViewTotals {
  id: number;
  name: string;
  position: number;
  /** Parent rows in the lane, locked rows included. */
  parents: number;
  /** Distinct child boards you can open under this lane. */
  child_boards: number;
  done: number;
  doing: number;
  todo: number;
  /** Parents you can open with nothing in progress. */
  folded: number;
}

/** A compact child card in a Children mode row (#2370). */
export interface ChildrenViewChild {
  id: number;
  title: string;
  column_id: number;
  swimlane_id: number;
  position: number;
  state: 'todo' | 'doing' | 'blocked' | 'done';
  assignee: BoardUser | null;
  blocked: boolean;
  blocked_at: string | null;
}

/** One parent row in Children mode (#2370). A locked row has a hidden rollup and no children. */
export interface ChildrenViewRow {
  id: number;
  title: string;
  swimlane_id: number;
  column_id: number;
  column_name: string;
  assignee: BoardUser | null;
  rollup: CardChildrenRollup;
  /** Null for a locked row (a child board you can't open). */
  in_progress: number | null;
  /** Nothing in progress; always false for a locked row. */
  folded: boolean;
  /** Null for a locked row. */
  child_board_id: number | null;
  children: ChildrenViewChild[];
}

/** A child board you can open that the page's rows draw (#2370). */
export interface ChildrenViewBoard {
  id: number;
  name: string;
  role: BoardRole | 'site_admin';
  enforce_wip_limits: boolean;
  enforce_wip_hard: boolean;
  columns: CardChildrenColumn[];
}

/** `GET /boards/{id}/children-view/?lane=&cursor=&done=` (#2370, since 1.3). */
export interface ChildrenView {
  board_total: ChildrenViewTotals;
  lanes: ChildrenViewLane[];
  rows: ChildrenViewRow[];
  child_boards: ChildrenViewBoard[];
  next_cursor: string | null;
}

/** One manual block of a card, from `GET .../cards/{id}/blocks/` (#1149). */
export interface CardBlock {
  id: number;
  blocked_at: string;
  blocked_by: BoardUser | null;
  reason: string;
  /** null while the block is still open. */
  unblocked_at: string | null;
  unblocked_by: BoardUser | null;
  resolution: string;
  /** The column the card was in when it was blocked (name kept after a delete). */
  column_name: string;
  column_uid: string;
  /** Measured to `unblocked_at`, or to the server's now while open. */
  duration_seconds: number;
  /** See `CardMovement.imported_from_username` (#1675). */
  imported_from_username: string | null;
}

export interface Notification {
  id: number;
  verb: string;
  /**
   * The user whose action triggered this notification (#1007). Null when the
   * notification has no human author (system-generated stale-card alerts).
   * Slim user shape — id, username, display_name, avatar_url only.
   */
  actor: BoardUser | null;
  card_id: number | null;
  card_title: string | null;
  board_id: number | null;
  board_name: string | null;
  // Backend enforces blank=False with ActionType choices — '' is not a valid value post-migration 0041.
  action_type: 'assigned' | 'mentioned' | 'card_moved' | 'stale' | 'board_invite' | 'due_soon' | 'comment_added' | 'webhook_disabled';
  /**
   * Where a `mentioned` notification's @mention lives (#2203, since 1.3), so
   * the link can open the tab that holds it. Null for every other action type
   * and for mentions recorded before 1.3, whose links stay tab-less.
   */
  mention_source: NotificationMentionSource | null;
  read: boolean;
  created_at: string;
}

export type NotificationMentionSource = 'comment' | 'description';

// ─── Outbound webhooks (#863) ───────────────────────────────────────────────
// Mirrors webhooks/serializers.py. The full URL and the signing secret are
// never on this shape: they appear once, on WebhookCreateResponse /
// WebhookRotateResponse, and the UI must drop them from state on Done.

/** Why a subscription is off. The field is null while it is enabled. */
export type WebhookDisabledReason =
  | 'manual'
  | 'failures'
  | 'cursor_expired'
  | 'creator_lost_access'
  | 'secret_unavailable';

/**
 * A webhook's creator or owner (#2068): `BoardUser` plus `is_site_admin`.
 * Only the webhook serializer carries the flag; `BoardUser` elsewhere does not.
 */
export interface WebhookUser extends BoardUser {
  is_site_admin: boolean;
}

export interface WebhookSubscription {
  id: number;
  board: number;
  name: string;
  /** `host/…/last4` — never the rest of the URL. */
  url_display: string;
  url_host: string;
  /** Empty = every subscribable type, including types added later. */
  event_types: string[];
  enabled: boolean;
  disabled_reason: WebhookDisabledReason | null;
  disabled_at: string | null;
  last_delivered_event_id: number;
  consecutive_failures: number;
  failing_since: string | null;
  next_attempt_at: string | null;
  last_attempt_at: string | null;
  last_success_at: string | null;
  /** '' or one of connection_failed | tls_error | timeout | http_error. */
  last_error_code: string;
  last_status_code: number | null;
  created_by: WebhookUser | null;
  /** The owner whose board-admin standing keeps the webhook delivering. */
  configured_by: WebhookUser | null;
  created_at: string;
  updated_at: string;
  configured_at: string | null;
  secret_rotated_at: string | null;
  /** When the replaced secret stops signing; null when no rotation overlap is open. */
  previous_secret_expires_at: string | null;
}

/** `POST /boards/{id}/webhooks/` — the only response carrying `url` and `secret`. */
export interface WebhookCreateResponse extends WebhookSubscription {
  url: string;
  secret: string;
}

/** `POST /boards/{id}/webhooks/{id}/rotate/` — the new secret, once. */
export interface WebhookRotateResponse extends WebhookSubscription {
  secret: string;
}

/** `GET /boards/{id}/webhooks/status/`. */
export interface WebhookStatus {
  enabled: boolean;
  dispatcher_last_run_at: string | null;
  dispatcher_stale: boolean;
  /** The event-type picker's only source of options. */
  subscribable_event_types: string[];
  /** Consecutive failures that turn a webhook off. */
  disable_after_failures: number;
  /** How long a delivery or test event waits for an answer. */
  test_timeout_seconds: number;
}

/** `POST /boards/{id}/webhooks/{id}/test/`. */
export interface WebhookTestResult {
  ok: boolean;
  /** null on success. */
  code: string | null;
  status_code: number | null;
  /** Time to the receiver's status line; null when nothing answered. */
  latency_ms: number | null;
}

export interface CardMovement {
  id: number;
  /** Identifies the card this movement belongs to — useful in board-level history lists. */
  card_uid: string;
  card_title: string;
  // The four *_name fields are denormalized CharFields on CardMovement, kept so
  // history still reads correctly after a column or swimlane is deleted. Like
  // the *_uid fields below they are `null=False, blank=True, default=""` on the
  // model, so the API returns "" — never null — when there is no origin (#1139).
  // Every consumer already tests them for truthiness, which treats "" the same.
  from_column: number | null;
  from_column_name: string;
  // Backend CardMovementSerializer returns "" (not null) for missing FK UIDs.
  from_column_uid: string;
  to_column: number | null;
  to_column_name: string;
  to_column_uid: string;
  from_swimlane: number | null;
  from_swimlane_name: string;
  from_swimlane_uid: string;
  to_swimlane: number | null;
  to_swimlane_name: string;
  to_swimlane_uid: string;
  moved_by: BoardUser | null;
  moved_at: string;
  notes: string;
  movement_type: "move" | "archived" | "unarchived";
  /**
   * Set only on a row created by a board import with history (#1675):
   * `moved_by` is then the importer and this is the username the import file
   * named (`""` when it named nobody). `null` on every other row, including
   * history imported by earlier versions (the original name was not kept).
   */
  imported_from_username: string | null;
  /** #1102 — gate position at each end; null where that column is not a gated stage. Left with gates open = `from_gates_open > 0`. */
  from_gates_passed?: number | null;
  from_gates_open?: number | null;
  to_gates_passed?: number | null;
}

export type CardActivityEventType =
  | "title_change"
  | "priority_change"
  | "weight_change"
  | "assignee_change"
  | "label_change"
  | "description_change"
  | "comment_added"
  | "attachment_added"
  | "attachment_deleted"
  | "checklist_item_added"
  | "checklist_item_checked"
  | "checklist_item_unchecked"
  | "checklist_item_deleted"
  // #445: from/to are usernames (assigned) and ISO dates (due changed).
  | "checklist_item_assigned"
  | "checklist_item_due_changed"
  | "due_date_change"
  // Manual block state (#1149): `blocked` carries the reason in to_value;
  // `unblocked` the reason in from_value and the resolution in to_value.
  | "blocked"
  | "unblocked"
  | "custom_field_changed"
  // Cross-board parent/child link (#1104): from/to are blank; the row never
  // names the other card, which may be on a board the reader cannot open.
  | "parent_linked"
  | "parent_unlinked"
  | "child_linked"
  | "child_unlinked"
  // #2208: the other end's whole board was deleted. On the parent's row
  // to_value is how many children it lost; no board name is ever stored.
  | "children_removed_board_deleted"
  | "parent_removed_board_deleted";

export interface CardActivity {
  id: number;
  event_type: CardActivityEventType;
  from_value: string;
  to_value: string;
  actor: BoardUser | null;
  created_at: string;
  /** See `CardMovement.imported_from_username` (#1675). */
  imported_from_username: string | null;
  /**
   * The checklist item's text on `checklist_item_assigned` and
   * `checklist_item_due_changed` rows (#2199), and the custom field's name on
   * `custom_field_changed` rows (#1921); null on other rows and on rows
   * recorded before 1.3. Optional so fixtures from older servers still type.
   */
  item_text?: string | null;
}

export interface CardTimelineEntry {
  id: number;
  /**
   * `gate` since 1.3 (#2365): a gate of a split stage passed or reopened
   * without a movement (a move between sub-columns, a stage-settings remap);
   * `data` is then a `CardGateTransition`. Skip a kind you do not know.
   */
  kind: "move" | "activity" | "gate";
  ts: string;
  actor: BoardUser | null;
  event_type: string;
  data: Record<string, unknown>;
  /** See `CardMovement.imported_from_username` (#1675). */
  imported_from_username: string | null;
}

export interface CardComment {
  id: number;
  author: BoardUser | null;
  body: string;
  created_at: string;
  updated_at: string;
  /**
   * Set only on a comment created by an import (#1702): `author` is then the
   * importing user and this is the author name the source named (`""` when
   * it named nobody). `null` for a comment posted on this board. Render it
   * through `utils/importedHistory.ts`, never as a user.
   */
  imported_from_username: string | null;
}

export interface GroupBrief {
  id: number;
  name: string;
  parent: number | null;
  parent_name: string | null;
  // Root-first ancestor chain (excluding the group itself). Added by
  // GroupBriefSerializer when the caller requests ?expand=group (#845).
  ancestors?: { id: number; name: string }[];
}

export interface Board {
  id: number;
  uid: string;
  name: string;
  description: string;
  owner: BoardUser;
  group: number | null;
  group_name: string | null;
  group_detail?: GroupBrief | null;
  member_count: number;
  /** Active (non-archived) cards only (#693). */
  card_count: number;
  /**
   * Archived cards on the board (#1289). Deleting a board cascades to these, so
   * the delete confirmations gate typed-name confirmation on
   * card_count + archived_card_count, not card_count alone.
   */
  archived_card_count: number;
  staleness_threshold_days: number;
  stale_warning_pct: number;
  /** @deprecated No effect (#1429); stored and returned for API compatibility, card priorities are not restricted by it. */
  allowed_priorities: Priority[];
  enforce_wip_limits: boolean;
  enforce_wip_hard: boolean;
  enforce_weight_limits: boolean;
  show_wip_at_limit: boolean;
  /** #1418 — when false, swimlane row chips show field values without the `{name}:` label. */
  show_row_chip_field_names: boolean;
  /** #2439 — the most swimlane fields a lane's "Show N more" details hold (4, 6, 9, 12 or 16; default 6). */
  lane_details_cap: number;
  export_min_role: BoardExportMinRole;
  card_density: CardDensity;
  is_starred: boolean;
  created_at: string;
  updated_at: string;
  /**
   * Health status (#1133). `health_status` is this entity's own value (null =
   * inherit); `effective_health_status` is what applies (own value, else the
   * nearest ancestor group's, else null); `health_status_source` names that
   * ancestor group, and is null when the value is set here or nothing applies.
   */
  health_status: HealthStatus | null;
  effective_health_status: HealthStatus | null;
  health_status_source: HealthStatusSource | null;
  /**
   * Last set or confirm of this entity's own `health_status` (#2242), read-only:
   * written by the explicit `POST .../health-status/` action (and by a PATCH
   * that changes the value). All three are null when never recorded; a null
   * `health_status_changed_by` with a timestamp is a removed account or a
   * system change. Render the attribution only with `healthSetLine`.
   */
  health_status_changed_at: string | null;
  health_status_changed_by: BoardUser | null;
  health_status_note: string | null;
  /**
   * #2244 — "review status every N days" (1-365), or null for off. Writable
   * by whoever may change this entity's settings.
   */
  health_review_days: number | null;
  /**
   * #2244 — when the status shown is due for review: the owner's
   * `health_status_changed_at` plus the owner's `health_review_days` (the
   * owner is this entity when it sets its own value, else the
   * `health_status_source` group). Null when off, unset, or never recorded.
   * A fixed timestamp, so every payload, including WebSocket frames, carries
   * the same due time. The cue updates on the next render or refresh, not on
   * a timer; render with `healthReviewCue`.
   */
  health_review_due_at: string | null;
  /** #1146 — the board's default preset id, or null for none. Board admins write it with `patchBoard`. */
  default_preset: BoardPresetId | null;
  /** #2245 — compute this board's health from its lanes' cards; default false. Board admins write it with `patchBoard`. */
  health_auto_enabled: boolean;
  /**
   * #2245 — an ABSOLUTE count of flagged cards in one lane (not a share): at
   * least 1 flagged is at risk, at least this many is off track. Default 3, minimum 1.
   */
  health_off_track_cards: number;
  /** #2245 — the computed board status (worst lane), readable while pinned; null when auto is off or never computed. */
  computed_health_status: HealthStatus | null;
  /** #2245 — when the auto status was last computed; null = never computed. */
  health_computed_at: string | null;
  /** #2245 — open-card counts summed over the lanes; null when never computed. */
  health_computed_counts: HealthComputedCounts | null;
  /** #2245 — where `effective_health_status` comes from. */
  health_status_origin: BoardHealthStatusOrigin | null;
  /**
   * #2275 — id of the card number field each swimlane band sums over the
   * lane's cards not in a done column, or null for no rollup. A field retyped
   * away from number keeps its id here; the band hides the rollup then.
   */
  swimlane_rollup_field: number | null;
  /**
   * #2050 — uid of the column where cycle time and WIP age start (the
   * commitment point), or null for the flow-metric ADR's default (the first
   * move out of the creation column). A uid that no longer names a not-done
   * column of the board reads as unset.
   */
  commitment_column_uid: string | null;
  /**
   * #2208 — true when cards on this board can have child cards on another
   * board (a parent-tier board); false (the default) means a child-tier board.
   * Readable by every member; only a board admin can change it.
   */
  cards_can_have_children: boolean;
  // #2208: where Add child creates a new child card (id only, never a name), or null to ask.
  default_child_board: number | null;
  /** What a parent card on this board is called (#2212), raw; "" means "Parent". */
  parent_name_singular: string;
  /** Plural of `parent_name_singular` (#2212), raw; "" means "Parents". */
  parent_name_plural: string;
}

/**
 * Ids of the code-defined board presets (#1146); `boardPresets/registry.ts` holds
 * the definitions. Mirrors `BoardPresetId` in `backend/boards/models.py`.
 */
export type BoardPresetId = "classic" | "default";

/** Open-card counts behind an auto health status (#2245); `flagged` counts a card once. */
export interface HealthComputedCounts {
  open: number;
  overdue: number;
  stale: number;
  blocked: number;
  flagged: number;
}

/** Where a board's effective health status comes from (#2245). */
export type BoardHealthStatusOrigin = "manual" | "computed" | "inherited";

/** Where a lane's effective health status comes from (#2245); lanes never inherit. */
export type SwimlaneHealthStatusOrigin = "manual" | "computed";

/** Board and group health values (#1133); `null` on the wire means inherit / none. */
export type HealthStatus = "on_track" | "at_risk" | "off_track";

/** The ancestor group that supplies an inherited health status (#1133). */
export interface HealthStatusSource {
  id: number;
  name: string;
  /** When the source group's own status was last set (#2242); null if never recorded. */
  changed_at: string | null;
}

/** One row of `GET .../health-history/` (#2242). `from_status === to_status` is a reconfirm. */
export interface HealthStatusChange {
  from_status: HealthStatus | null;
  to_status: HealthStatus | null;
  /** Null: a removed account or a system change. */
  changed_by: BoardUser | null;
  changed_at: string;
  note: string | null;
  /** #2245 — "computed" for an auto health change (`changed_by` null, `reason` says why). */
  kind: "manual" | "computed";
  /** #2245 — why a computed change happened; null on manual rows. */
  reason: string | null;
}

/** `GET .../health-history/` (#2242): newest first, at most 20; `has_more` when older rows exist. */
export interface HealthHistory {
  results: HealthStatusChange[];
  has_more: boolean;
}

export type BoardExportMinRole = "viewer" | "collaborator" | "member" | "admin";

/**
 * Canonical role aliases (#1006). Use these everywhere a "role" field is
 * declared so the union stays in lockstep across `Board`, `BoardMembership`,
 * `BoardFull.current_user_role`, and `Group.default_board_member_role`.
 *
 * - `BoardRole` — the four board-membership roles. Used for fields that can
 *   never be `site_admin` (e.g. `Group.default_board_member_role`).
 * - `BoardOrSiteRole` — adds `site_admin` for read paths where the
 *   requesting user might be a site admin without an explicit membership.
 *
 * `BoardExportLogEntry.actor_role_label` intentionally extends this union with
 * `owner` (frozen audit history); kept inline because that field is the only
 * place `owner` appears as a string value.
 */
export type BoardRole = "viewer" | "collaborator" | "member" | "admin";
export type BoardOrSiteRole = BoardRole | "site_admin";

/**
 * Per-board card layout density (#961). Drives how much metadata renders on
 * the card face. New boards default to ``comfortable``; existing boards were
 * migrated to ``dense`` so they keep their pre-1.1 visual.
 *
 * The middle tier is named ``standard`` rather than ``compact`` to avoid
 * colliding with the per-user *Card layout: Compact / Expanded* toolbar pref
 * (which controls 2-col single-line grid layout, not metadata density).
 */
export type CardDensity = "comfortable" | "standard" | "dense";

export interface BoardExportLogEntry {
  id: number;
  actor: BoardUser | null;
  /**
   * Frozen audit string capturing the actor's role at export time. Includes
   * "owner" and "site_admin" — values that `Board.export_min_role` does not
   * accept — so the field is named distinctly from `export_min_role` to keep
   * the two enums from being conflated (#980).
   */
  actor_role_label: "viewer" | "collaborator" | "member" | "admin" | "owner" | "site_admin";
  export_format: string;
  row_count: number;
  created_at: string;
}

export interface BoardFull {
  id: number;
  uid: string;
  name: string;
  description: string;
  owner: BoardUser;
  group: number | null;
  group_name: string | null;
  group_detail?: GroupBrief | null;
  columns: Column[];
  swimlanes: Swimlane[];
  cards: Card[];
  labels: Label[];
  members: EffectiveBoardMember[];
  custom_field_definitions: CustomFieldDefinition[];
  /** The board's swimlane-row field schema (#1140). Independent of the card schema above. */
  swimlane_custom_field_definitions: SwimlaneCustomFieldDefinition[];
  staleness_threshold_days: number;
  stale_warning_pct: number;
  /** @deprecated No effect (#1429); stored and returned for API compatibility, card priorities are not restricted by it. */
  allowed_priorities: Priority[];
  enforce_wip_limits: boolean;
  enforce_wip_hard: boolean;
  enforce_weight_limits: boolean;
  show_wip_at_limit: boolean;
  /** #1418 — when false, swimlane row chips show field values without the `{name}:` label. */
  show_row_chip_field_names: boolean;
  /** #2439 — the most swimlane fields a lane's "Show N more" details hold (4, 6, 9, 12 or 16; default 6). */
  lane_details_cap: number;
  export_min_role: BoardExportMinRole;
  card_density: CardDensity;
  is_starred: boolean;
  created_at: string;
  updated_at: string;
  current_user_role: BoardOrSiteRole | null;
  capabilities: { movement_export: boolean; [key: string]: boolean };
  /**
   * Health status (#1133), read-only here (written with `patchBoard`).
   * `health_status` is this entity's own value (null = inherit);
   * `effective_health_status` is what applies (own value, else the nearest
   * ancestor group's, else null); `health_status_source` names that
   * ancestor group, and is null when the value is set here or nothing applies.
   */
  health_status: HealthStatus | null;
  effective_health_status: HealthStatus | null;
  health_status_source: HealthStatusSource | null;
  /**
   * Last set or confirm of this entity's own `health_status` (#2242), read-only:
   * written by the explicit `POST .../health-status/` action (and by a PATCH
   * that changes the value). All three are null when never recorded; a null
   * `health_status_changed_by` with a timestamp is a removed account or a
   * system change. Render the attribution only with `healthSetLine`.
   */
  health_status_changed_at: string | null;
  health_status_changed_by: BoardUser | null;
  health_status_note: string | null;
  /**
   * #2244 — "review status every N days" (1-365), or null for off. Writable
   * by whoever may change this entity's settings.
   */
  health_review_days: number | null;
  /**
   * #2244 — when the status shown is due for review: the owner's
   * `health_status_changed_at` plus the owner's `health_review_days` (the
   * owner is this entity when it sets its own value, else the
   * `health_status_source` group). Null when off, unset, or never recorded.
   * A fixed timestamp, so every payload, including WebSocket frames, carries
   * the same due time. The cue updates on the next render or refresh, not on
   * a timer; render with `healthReviewCue`.
   */
  health_review_due_at: string | null;
  /** #1146 — the board's default preset id, or null for none. Read-only here (written with `patchBoard`). */
  default_preset: BoardPresetId | null;
  /** #2245 — compute this board's health from its lanes' cards; default false. Board admins write it with `patchBoard`. */
  health_auto_enabled: boolean;
  /**
   * #2245 — an ABSOLUTE count of flagged cards in one lane (not a share): at
   * least 1 flagged is at risk, at least this many is off track. Default 3, minimum 1.
   */
  health_off_track_cards: number;
  /** #2245 — the computed board status (worst lane), readable while pinned; null when auto is off or never computed. */
  computed_health_status: HealthStatus | null;
  /** #2245 — when the auto status was last computed; null = never computed. */
  health_computed_at: string | null;
  /** #2245 — open-card counts summed over the lanes; null when never computed. */
  health_computed_counts: HealthComputedCounts | null;
  /** #2245 — where `effective_health_status` comes from. */
  health_status_origin: BoardHealthStatusOrigin | null;
  /**
   * #2275 — id of the card number field each swimlane band sums over the
   * lane's cards not in a done column, or null for no rollup. A field retyped
   * away from number keeps its id here; the band hides the rollup then.
   */
  swimlane_rollup_field: number | null;
  /**
   * #2050 — uid of the column where cycle time and WIP age start (the
   * commitment point), or null for the flow-metric ADR's default (the first
   * move out of the creation column). A uid that no longer names a not-done
   * column of the board reads as unset.
   */
  commitment_column_uid: string | null;
  /**
   * #2208 — true when cards on this board can have child cards on another
   * board (a parent-tier board); false (the default) means a child-tier board.
   * Readable by every member; only a board admin can change it.
   */
  cards_can_have_children: boolean;
  // #2208: where Add child creates a new child card (id only, never a name), or null to ask.
  default_child_board: number | null;
  /** What a parent card on this board is called (#2212), raw; "" means "Parent". */
  parent_name_singular: string;
  /** Plural of `parent_name_singular` (#2212), raw; "" means "Parents". */
  parent_name_plural: string;

  /**
   * @deprecated Since 1.2, removed in 2.0 (#1935). Do not read it: the share
   * link is shown once, from the `enableBoardSharing` response
   * (`ShareActionResponse.share_token`). Use `share_link_active` to tell
   * whether a link is set. Kept here because the backend still sends it.
   */
  share_token: string | null;
  share_token_expires_at: string | null;
  /**
   * #1935 — whether the board has a share link set (it may have expired; see
   * `share_token_expires_at`). `false` for a stored link with no recorded
   * enabler, which does not resolve (#1939). Admin-only: `null` for lower roles.
   */
  share_link_active: boolean | null;
  /**
   * Archived cards on the board (#1289). `cards` above is active-only, but
   * deleting the board cascades to archived cards too, so the settings modal's
   * Danger Zone reads this. Kept current in-session by useBoard's archive /
   * unarchive handlers.
   */
  archived_card_count: number;
}

export interface GroupLabel {
  id: number;
  name: string;
  color: string;
}

export interface Group {
  id: number;
  name: string;
  description: string;
  owner: BoardUser;
  parent: number | null;
  parent_name: string | null;
  member_count: number;
  board_count: number;
  subgroup_count: number;
  created_at: string;
  /** @deprecated No effect (#1430); group members get their GroupMembership role on every group board. */
  default_board_member_role: BoardRole;
  /** @deprecated No effect (#1429); stored and returned for API compatibility, card priorities are not restricted by it. */
  allowed_priorities: Priority[];
  shared_labels: GroupLabel[];
  is_starred: boolean;
  /**
   * True when the caller has no access to this group itself and it is
   * returned only so navigation (tree, breadcrumbs) keeps working, e.g. an
   * ancestor of a group they belong to. Fields are withheld: description is
   * empty, shared_labels and allowed_priorities are empty arrays, and the
   * counts are 0.
   */
  navigation_only: boolean;
  /**
   * True when the caller may place a board in this group (create, move or
   * import into it): group admin of it or an ancestor, or a user with
   * can_access_all_content. Same rule the server enforces on those writes.
   */
  can_place_boards: boolean;
  /**
   * Health status (#1133). `health_status` is this entity's own value (null =
   * inherit); `effective_health_status` is what applies (own value, else the
   * nearest ancestor group's, else null); `health_status_source` names that
   * ancestor group, and is null when the value is set here or nothing applies.
   * All three are null on a `navigation_only` group (withheld).
   */
  health_status: HealthStatus | null;
  effective_health_status: HealthStatus | null;
  health_status_source: HealthStatusSource | null;
  /**
   * Last set or confirm of this entity's own `health_status` (#2242), read-only:
   * written by the explicit `POST .../health-status/` action (and by a PATCH
   * that changes the value). All three are null when never recorded; a null
   * `health_status_changed_by` with a timestamp is a removed account or a
   * system change. Render the attribution only with `healthSetLine`.
   */
  health_status_changed_at: string | null;
  health_status_changed_by: BoardUser | null;
  health_status_note: string | null;
  /**
   * #2244 — "review status every N days" (1-365), or null for off. Writable
   * by whoever may change this entity's settings.
   */
  health_review_days: number | null;
  /**
   * #2244 — when the status shown is due for review: the owner's
   * `health_status_changed_at` plus the owner's `health_review_days` (the
   * owner is this entity when it sets its own value, else the
   * `health_status_source` group). Null when off, unset, or never recorded.
   * A fixed timestamp, so every payload, including WebSocket frames, carries
   * the same due time. The cue updates on the next render or refresh, not on
   * a timer; render with `healthReviewCue`.
   */
  health_review_due_at: string | null;
  // Only present on the retrieve endpoint (GroupDetailSerializer); absent on list.
  ancestors?: { id: number; name: string }[];
}

export interface GroupMembership {
  id: number | null;
  user: BoardUser;
  // The group members endpoint only ever serializes a GroupMembership.Role
  // value (viewer/collaborator/member/admin); it never injects synthetic
  // site_admin/owner rows the way the board members serializer does. Keep this
  // narrow so the frontend carries no dead `role === "site_admin"` branches.
  role: BoardRole;
  joined_at: string;
  is_inherited: boolean;
  inherited_from: string | null;
  // Present only for a group admin reader (the members list is otherwise
  // unchanged). All-content access resolves to full access ahead of `role`,
  // so a row with this set is shown as "Full access" with no role picker (#2075).
  has_all_content_access?: boolean;
  // Present on direct rows for a group admin reader (#2164). The server refuses
  // to change or remove a site admin's membership unless the caller is a site
  // admin, so the Members panel locks such a row for everyone else.
  is_site_admin?: boolean;
}

export type RegistrationMode = "open" | "invite_only" | "closed";

export interface SiteSettings {
  registration_mode: RegistrationMode;
  uploads_enabled: boolean;
  /** When true, non-admin writes are rejected instance-wide with 503. */
  maintenance_mode: boolean;
  /** Operator-supplied plain-text notice; blank means "use the built-in default". */
  maintenance_message: string;
}

/** Which source configures outbound mail. Never a field-level merge of the two. */
export type EmailConfigSource = "env" | "database";

/**
 * What is actually sending mail right now. `env_backend_override` means the
 * operator pinned EMAIL_BACKEND, so both the stored row and the EMAIL_* vars
 * are bypassed and the form is informational only.
 */
export type EffectiveEmailSource = EmailConfigSource | "env_backend_override";

/** Failure taxonomy from POST /admin/email-settings/test/. Treat unknown values as "unknown". */
export type EmailTestErrorCode =
  | "dns_failure"
  | "connection_refused"
  | "tls_failure"
  | "auth_failed"
  | "timeout"
  | "config_unusable"
  | "no_recipient"
  | "backend_pinned"
  | "unknown";

export interface SiteEmailSettings {
  config_source: EmailConfigSource;
  host: string;
  port: number;
  username: string;
  use_tls: boolean;
  use_ssl: boolean;
  from_email: string;
  timeout: number;
  /** Whether a password is stored. The password itself is never returned. */
  password_set: boolean;
  /** False means the instance encryption key changed; the password must be re-entered. */
  password_decryptable: boolean;
  effective_source: EffectiveEmailSource;
  effective_host: string;
  effective_port: number;
  effective_from_email: string;
  effective_use_tls: boolean;
}

/**
 * PATCH payload. `password` is write-only, and absent vs empty are distinct:
 * omitting it keeps the stored password, sending "" clears it.
 */
export type SiteEmailSettingsPatch = Partial<
  Pick<
    SiteEmailSettings,
    | "config_source" | "host" | "port" | "username"
    | "use_tls" | "use_ssl" | "from_email" | "timeout"
  >
> & { password?: string };

/** 200 from POST /admin/email-settings/test/. */
export interface EmailTestSuccess {
  success: true;
  code: null;
  sent_to: string;
}

/**
 * 400 from POST /admin/email-settings/test/ — the 1.1 `{code, detail}` machine-error
 * shape plus `success`. `detail` is always a fixed, neutral message for the code
 * (never raw SMTP error text); switch on `code`, not on `detail`.
 */
export interface EmailTestFailure {
  success: false;
  code: EmailTestErrorCode;
  detail: string;
}

export type EmailTestResult = EmailTestSuccess | EmailTestFailure;

export interface OwnedBoardSummary {
  id: number;
  uid: string;
  name: string;
}

export interface AdminUser {
  id: number;
  username: string;
  email: string;
  display_name: string;
  first_name: string;
  last_name: string;
  // Empty string ("") is the "no avatar" sentinel — never null. See BoardUser above.
  avatar_url: string;
  is_active: boolean;
  is_site_admin: boolean;
  can_access_all_content: boolean;
  // Read-only. Superuser status implies is_site_admin and
  // can_access_all_content, so the admin API refuses to clear either flag
  // while it is set, and refuses a non-superuser actor more on such a row
  // (#1644); the users page leaves those actions out.
  is_superuser: boolean;
  must_change_password: boolean;
  date_joined: string;
  owned_boards: OwnedBoardSummary[];
  has_completed_tour?: boolean;
}

export interface AdminInviteLink {
  id: number;
  prefix: string;
  expires_at: string | null;
  single_use: boolean;
  used_at: string | null;
  revoked_at: string | null;
  created_at: string;
  use_count: number;
  status: "pending" | "used" | "expired" | "revoked";
  created_by_username: string | null;
  /** "link" = copied and shared by an admin; "email" = sent to one address (#731). */
  delivery: "link" | "email";
}

/** 202 body of the emailed-invite endpoints (#731). `delivery` is present only
 * when mail went to the dev console rather than a relay; `already_registered`
 * only on the site-admin endpoint. The raw token is never returned. */
export interface InviteEmailSent {
  detail: string;
  sent_to: string;
  delivery?: "console";
  already_registered?: boolean;
}

export interface CreatedAdminInviteLink extends AdminInviteLink {
  raw_token: string;
}

export interface GroupInviteLink {
  id: number;
  prefix: string;
  /** Full raw token — only present in the creation response. */
  token?: string;
  name: string;
  role: BoardRole;
  expires_at: string | null;
  is_active: boolean;
  is_expired: boolean;
  created_at: string;
  /** Username of the admin who created the link (#1008). Null when the
   * creator was deactivated and their User row was anonymized. */
  created_by_username: string | null;
  single_use: boolean;
  status: "pending" | "used" | "expired" | "revoked";
  used_at: string | null;
  /** "link" = copied and shared by an admin; "email" = sent to one address (#731). */
  delivery: "link" | "email";
}

/** One row of the admin-only GET /boards/<id>/invite-links/ list (#1444).
 * Never carries the token or the address the invite was emailed to. */
export interface BoardInviteLink {
  id: number;
  prefix: string;
  name: string;
  role: "member" | "collaborator" | "viewer";
  /** "email" = sent to one address; "link" = shareable link (#439). */
  delivery: "link" | "email";
  created_at: string;
  /** Null when the sender's account was deleted. */
  created_by_username: string | null;
  expires_at: string | null;
  is_expired: boolean;
  single_use: boolean;
  used_at: string | null;
  status: "pending" | "used" | "expired" | "revoked";
  /** Advisory: whether a new person could create an account from this invite
   * under the site's current registration mode. */
  can_register: boolean;
  /** Redemptions so far (#439) — a multi-use link never stamps used_at. */
  use_count: number;
}

/** POST /boards/<id>/invite-links/ response (#439): the list row plus the raw
 * token, returned once and never again. */
export interface CreatedBoardInviteLink extends BoardInviteLink {
  token: string;
}

/** One row of the site-admin GET /admin/board-invite-links/ list (#439):
 * every board's invites, emailed and shareable. Never carries a token. */
export interface AdminBoardInviteLink {
  id: number;
  board_id: number;
  board_name: string;
  role: "member" | "collaborator" | "viewer";
  delivery: "link" | "email";
  /** Stored status — always agrees with the ?status= filter. */
  status: string;
  prefix: string;
  expires_at: string | null;
  created_at: string;
  /** Null when the sender's account was deleted. */
  created_by_username: string | null;
  single_use: boolean;
  use_count: number;
  /** Advisory, computed at read time against the current registration mode. */
  can_register: boolean;
}

export type AdminBoardInviteStatusFilter = "pending" | "used" | "expired" | "revoked" | "all";

/** Returned by POST and DELETE on /boards/<id>/share/.
 *
 * On enable (POST), all three fields carry values. On disable (DELETE),
 * every field is null — the response is shaped identically (#1005) so the
 * caller does not need a discriminated union to read the result.
 *
 * The POST response is the only place the SPA reads the token (#1935): the
 * Sharing tab shows the link once, then drops it from state.
 */
export interface ShareActionResponse {
  share_token: string | null;
  share_url: string | null;
  share_token_expires_at: string | null;
  /** #1967 (1.3+) — when the link was issued; null on revoke. Equals the
   *  `issued_at` of the share_link.updated event for the same change. */
  share_token_issued_at: string | null;
}

export interface SavedFilter {
  id: number;
  name: string;
  state_json: Record<string, unknown>;
  state_version: number;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Public share-link types (unauthenticated board view)
// ---------------------------------------------------------------------------

export interface PublicAssignee {
  display_name: string;
}

export interface PublicCard {
  uid: string;
  column: number;
  swimlane: number;
  title: string;
  priority: Priority;
  labels: Label[];
  due_date: string | null;
  weight: number;
  position: number;
  checklist_total: number;
  checklist_done: number;
  assignee: PublicAssignee | null;
  last_moved_at: string | null;
  /** True when the newest movement is the card's creation, not a move (#1576).
   *  Optional: absent in payloads that predate the field; treat as false. */
  last_move_is_creation?: boolean;
  is_stale: boolean;
  /**
   * Same blocked signal as on `Card` (#449). The count is safe on an anonymous
   * payload because relations are same-board only, so every blocker is a card
   * this response already carries. The relation rows are not exposed here —
   * they carry actor identity and timestamps that the public serializer's
   * whitelist excludes.
   */
  blocker_count: number;
  /** Gated stages (#1102): index of the card's sub-column in its column's `sub_columns`; 0 on a plain column. */
  gates_passed?: number;
}

export interface BoardPublic {
  uid: string;
  name: string;
  // staleness_threshold_days intentionally omitted — removed from the API response
  // to avoid leaking internal board configuration to anonymous share-link visitors.
  // is_stale is computed server-side so the client does not need the threshold value.
  columns: PublicColumn[];
  swimlanes: PublicSwimlane[];
  labels: Label[];
  cards: PublicCard[];
}

// ---------------------------------------------------------------------------
// Issue Board Lens types (read-only GitHub/GitLab issue mirror)
// ---------------------------------------------------------------------------
//
// These mirror the provider-neutral dataclasses in backend/git_lens/types.py.
// Keep them in lockstep — the lens view renders one board model regardless of
// the upstream provider.

export type LensProvider = "github" | "gitlab";

/** Persisted lens configuration for a board. */
export interface LensConnection {
  id: number;
  provider: LensProvider;
  /** "owner/repo" (GitHub) or "group/subgroup/project" (GitLab). */
  repo_slug: string;
  column_dim: string;
  swimlane_dim: string;
  /** Null once the user who configured the lens is deleted (SET_NULL FK, #1331). */
  created_by: BoardUser | null;
  created_at: string;
  updated_at: string;
}

/** A single axis entry (column or swimlane) on the rendered lens board. */
export interface LensAxis {
  key: string;
  label: string;
  /** Only ever true on the milestone swimlane axis: the milestone currently being
   *  worked on (sorted first + badged). Always false on columns / other swimlanes. */
  is_current: boolean;
}

/** Issue label. ``color`` is a hex string WITHOUT a leading '#'. */
export interface LensLabel {
  name: string;
  color: string;
}

export interface LensUser {
  username: string;
  avatar_url: string;
}

/**
 * Why an issue landed in its `pipeline` column — surfaced on the card so the
 * derived Doing/Review placement is explainable. `null` when the issue has no
 * linked branch or open MR. Populated only for the `pipeline` column dimension.
 */
export interface LensPipelineEvidence {
  /** The feature branch name driving "Doing", if any. */
  branch: string | null;
  /** The linked open MR/PR number driving "Review", if any. */
  mr_number: number | null;
  mr_url: string | null;
  /** True when the MR's closing pattern (Closes/Fixes #N) targets this issue. */
  mr_closes: boolean;
}

export interface NormalizedIssue {
  number: number;
  title: string;
  url: string;
  state: "open" | "closed";
  labels: LensLabel[];
  assignees: LensUser[];
  milestone: string | null;
  /** Milestone metadata carried through normalization for current-milestone
   *  detection (backend-side); the frontend doesn't read these directly. */
  milestone_due: string | null;
  milestone_state: string | null;
  /** Column key(s) this issue maps to. */
  column_keys: string[];
  /**
   * Swimlane key(s) this issue maps to. Plural by design: an issue matching N
   * swimlane values renders once in EACH matching lane (never hide info).
   */
  swimlane_keys: string[];
  /** Pipeline-derivation signals (present for every issue; defaults when the
   * `pipeline` column dim wasn't requested). `pipeline_evidence` is null unless
   * the issue has a linked branch or open MR. */
  has_branch: boolean;
  has_open_pr: boolean;
  pipeline_evidence: LensPipelineEvidence | null;
}

/** Rendered, read-only lens board for a configured connection. */
export interface LensData {
  columns: LensAxis[];
  swimlanes: LensAxis[];
  issues: NormalizedIssue[];
  /** ISO 8601 timestamp of when the data was fetched from the provider. */
  fetched_at: string;
  source: {
    provider: LensProvider;
    repo: string;
    url: string;
  };
  /** True when the provider returned more issues than the lens rendered. */
  truncated: boolean;
  /** Total issue count upstream, or null when the provider does not report it. */
  total_count: number | null;
  /** Milestone titles seen in the fetched issues — autocomplete suggestions for the
   *  milestone filter. The filter accepts any typed value (server-side), so a
   *  milestone outside the fetched window can still be filtered to. */
  available_milestones: string[];
}

// ---------------------------------------------------------------------------
// Trello import (#456) — mirrors backend/boards/services/trello_import.py.
// ---------------------------------------------------------------------------

export type TrelloWarningCode =
  | "archived_lists_skipped"
  | "cards_in_archived_lists_skipped"
  | "cards_missing_list"
  | "multiple_swimlane_labels"
  | "checklists_flattened"
  | "invalid_due_dates"
  | "descriptions_truncated"
  | "comments_truncated"
  | "unknown_labels"
  | "comments_may_be_incomplete"
  | "matched_members_not_added"
  | "unmatched_members";

export type TrelloUnmappableKind =
  | "attachment_files"
  | "custom_fields"
  | "power_up_data"
  | "start_dates"
  | "stickers";

export interface TrelloImportMapping {
  swimlane_label_ids: string[];
  default_swimlane_name: string;
  include_archived_lists: boolean;
  add_matched_members: boolean;
}

export interface TrelloImportCounts {
  lists: number;
  lists_archived: number;
  cards: number;
  cards_archived: number;
  labels: number;
  checklists: number;
  checklist_items: number;
  comments: number;
  attachments: number;
  members: number;
}

export interface TrelloImportResultCounts {
  columns: number;
  swimlanes: number;
  labels: number;
  cards: number;
  cards_archived: number;
  checklist_items: number;
  comments: number;
}

export interface TrelloImportWarning {
  code: TrelloWarningCode;
  message: string;
  count: number;
}

export interface TrelloImportUnmappable {
  kind: TrelloUnmappableKind;
  count: number;
}

export interface TrelloImportPreview {
  source: "trello";
  file_sha256: string;
  board: { name: string; description: string };
  counts: TrelloImportCounts;
  result: TrelloImportResultCounts;
  mapping: {
    columns: { trello_id: string; name: string; position: number | null; card_count: number; archived: boolean }[];
    labels: {
      trello_id: string;
      name: string;
      color: string;
      original_color: string | null;
      card_count: number;
      swimlane_eligible: boolean;
    }[];
    swimlanes: { name: string; label_id: string | null }[];
    default_swimlane: string;
  };
  /** Only a count of matches — never which accounts matched (#456 security note). */
  members: { total: number; matched: number; unmatched: { trello_id: string; full_name: string }[] };
  options: TrelloImportMapping;
  warnings: TrelloImportWarning[];
  unmappable: TrelloImportUnmappable[];
}

/** The Trello confirm summary: `summary`, and since 1.3 also `import_summary`. */
export interface TrelloImportSummary {
  counts: TrelloImportCounts;
  result: TrelloImportResultCounts;
  warnings: TrelloImportWarning[];
  unmappable: TrelloImportUnmappable[];
}

/** `POST /boards/import/trello/?confirm=true` 201. Since 1.3 (#1903) it carries the
 *  native import's envelope too: the board's fields at the top level and the
 *  summary again as `import_summary`. */
export type TrelloImportResult = Board & {
  board: Board;
  summary: TrelloImportSummary;
  import_summary: TrelloImportSummary;
};

/** What to include in a Visiban JSON/CSV board import (#119). Every key is
 *  optional and defaults to `true` server-side; board structure (name,
 *  columns, swimlanes) is always imported. `comments`, `checklist` and
 *  `history` require `cards`; a CSV import accepts only `labels` and `cards`. */
export interface ImportOptions {
  labels?: boolean;
  cards?: boolean;
  comments?: boolean;
  checklist?: boolean;
  history?: boolean;
  /** Sample-board flow (#1452), JSON only: shift every date in the file forward
   *  by the days between this date (YYYY-MM-DD) and today. Omit for a plain import. */
  shift_dates_from?: string;
  /** #1949, JSON only: `false` imports the dates exactly as written, turning off
   *  the default shift a file with its own top-level `date_anchor` gets. Omit
   *  for the default (`true`). Never sent together with `shift_dates_from`. */
  shift_dates?: boolean;
  /** #1949, JSON only: the day (YYYY-MM-DD) a shifted board is dated around.
   *  Omit for today (UTC). Ignored when nothing shifts. */
  shift_dates_to?: string;
}

/** What a sample board carries, derived from its contents (#1452). */
export type SampleBoardInclude = 'labels' | 'checklists' | 'comments' | 'history';

/** One entry of `GET /boards/samples/` (#1452), gallery order. Named "sample",
 *  not "template": `BoardTemplate` is the user-facing board-creation template. */
export interface SampleBoardSummary {
  id: string;
  title: string;
  description: string;
  swimlane_theme: string;
  /** Active (non-archived) cards. */
  card_count: number;
  includes: SampleBoardInclude[];
  order: number;
  schema_version: number;
  /** Pass as `ImportOptions.shift_dates_from` to date the board around today. The
   *  file itself also carries it as a top-level `date_anchor` (#1949). */
  date_anchor: string;
}

/** Date-shift options: echoed in `options_applied` only when sent or applied. */
type ShiftOptionKey = 'shift_dates_from' | 'shift_dates' | 'shift_dates_to';

/** Counts of file contents left out by the chosen import options (#119). */
export interface ImportSkippedCounts {
  cards: number;
  comments: number;
  checklist_items: number;
  label_refs: number;
  movements: number;
  activities: number;
  /** Non-hex colors replaced by the default (#2093); absent from older servers. */
  colors?: number;
  /**
   * Card and checklist item assignee names that matched no user the importer
   * can see, so those imported unassigned (#2198); absent from older servers.
   */
  assignees?: number;
}

export interface ImportSummary {
  /** The five include flags are always echoed; the shift options only when sent or applied. */
  options_applied: Required<Omit<ImportOptions, ShiftOptionKey>> & Pick<ImportOptions, ShiftOptionKey>;
  skipped: ImportSkippedCounts;
  /** CSV import only: values or columns dropped (bounded, at most 21 entries). Absent on JSON and Trello. */
  warnings?: string[];
}

/** `POST /api/v1/boards/import/` response: the board plus an additive summary.
 *  Since 1.3 (#1903) also the Trello envelope: `board` (the same board) and
 *  `summary` (the same object as `import_summary`). */
export type ImportBoardResponse = Board & { import_summary: ImportSummary; board: Board; summary: ImportSummary };

/** Stable `code` on a board-import error body (#1903; `boards/import_errors.py`).
 *  Errors raised outside the importer carry DRF's code instead
 *  (`not_authenticated`, `permission_denied`, `not_found`, `throttled`, `parse_error`, ...). */
export type ImportErrorCode =
  | 'no_file'
  | 'file_too_large'
  | 'unsupported_format'
  | 'invalid_file'
  | 'limit_exceeded'
  | 'invalid_options'
  | 'invalid_name'
  | 'invalid_mode'
  | 'file_mismatch'
  | 'invalid_import';

/** Every 4xx body from the two import endpoints. Branch on `code`; `detail` may be reworded. */
export interface ImportErrorResponse {
  detail: string;
  /** New codes may be added; treat an unknown one like `invalid_import`. */
  code: ImportErrorCode | (string & {});
}

/** One swimlane row of `GET /boards/{id}/summary/`. */
export interface BoardSummarySwimlane {
  id: number;
  name: string;
  color: string;
  total_cards: number;
  stage_distribution: Record<string, number>;
  velocity_7d: number;
  velocity_30d: number;
  active_cards: number;
  done_30d: number;
  avg_cycle_days: number | null;
  /** Active cards blocked manually or by a relation (#1149). */
  blocked_cards: number;
}

/**
 * Flow metrics (`GET /boards/{id}/metrics/*`, #448). Every number comes from the
 * server, including percentiles: a null percentile means the sample is below
 * the sample-size rule, and the client draws nothing for it.
 */
export interface FlowPercentiles {
  p50: number | null;
  p85: number | null;
  p95: number | null;
}

/** One swimlane's trend inside the selected period (#2266). Never compares with an earlier period. */
export interface FlowSwimlaneTrend {
  direction: 'slower' | 'steady' | 'faster';
  first_days: number;
  last_days: number;
}

export interface FlowSwimlaneRollingPoint {
  at: string;
  median_days: number | null;
  sample_size: number;
}

export interface FlowSwimlaneRow {
  id: number;
  name: string;
  position: number;
  /** The swimlane's value of the "Group lanes by" field, or null (also null without grouping). */
  group: string | null;
  finished: number;
  in_progress: number;
  median_days: number | null;
  p85_days: number | null;
  /** Share of in-progress time spent blocked, 0 to 1; null when the swimlane had none in the period. */
  blocked_share: number | null;
  rolling_median: FlowSwimlaneRollingPoint[];
  status: 'slower' | 'in_line' | 'faster' | null;
  trend: FlowSwimlaneTrend | null;
}

/** `GET /boards/{id}/metrics/swimlanes/` (#2266). Status and trend come from the server. */
export interface FlowSwimlaneComparison {
  definition: string;
  board: { finished: number; median_days: number | null; p85_days: number | null };
  status_threshold_pct: number;
  status_min_finished: number;
  swimlanes: FlowSwimlaneRow[];
  grouping: {
    field_id: number;
    field_name: string;
    field_type: string;
    groups: { key: string; name: string | null }[];
  } | null;
}

/** A card a metric response names by uid: the drill-down's cards and owners. */
export interface FlowCard {
  uid: string;
  id: number;
  title: string;
  archived: boolean;
  assignee: BoardUser | null;
  /** The card's current swimlane (#2283); every card has one. */
  swimlane: { id: number; name: string };
}

/**
 * Breakdowns (`group_by`, #2265) on cycle-time, throughput, wip-age and dwell.
 * Present only when the request sent `group_by`. Keys are strings: a swimlane or
 * label id, the dropdown choice, or "true"/"false" for a checkbox.
 */
export type FlowGroupBy = "swimlane" | "label" | "custom_field";

/**
 * One group. At most five named groups, ranked by cards active in the range;
 * the rest collapse into a last "Other" group with `key` and `name` null. A
 * group's index in `groups` is its chart color.
 */
export interface FlowGroupBase {
  key: string | null;
  /** Swimlane, label or choice text; null for checkbox values and for Other. */
  name: string | null;
  /** The card keys in the group: `[key]`, or every collapsed key for Other. */
  member_keys: string[];
}

export interface FlowGrouping<G extends FlowGroupBase> {
  by: FlowGroupBy;
  field_id: number | null;
  /** In the endpoint's own unit: what belongs to no group. */
  excluded: number;
  /** True when some card counts in two or more groups (labels), so group sizes add up to more than the total (#2297). */
  overlapping: boolean;
  groups: G[];
}

export interface FlowCycleTimeGroup extends FlowGroupBase {
  sample_size: number;
  percentiles: FlowPercentiles;
}

export interface FlowThroughputGroup extends FlowGroupBase {
  total: number;
  median: number | null;
}

export interface FlowWipAgeGroup extends FlowGroupBase {
  sample_size: number;
}

export interface FlowDwellGroup extends FlowGroupBase {
  /** Visits, like the top-level `sample_size`. */
  sample_size: number;
  columns: FlowDwellColumn[];
}

/** One period's completions in one group; Other is keyed null. */
export interface FlowThroughputGroupCount {
  key: string | null;
  count: number;
  card_uids: string[];
}

export interface FlowCycleTimeSample {
  card_uid: string;
  value_days: number;
  start: string;
  end: string;
  /** The card was reopened after this completion; the number does not change. */
  reopened: boolean;
  /** With `group_by` only: the card's group keys, empty when it has none. */
  group_keys?: string[];
  /** Time in gated stages' last sub-columns during the cycle (#2360); 0 when none. Absent from older servers. */
  wait_days?: number | null;
  /** `value_days` minus `wait_days` (#2360). Absent from older servers. */
  work_days?: number | null;
}

export interface FlowCycleTime {
  definition: string;
  sample_size: number;
  excluded_incomplete_history: number;
  percentiles: FlowPercentiles;
  samples: FlowCycleTimeSample[];
  cards: FlowCard[];
  grouping?: FlowGrouping<FlowCycleTimeGroup>;
}

export interface FlowThroughputSample {
  /** First UTC day of the period (`YYYY-MM-DD`). */
  start: string;
  count: number;
  card_uids: string[];
  /** Cards whose cycle started in the period (#2260). Under-reports on imported boards. */
  started: number;
  /** With `group_by` only: one entry per `grouping.groups` entry, in order. */
  by_group?: FlowThroughputGroupCount[];
}

export interface FlowThroughput {
  definition: string;
  period: "day" | "week";
  /** Completions in the whole periods: a partial week at either end of the range is left out. */
  total: number;
  /**
   * First completions anywhere in the range, the cycle-time sample's window
   * (#2288). Optional: a server older than #2288 omits it.
   */
  completed_in_range?: number;
  median: number | null;
  samples: FlowThroughputSample[];
  cards: FlowCard[];
  grouping?: FlowGrouping<FlowThroughputGroup>;
}

export interface FlowCumulativeColumn {
  /** Null is the one band for every deleted column. */
  column_uid: string | null;
  column_name: string | null;
  is_done: boolean;
  /** Cards at the end of the first / last whole day; null with no whole day (#2260). */
  start_count: number | null;
  end_count: number | null;
  /** Band changes after the first day: `end_count - start_count === entered - left`. */
  entered: number;
  left: number;
  /** `entered × 7 ÷ (days − 1)`; null under two whole days. */
  entered_per_week: number | null;
  left_per_week: number | null;
}

export interface FlowCumulativeFlow {
  definition: string;
  columns: FlowCumulativeColumn[];
  /** `counts` is keyed by column uid; the deleted-columns band is under "null". */
  days: { date: string; counts: Record<string, number> }[];
  bottleneck_column_uid: string | null;
  /**
   * First completions in the `entered` window (#2307): a card moving between done columns
   * or finishing again after a reopen counts once. Absent from a server older than #2307.
   */
  completed?: number;
  /** `completed × 7 ÷ (days − 1)`; null under two whole days. */
  completed_per_week?: number | null;
}

export interface FlowCumulativeDayCards {
  definition: string;
  date: string;
  columns: { column_uid: string | null; card_uids: string[] }[];
  cards: FlowCard[];
}

export interface FlowAgeSample {
  card_uid: string;
  column_uid: string;
  value_days: number;
  start: string;
  dwell_by_column: { column_uid: string | null; value_days: number }[];
  is_blocked: boolean;
  blocked_days: number;
  /** With `group_by` only: the card's group keys, empty when it has none. */
  group_keys?: string[];
}

export interface FlowWipAge {
  definition: string;
  sample_size: number;
  excluded_incomplete_history: number;
  cycle_time_percentiles: FlowPercentiles;
  /**
   * The columns that are not done, in position order. `wip_count` (#2287) is
   * every card not archived in the column now, the count its WIP limit
   * applies to; the samples leave out cards with no age (not started, or
   * incomplete history). Optional: a server older than #2287 omits it.
   */
  columns: { column_uid: string; column_name: string; wip_count?: number }[];
  samples: FlowAgeSample[];
  cards: FlowCard[];
  grouping?: FlowGrouping<FlowWipAgeGroup>;
}

/** `GET /boards/{id}/metrics/dwell/` (#2260): completed dwell per not-done column. */
export interface FlowDwellColumn {
  column_uid: string;
  column_name: string;
  sample_size: number;
  percentiles: FlowPercentiles;
  /** Gated stages only (#2360): work and wait percentiles; null for a stage with no sub-columns. */
  work_percentiles?: FlowPercentiles | null;
  wait_percentiles?: FlowPercentiles | null;
}

export interface FlowDwell {
  definition: string;
  sample_size: number;
  excluded_incomplete_history: number;
  columns: FlowDwellColumn[];
  grouping?: FlowGrouping<FlowDwellGroup>;
}

/** `GET /boards/{id}/metrics/blocked/` (#2260). Days are unrounded. */
export interface FlowBlockedColumn {
  column_uid: string;
  column_name: string;
  days: number;
  blocks: number;
}

export interface FlowBlockedReason {
  reason: string;
  days: number;
  blocks: number;
}

export interface FlowBlocked {
  definition: string;
  total: { days: number; blocks: number };
  blocked_now: number;
  columns: FlowBlockedColumn[];
  reasons: FlowBlockedReason[];
  /** Distinct reasons before `reasons` was capped. */
  reason_count: number;
}

/** `GET /boards/{id}/metrics/attention/` (#2260). */
export type FlowAttentionReason = "blocked" | "past_p85" | "stalled";

export interface FlowAttentionItem {
  card_uid: string;
  column_uid: string;
  swimlane_id: number;
  /** Null when the card is not in progress. */
  age_days: number | null;
  /** Never null from the server now (a card with no movement counts from its creation date); kept `number | null` for compatibility. */
  unmoved_days: number | null;
  /** Never empty, in the order blocked, past_p85, stalled. */
  reasons: FlowAttentionReason[];
  /**
   * The manual block's free text, trimmed, when `reasons` includes "blocked" (#2281).
   * Null when not blocked, blocked only by a relation, or the block has no text; never "".
   */
  block_reason: string | null;
}

export interface FlowAttention {
  definition: string;
  stalled_threshold_days: number;
  cycle_time_percentiles: FlowPercentiles;
  items: FlowAttentionItem[];
  cards: FlowCard[];
}

/**
 * `GET /boards/{id}/metrics/overview/` (#2426): each section is exactly its own
 * `metrics/*` response, all computed from one load of the board's history.
 */
export interface FlowOverview {
  cycle_time: FlowCycleTime;
  throughput: FlowThroughput;
  cumulative_flow: FlowCumulativeFlow;
  wip_age: FlowWipAge;
  dwell: FlowDwell;
  blocked: FlowBlocked;
  attention: FlowAttention;
}

/**
 * `GET /boards/{id}/summary/` response. `extension_panels` is untrusted input
 * from enterprise `ANALYTICS_EXTENSIONS` producers: it is `unknown[]` on
 * purpose and must go through `parseExtensionPanels` before rendering (#1770).
 */
export interface BoardSummary {
  swimlanes: BoardSummarySwimlane[];
  extension_panels: unknown[];
}

/**
 * `board.created` / `board.updated` WebSocket payload (#1734). Unlike the REST
 * `Board`, `is_starred` is the acting user's value and, since #1705, is omitted
 * for every other recipient, so it is optional here. REST responses always
 * include it; keep `Board.is_starred` required.
 */
export type BoardEventPayload = Omit<Board, "is_starred"> & { is_starred?: boolean };

/**
 * `webhook.changed` WebSocket payload (#2057). Admin-only and broadcast-only
 * (never in the change feed): an invalidation that tells an open Webhooks tab
 * to refetch. Never carries the URL, host, label or a secret. `changed_by` is
 * the acting user's id, null for the dispatcher.
 */
export interface WebhookChangedPayload {
  id: number;
  status: "active" | "failing" | "disabled" | "deleted";
  reason_code: string;
  consecutive_failures: number;
  changed_by: number | null;
  at: string;
}

/**
 * `share_link.updated` WebSocket payload (#1967). Admin-only: the server sends
 * it to admin / site_admin sockets only. `active` and `expires_at` are the
 * values `/full/` returns as `share_link_active` and `share_token_expires_at`
 * (renamed on the wire because those keys are stripped from every frame).
 * `issued_at` is the rotation signal: the issue time of the new link on an
 * enable or rotate, null on every other change. Never carries the token.
 */
export interface ShareLinkUpdatedPayload {
  board_uid: string;
  active: boolean;
  expires_at: string | null;
  issued_at: string | null;
}

/**
 * One card a move renumbered, in `card.moved`'s `sibling_positions` (#1890).
 * `version` is the sibling's own: a position shift does not bump it, so a
 * client holding a newer copy of the sibling skips the pair (#1969 rule).
 */
export interface CardSiblingPosition {
  id: number;
  position: number;
  version: number;
}

/**
 * `card.moved` WebSocket payload: the REST move response (`card`, plus
 * `movement` unless the move was a reorder within one cell) and, since 1.3,
 * `sibling_positions`: every active card in the move's source and target
 * cells whose position the move changed (#1890). Optional because a frame
 * from an older server, or a change-feed row written by one, has no key.
 */
export interface CardMovedEventPayload {
  card: Card;
  movement?: CardMovement;
  sibling_positions?: CardSiblingPosition[];
}

/** `group.created` / `group.updated` WebSocket payload; `is_starred` omitted for non-actors (#1705). */
export type GroupEventPayload = Omit<Group, "is_starred"> & { is_starred?: boolean };

// ── Two-tier child cards (#2208) ─────────────────────────────────────────────

/** A board that names this one as its default child board; `{hidden: true}` when the viewer cannot open it. */
export type DefaultOfEntry =
  | { hidden: false; id: number; name: string; can_change: boolean }
  | { hidden: true };

/** `GET /boards/{id}/children-setting-blockers/`. */
export interface ChildrenSettingBlockers {
  child_cards: number;
  parent_cards: number;
  default_of: DefaultOfEntry[];
}

/** `GET /boards/{id}/delete-impact/`. Only parent boards the deleter can open are named. */
export interface BoardDeleteImpact {
  child_cards: number;
  parent_boards: { id: number; name: string }[];
  hidden_parent_boards: boolean;
  parent_cards: number;
}

/** `GET /boards/{b}/cards/{id}/child-board-options/`. */
export interface ChildBoardOptions {
  /** `default_assignee_id` is present only when the parent's lane has a team (#2211). */
  fixed_board: { hidden: false; id: number; name: string; can_add: boolean; default_assignee_id?: number | null } | { hidden: true } | null;
  default: { id: number; name: string } | null;
  can_set_default: boolean;
  boards: { id: number; name: string; can_set_default: boolean; default_assignee_id?: number | null }[];
  /** #2211: the parent's lane team (active members, team order), or null. Optional for older servers. */
  default_team?: { swimlane: { id: number; name: string }; member_ids: number[] } | null;
  /** How many boards qualify in all; `boards` holds at most 100 of them (#2449, since 1.3). */
  boards_total?: number;
  /** `"parent_archived"` when this card is archived: Add child refuses it (#2447, since 1.3). */
  disabled_reason?: "parent_archived" | null;
}

/** `GET /boards/{id}/default-child-board-options/` (#2208): the Rules page's default child board select. */
export interface DefaultChildBoardOptions {
  /** At most 100, by name; always includes the board's current default when it qualifies (#2449). */
  boards: { id: number; name: string }[];
  /** How many boards qualify in all (#2449, since 1.3); absent from older servers. */
  boards_total?: number;
}
