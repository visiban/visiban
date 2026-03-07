export interface User {
  id: number;
  username: string;
  email: string;
  first_name: string;
  last_name: string;
  avatar_url: string;
  display_name: string;
  is_site_admin: boolean;
}

export function userDisplayName(user: Pick<User, "display_name" | "first_name" | "username">): string {
  return user.display_name || user.first_name || user.username;
}

export interface BoardMembership {
  id: number;
  user: User;
  role: "admin" | "member" | "viewer";
  joined_at: string;
}

export type SiteRole = "site_admin";

export interface Column {
  id: number;
  name: string;
  position: number;
  color: string;
  wip_limit: number | null;
  weight_limit: number | null;
  allow_card_creation: boolean;
}

export interface Swimlane {
  id: number;
  name: string;
  contact_email: string;
  notes: string;
  position: number;
  color: string;
  is_collapsed: boolean;
  created_at: string;
}

export interface Label {
  id: number;
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
}

export interface CardMovement {
  id: number;
  from_column: number | null;
  from_column_name: string | null;
  to_column: number | null;
  to_column_name: string | null;
  from_swimlane: number | null;
  from_swimlane_name: string | null;
  to_swimlane: number | null;
  to_swimlane_name: string | null;
  moved_by: User | null;
  moved_at: string;
  notes: string;
}

export type CardActivityEventType =
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
  | "checklist_item_deleted";

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
  name: string;
  description: string;
  owner: User;
  group: number | null;
  group_name: string | null;
  member_count: number;
  created_at: string;
  updated_at: string;
}

export interface BoardFull {
  id: number;
  name: string;
  description: string;
  group: number | null;
  group_name: string | null;
  columns: Column[];
  swimlanes: Swimlane[];
  cards: Card[];
  labels: Label[];
  members: BoardMembership[];
  created_at: string;
  updated_at: string;
  current_user_role: "site_admin" | "admin" | "member" | "viewer" | null;
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
}

export interface GroupMembership {
  id: number;
  user: User;
  role: "admin" | "member";
  joined_at: string;
}

export interface GroupInviteLink {
  id: number;
  token: string;
  is_active: boolean;
  created_at: string;
}
