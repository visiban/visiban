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
}

export interface PersonalAccessToken {
  id: number;
  name: string;
  /** First 8 characters of the raw token — safe to display. */
  prefix: string;
  created_at: string;
  last_used_at: string | null;
  expires_at: string | null;
}

/** Returned only on token creation — includes the one-time raw value. */
export interface CreatedPersonalAccessToken extends PersonalAccessToken {
  token: string;
}

export interface BoardTemplateColumn {
  name: string;
  color: string;
  position: number;
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

export interface BoardMembership {
  id: number | null;
  user: BoardUser;
  role: BoardOrSiteRole;
  is_moderator: boolean;
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
}

export interface Label {
  id: number;
  uid: string;
  name: string;
  color: string;
}

export type Priority = "low" | "medium" | "high" | "urgent";

export interface CardChecklistItem {
  id: number;
  text: string;
  is_checked: boolean;
  position: number;
}

export interface CardAttachment {
  id: number;
  filename: string;
  size: number;
  url: string;
  uploaded_by: BoardUser | null;
  uploaded_at: string;
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
  attachment_count: number;
  checklist_total: number;
  checklist_done: number;
  is_stale: boolean;
  archived_at: string | null;
  version: number;
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
  action_type: 'assigned' | 'mentioned' | 'card_moved' | 'stale' | 'board_invite';
  read: boolean;
  created_at: string;
}

export interface CardMovement {
  id: number;
  /** Identifies the card this movement belongs to — useful in board-level history lists. */
  card_uid: string;
  card_title: string;
  from_column: number | null;
  from_column_name: string | null;
  // Backend CardMovementSerializer returns "" (not null) for missing FK UIDs.
  from_column_uid: string;
  to_column: number | null;
  to_column_name: string | null;
  to_column_uid: string;
  from_swimlane: number | null;
  from_swimlane_name: string | null;
  from_swimlane_uid: string;
  to_swimlane: number | null;
  to_swimlane_name: string | null;
  to_swimlane_uid: string;
  moved_by: BoardUser | null;
  moved_at: string;
  notes: string;
  movement_type: "move" | "archived" | "unarchived";
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
  | "due_date_change";

export interface CardActivity {
  id: number;
  event_type: CardActivityEventType;
  from_value: string;
  to_value: string;
  actor: BoardUser | null;
  created_at: string;
}

export interface CardTimelineEntry {
  id: number;
  kind: "move" | "activity";
  ts: string;
  actor: BoardUser | null;
  event_type: string;
  data: Record<string, unknown>;
}

export interface CardComment {
  id: number;
  author: BoardUser | null;
  body: string;
  created_at: string;
  updated_at: string;
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
  card_count: number;
  staleness_threshold_days: number;
  stale_warning_pct: number;
  allowed_priorities: Priority[];
  enforce_wip_limits: boolean;
  enforce_wip_hard: boolean;
  enforce_weight_limits: boolean;
  export_min_role: BoardExportMinRole;
  card_density: CardDensity;
  is_starred: boolean;
  created_at: string;
  updated_at: string;
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
  members: BoardMembership[];
  staleness_threshold_days: number;
  stale_warning_pct: number;
  allowed_priorities: Priority[];
  enforce_wip_limits: boolean;
  enforce_wip_hard: boolean;
  enforce_weight_limits: boolean;
  export_min_role: BoardExportMinRole;
  card_density: CardDensity;
  is_starred: boolean;
  created_at: string;
  updated_at: string;
  current_user_role: BoardOrSiteRole | null;
  capabilities: { movement_export: boolean; [key: string]: boolean };
  share_token: string | null;
  share_token_expires_at: string | null;
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
  default_board_member_role: BoardRole;
  allowed_priorities: Priority[];
  shared_labels: GroupLabel[];
  is_starred: boolean;
  // Only present on the retrieve endpoint (GroupDetailSerializer); absent on list.
  ancestors?: { id: number; name: string }[];
}

export interface GroupMembership {
  id: number | null;
  user: BoardUser;
  role: BoardOrSiteRole;
  joined_at: string;
  is_inherited: boolean;
  inherited_from: string | null;
}

export type RegistrationMode = "open" | "invite_only" | "closed";

export interface SiteSettings {
  registration_mode: RegistrationMode;
  uploads_enabled: boolean;
}

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
  must_change_password: boolean;
  date_joined: string;
  owned_boards: OwnedBoardSummary[];
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
  created_by_username: string | null;
}

/** Returned by POST and DELETE on /boards/<id>/share/.
 *
 * On enable (POST), all three fields carry values. On disable (DELETE),
 * every field is null — the response is shaped identically (#1005) so the
 * caller does not need a discriminated union to read the result.
 */
export interface ShareActionResponse {
  share_token: string | null;
  share_url: string | null;
  share_token_expires_at: string | null;
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
  is_stale: boolean;
}

export interface BoardPublic {
  uid: string;
  name: string;
  // staleness_threshold_days intentionally omitted — removed from the API response
  // to avoid leaking internal board configuration to anonymous share-link visitors.
  // is_stale is computed server-side so the client does not need the threshold value.
  columns: Column[];
  swimlanes: Swimlane[];
  labels: Label[];
  cards: PublicCard[];
}
