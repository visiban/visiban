export interface User {
  id: number;
  username: string;
  email: string;
  first_name: string;
  last_name: string;
  avatar_url: string;
  display_name: string;
  is_site_admin: boolean;
  must_change_password: boolean;
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
  close_editor_on_enter?: boolean;
  /** PK of the board to open automatically on login, or null if not set. */
  default_board_id?: number | null;
}

export interface BoardTemplateColumn {
  name: string;
  color: string;
  position: number;
}

export interface BoardTemplate {
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

export function userDisplayName(user: Pick<User, "display_name" | "first_name" | "username">): string {
  return user.display_name || user.first_name || user.username;
}

export interface BoardMembership {
  id: number | null;
  user: User;
  role: "admin" | "member" | "collaborator" | "viewer";
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
  uploaded_by: User | null;
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
  assignee: User | null;
  labels: Label[];
  due_date: string | null;
  weight: number;
  position: number;
  created_by: number;
  created_at: string;
  updated_at: string;
  last_moved_at: string | null;
  attachment_count: number;
  checklist_total: number;
  checklist_done: number;
  is_stale: boolean;
  archived_at: string | null;
}

export interface Notification {
  id: number;
  verb: string;
  card_id: number | null;
  card_title: string | null;
  board_id: number | null;
  board_name: string | null;
  read: boolean;
  created_at: string;
}

export interface CardMovement {
  id: number;
  from_column: number | null;
  from_column_name: string | null;
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
  moved_by: User | null;
  moved_at: string;
  notes: string;
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
  actor: User | null;
  created_at: string;
}

export interface CardComment {
  id: number;
  author: User | null;
  body: string;
  created_at: string;
  updated_at: string;
}

export interface Board {
  id: number;
  uid: string;
  name: string;
  description: string;
  owner: User;
  group: number | null;
  group_name: string | null;
  member_count: number;
  card_count: number;
  staleness_threshold_days: number;
  allowed_priorities: Priority[];
  enforce_wip_limits: boolean;
  enforce_weight_limits: boolean;
  is_starred: boolean;
  created_at: string;
  updated_at: string;
}

export interface BoardFull {
  id: number;
  uid: string;
  name: string;
  description: string;
  group: number | null;
  group_name: string | null;
  columns: Column[];
  swimlanes: Swimlane[];
  cards: Card[];
  labels: Label[];
  members: BoardMembership[];
  staleness_threshold_days: number;
  allowed_priorities: Priority[];
  enforce_wip_limits: boolean;
  enforce_weight_limits: boolean;
  is_starred: boolean;
  created_at: string;
  updated_at: string;
  current_user_role: "site_admin" | "admin" | "member" | "collaborator" | "viewer" | null;
}

export interface GroupLabel {
  id: number;
  name: string;
  color: string;
}

export interface Group {
  id: number;
  name: string;
  owner: User;
  parent: number | null;
  parent_name: string | null;
  member_count: number;
  board_count: number;
  subgroup_count: number;
  created_at: string;
  default_board_member_role: "admin" | "member" | "collaborator" | "viewer";
  allowed_priorities: Priority[];
  shared_labels: GroupLabel[];
  is_starred: boolean;
}

export interface GroupMembership {
  id: number | null;
  user: User;
  role: "admin" | "member" | "collaborator" | "viewer";
  joined_at: string;
  is_inherited: boolean;
  inherited_from: string | null;
}

export type RegistrationMode = "open" | "invite_only" | "closed";

export interface SiteSettings {
  registration_mode: RegistrationMode;
}

export interface AdminUser {
  id: number;
  username: string;
  email: string;
  display_name: string;
  first_name: string;
  last_name: string;
  avatar_url: string;
  is_active: boolean;
  is_site_admin: boolean;
  must_change_password: boolean;
  date_joined: string;
}

export interface GroupInviteLink {
  id: number;
  token: string;
  name: string;
  role: "admin" | "member" | "collaborator" | "viewer";
  expires_at: string | null;
  is_active: boolean;
  is_expired: boolean;
  created_at: string;
}
