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
   * Per-choice display color (#1391): `{choice text: palette key}` — keys are
   * a subset of `choices`, values a `CHOICE_COLOR_KEYS` key (never hex). `{}`
   * when none is set; a choice with no entry renders with its automatic dot.
   */
  choice_colors: Record<string, string>;
  created_at: string;
}

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
  /** Pin this field's value to the swimlane row header. At most 8 per board. */
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
   * Per-choice display color (#1391): `{choice text: palette key}` — keys are
   * a subset of `choices`, values a `CHOICE_COLOR_KEYS` key (never hex). `{}`
   * when none is set; a choice with no entry renders with its automatic dot.
   */
  choice_colors: Record<string, string>;
  created_at: string;
}

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
  attachment_count: number;
  checklist_total: number;
  checklist_done: number;
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
  read: boolean;
  created_at: string;
}

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
  created_by: BoardUser | null;
  /** The owner whose board-admin standing keeps the webhook delivering. */
  configured_by: BoardUser | null;
  created_at: string;
  updated_at: string;
  configured_at: string | null;
  secret_rotated_at: string | null;
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
  | "due_date_change"
  // Manual block state (#1149): `blocked` carries the reason in to_value;
  // `unblocked` the reason in from_value and the resolution in to_value.
  | "blocked"
  | "unblocked";

export interface CardActivity {
  id: number;
  event_type: CardActivityEventType;
  from_value: string;
  to_value: string;
  actor: BoardUser | null;
  created_at: string;
  /** See `CardMovement.imported_from_username` (#1675). */
  imported_from_username: string | null;
}

export interface CardTimelineEntry {
  id: number;
  kind: "move" | "activity";
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
}

/** Board and group health values (#1133); `null` on the wire means inherit / none. */
export type HealthStatus = "on_track" | "at_risk" | "off_track";

/** The ancestor group that supplies an inherited health status (#1133). */
export interface HealthStatusSource {
  id: number;
  name: string;
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
  // while it is set; the users page leaves those actions out for such rows.
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

export interface TrelloImportResult {
  board: Board;
  summary: {
    counts: TrelloImportCounts;
    result: TrelloImportResultCounts;
    warnings: TrelloImportWarning[];
    unmappable: TrelloImportUnmappable[];
  };
}

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
}

export interface ImportSummary {
  /** The five include flags are always echoed; the shift options only when sent or applied. */
  options_applied: Required<Omit<ImportOptions, ShiftOptionKey>> & Pick<ImportOptions, ShiftOptionKey>;
  skipped: ImportSkippedCounts;
  /** CSV import only: values or columns dropped (bounded, at most 21 entries). Absent on JSON and Trello. */
  warnings?: string[];
}

/** `POST /api/v1/boards/import/` response: the board plus an additive summary. */
export type ImportBoardResponse = Board & { import_summary: ImportSummary };

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

/** `group.created` / `group.updated` WebSocket payload; `is_starred` omitted for non-actors (#1705). */
export type GroupEventPayload = Omit<Group, "is_starred"> & { is_starred?: boolean };
