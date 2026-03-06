export interface User {
  id: number;
  username: string;
  email: string;
  first_name: string;
  last_name: string;
  avatar_url: string;
}

export interface BoardMembership {
  id: number;
  user: User;
  role: "admin" | "member" | "viewer";
  joined_at: string;
}

export interface Column {
  id: number;
  name: string;
  position: number;
  color: string;
  wip_limit: number | null;
  weight_limit: number | null;
}

export interface Customer {
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

export interface Card {
  id: number;
  column: number;
  customer: number;
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
}

export interface CardMovement {
  id: number;
  from_column: number | null;
  from_column_name: string | null;
  to_column: number | null;
  to_column_name: string | null;
  from_customer: number | null;
  from_customer_name: string | null;
  to_customer: number | null;
  to_customer_name: string | null;
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
  | "attachment_deleted";

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
  member_count: number;
  created_at: string;
  updated_at: string;
}

export interface BoardFull {
  id: number;
  name: string;
  description: string;
  columns: Column[];
  customers: Customer[];
  cards: Card[];
  labels: Label[];
  members: BoardMembership[];
  created_at: string;
  updated_at: string;
}
