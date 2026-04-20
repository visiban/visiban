/**
 * Canonical fixture data for Playwright page.route() handlers.
 *
 * All E2E tests import from here — never define inline fixture objects in
 * spec files.  This is the single source of truth for mock API shapes so
 * that a serializer field addition is caught in one place.
 *
 * Shapes must exactly match the backend serializer responses.  When a
 * serializer field is added, update this file in the same MR.
 */

export const BOARD_USER = {
  id: 1,
  username: 'testuser',
  display_name: 'Test User',
  avatar_url: '',
}

export const USER = {
  id: 1,
  username: 'testuser',
  email: 'test@example.com',
  first_name: 'Test',
  last_name: 'User',
  display_name: 'Test User',
  avatar_url: '',
  is_site_admin: false,
  can_access_all_content: false,
  must_change_password: false,
  must_change_username: false,
  has_usable_password: true,
  timezone: 'UTC',
  date_format: 'MMM D, YYYY',
  time_format: 'h:mm A',
  number_locale: 'en-US',
  notif_card_assigned: true,
  notif_mentioned: true,
  notif_due_soon: true,
  notif_card_moved: false,
  notif_comment_added: false,
  notif_board_invite: true,
  close_editor_on_enter: false,
  has_completed_tour: true,
  theme: 'system' as const,
  default_board_id: null,
  uploads_enabled: false,
}

export const COLUMN_TODO = {
  id: 1,
  uid: 'col0000001t',
  name: 'To Do',
  position: 0,
  color: '#6B7280',
  wip_limit: null,
  weight_limit: null,
  allow_card_creation: true,
  is_done: false,
}

export const COLUMN_DONE = {
  id: 2,
  uid: 'col0000002d',
  name: 'Done',
  position: 1,
  color: '#22C55E',
  wip_limit: null,
  weight_limit: null,
  allow_card_creation: false,
  is_done: true,
}

export const SWIMLANE = {
  id: 1,
  uid: 'swim000001g',
  name: 'General',
  contact_email: '',
  notes: '',
  position: 0,
  color: '#3B82F6',
  is_collapsed: false,
  created_at: '2026-01-01T00:00:00Z',
}

export const CARD = {
  id: 1,
  uid: 'card000001a',
  column: 1,
  swimlane: 1,
  title: 'First task',
  description: 'This is the card description.',
  priority: 'medium' as const,
  assignee: null,
  labels: [],
  due_date: null,
  weight: 1,
  position: 0,
  created_by: BOARD_USER,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
  last_moved_at: null,
  attachment_count: 0,
  checklist_total: 0,
  checklist_done: 0,
  is_stale: false,
  archived_at: null,
  version: 1,
}

export const BOARD_LIST_ITEM = {
  id: 1,
  uid: 'board00001x',
  name: 'Test Board',
  description: '',
  owner: BOARD_USER,
  group: null,
  member_count: 1,
  card_count: 1,
  my_role: 'admin' as const,
  is_starred: false,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
}

export const BOARD_FULL = {
  id: 1,
  uid: 'board00001x',
  name: 'Test Board',
  description: '',
  owner: BOARD_USER,
  members: [
    {
      id: 1,
      user: BOARD_USER,
      role: 'admin' as const,
      is_moderator: false,
      joined_at: '2026-01-01T00:00:00Z',
    },
  ],
  group: null,
  columns: [COLUMN_TODO, COLUMN_DONE],
  swimlanes: [SWIMLANE],
  cards: [CARD],
  labels: [],
  staleness_threshold_days: 7,
  stale_warning_pct: 50,
  allowed_priorities: [],
  enforce_wip_limits: true,
  enforce_wip_hard: false,
  enforce_weight_limits: false,
  share_token: null,
  my_role: 'admin' as const,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
}

export const SITE_CONFIG = {
  registration_open: false,
  registration_mode: 'closed' as const,
}

export const AUTH_PROVIDERS = {
  google: false,
  github: false,
  gitlab: false,
  oidc: false,
  oidc_name: null,
}
