/**
 * Deterministic fixture data for the marketing-shots spec (#1039).
 *
 * The story every shot tells: one agency ("Meridian Cloud Services") running many
 * independent customer accounts through one shared onboarding pipeline. Customers
 * are swimlanes, pipeline stages are columns, and each card is one customer project.
 *
 * Every timestamp is derived from CLOCK so the output never depends on the day the
 * shots are taken. Shapes are annotated with the real interfaces from src/types, so
 * a serializer field added to the app fails `tsc -p tsconfig.e2e.json` here instead
 * of silently rendering a half-empty screenshot.
 */
import type {
  AdminInviteLink,
  AdminUser,
  BoardFull,
  BoardPublic,
  BoardUser,
  Board,
  Card,
  CardChecklistItem,
  CardComment,
  CardMovement,
  CardTimelineEntry,
  Column,
  Group,
  GroupMembership,
  Label,
  PublicCard,
  PublicSwimlane,
  SiteConfig,
  SiteEmailSettings,
  SiteSettings,
  Swimlane,
  User,
} from '../../src/types'

/** The wall-clock every shot is rendered at (applied via page.clock in the spec). */
export const CLOCK = new Date('2026-10-14T15:00:00Z')

const HOUR = 3_600_000
const DAY = 24 * HOUR

/** ISO timestamp `ms` before CLOCK. */
function ago(ms: number): string {
  return new Date(CLOCK.getTime() - ms).toISOString()
}

/** Calendar date (YYYY-MM-DD) `days` from CLOCK; negative = past. */
function dateIn(days: number): string {
  return new Date(CLOCK.getTime() + days * DAY).toISOString().slice(0, 10)
}

// ---------------------------------------------------------------------------
// People
// ---------------------------------------------------------------------------

const person = (id: number, username: string, display_name: string): BoardUser => ({
  id,
  username,
  display_name,
  avatar_url: '',
})

export const PRIYA = person(1, 'priya', 'Priya Raman')
export const MARCUS = person(2, 'marcus', 'Marcus Webb')
export const ELENA = person(3, 'elena', 'Elena Sokolova')
export const TOMAS = person(4, 'tomas', 'Tomás Herrera')
export const AIKO = person(5, 'aiko', 'Aiko Tanaka')
const TEAM = [PRIYA, MARCUS, ELENA, TOMAS, AIKO]

export const CURRENT_USER: User = {
  id: PRIYA.id,
  username: PRIYA.username,
  email: 'priya.raman@meridiancloud.example',
  first_name: 'Priya',
  last_name: 'Raman',
  avatar_url: '',
  display_name: PRIYA.display_name,
  // Site admin so the /admin shot renders; also makes every role-gated control visible.
  is_site_admin: true,
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
  // Suppresses the first-run onboarding tour overlay.
  has_completed_tour: true,
  theme: 'light',
  default_board_id: null,
  uploads_enabled: true,
  git_lens_enabled: false,
  maintenance_mode: false,
  maintenance_message: '',
  demo_mode: false,
  demo_next_reset_at: null,
}

export const SITE_CONFIG: SiteConfig = {
  registration_open: false,
  registration_mode: 'invite_only',
  demo_mode: false,
  demo_login: null,
  demo_reset_schedule: null,
  demo_next_reset_at: null,
  invite_email_available: true,
  git_lens_enabled: false,
  maintenance_mode: false,
  maintenance_message: '',
}

// ---------------------------------------------------------------------------
// The onboarding board (shots 02, 03, 05)
// ---------------------------------------------------------------------------

export const BOARD_ID = 101
export const BOARD_UID = 'bd101onbrdng'
export const SHARE_TOKEN = 'mkt-share-token-onboarding-pipeline'

const col = (
  id: number,
  name: string,
  position: number,
  color: string,
  extra: Partial<Column> = {},
): Column => ({
  id,
  uid: `col${String(id).padStart(8, '0')}`,
  name,
  position,
  color,
  wip_limit: null,
  weight_limit: null,
  allow_card_creation: true,
  is_done: false,
  policy: null,
  ...extra,
})

export const COLUMNS: Column[] = [
  col(1, 'Intake', 0, '#6B7280'),
  col(2, 'Kickoff', 1, '#3B82F6'),
  col(3, 'Build', 2, '#F59E0B', { wip_limit: 6 }),
  col(4, 'Customer Review', 3, '#8B5CF6'),
  col(5, 'Live', 4, '#22C55E', { allow_card_creation: false, is_done: true }),
]

const lane = (id: number, name: string, position: number, color: string, contact: string): Swimlane => ({
  id,
  uid: `swm${String(id).padStart(8, '0')}`,
  name,
  contact_email: contact,
  notes: '',
  position,
  color,
  is_collapsed: false,
  created_at: ago(120 * DAY),
  custom_field_values: [],
  wip_limit: null,
  weight_limit: null,
  limit_enforcement: null,
  limit_column_ids: null,
})

/** One swimlane per customer account. */
export const SWIMLANES: Swimlane[] = [
  lane(1, 'Northwind Traders', 0, '#3B82F6', 'it@northwind.example'),
  lane(2, 'Contoso Logistics', 1, '#10B981', 'ops@contoso.example'),
  lane(3, 'Fabrikam Health', 2, '#EF4444', 'cio@fabrikam.example'),
  lane(4, 'Tailspin Outdoor', 3, '#F59E0B', 'platform@tailspin.example'),
  lane(5, 'Adventure Works', 4, '#8B5CF6', 'it@adventure-works.example'),
]

const lbl = (id: number, name: string, color: string): Label => ({
  id,
  uid: `lbl${String(id).padStart(8, '0')}`,
  name,
  color,
})

export const LABELS: Label[] = [
  lbl(1, 'SSO', '#3B82F6'),
  lbl(2, 'Data migration', '#F59E0B'),
  lbl(3, 'Security review', '#EF4444'),
  lbl(4, 'Training', '#10B981'),
  lbl(5, 'Contract', '#8B5CF6'),
]

/** Compact card spec; expanded to a full Card by buildCard(). */
interface CardSpec {
  id: number
  column: number
  lane: number
  title: string
  description: string
  priority: Card['priority']
  assignee: BoardUser | null
  labels: number[]
  /** Days from CLOCK (negative = overdue); null = no due date. */
  due: number | null
  weight: number
  checklist: [done: number, total: number]
  /** Days since the card last moved. */
  idleDays: number
  stale?: boolean
  blockers?: number
}

const CARD_SPECS: CardSpec[] = [
  // Northwind Traders
  { id: 1, column: 5, lane: 1, title: 'Tenant provisioning', description: 'Create the Northwind tenant, regions, and base network.', priority: 'medium', assignee: MARCUS, labels: [], due: -21, weight: 2, checklist: [5, 5], idleDays: 18 },
  { id: 2, column: 4, lane: 1, title: 'SSO and SCIM provisioning', description: 'Connect Northwind\'s Okta tenant for single sign-on and automatic user provisioning.\n\n- Map the 14 IdP groups to Meridian roles\n- Confirm just-in-time provisioning with their IT lead\n- Walk through the access review report together', priority: 'high', assignee: PRIYA, labels: [1, 3], due: 2, weight: 5, checklist: [4, 6], idleDays: 1 },
  { id: 3, column: 3, lane: 1, title: 'Warehouse data migration', description: 'Move 6 years of order history from the legacy ERP.', priority: 'urgent', assignee: ELENA, labels: [2], due: -1, weight: 8, checklist: [3, 9], idleDays: 3, blockers: 1 },
  // Contoso Logistics
  { id: 4, column: 5, lane: 2, title: 'Fleet telemetry ingest', description: 'Stream vehicle telemetry into the shared analytics workspace.', priority: 'medium', assignee: TOMAS, labels: [2], due: -9, weight: 5, checklist: [6, 6], idleDays: 9 },
  { id: 5, column: 3, lane: 2, title: 'Dispatcher dashboards', description: 'Role-based dashboards for the regional dispatch desks.', priority: 'medium', assignee: AIKO, labels: [4], due: 6, weight: 3, checklist: [2, 5], idleDays: 2 },
  { id: 6, column: 2, lane: 2, title: 'Carrier API integration', description: 'Connect the three carrier APIs used for proof of delivery.', priority: 'high', assignee: MARCUS, labels: [1], due: 12, weight: 5, checklist: [0, 4], idleDays: 4 },
  // Fabrikam Health
  { id: 7, column: 4, lane: 3, title: 'HIPAA security review', description: 'Annual BAA review and penetration test sign-off.', priority: 'urgent', assignee: PRIYA, labels: [3, 5], due: 1, weight: 8, checklist: [7, 8], idleDays: 2 },
  { id: 8, column: 3, lane: 3, title: 'Patient portal SSO', description: 'Federated sign-in for the patient portal.', priority: 'high', assignee: ELENA, labels: [1], due: 8, weight: 5, checklist: [1, 5], idleDays: 6, stale: true },
  { id: 9, column: 2, lane: 3, title: 'Clinician training sessions', description: 'Three live sessions for clinic leads, recorded for new hires.', priority: 'low', assignee: AIKO, labels: [4], due: 20, weight: 2, checklist: [0, 3], idleDays: 5 },
  { id: 10, column: 1, lane: 3, title: 'Audit log export', description: 'Scheduled export of audit logs to the customer SIEM.', priority: 'medium', assignee: null, labels: [3], due: null, weight: 3, checklist: [0, 0], idleDays: 2 },
  // Tailspin Outdoor
  { id: 11, column: 5, lane: 4, title: 'Storefront cutover', description: 'DNS and certificate cutover for the regional storefronts.', priority: 'high', assignee: TOMAS, labels: [], due: -4, weight: 3, checklist: [4, 4], idleDays: 4 },
  { id: 12, column: 3, lane: 4, title: 'Inventory sync', description: 'Nightly inventory sync from 42 retail locations.', priority: 'medium', assignee: TOMAS, labels: [2], due: 4, weight: 5, checklist: [3, 5], idleDays: 1 },
  { id: 13, column: 1, lane: 4, title: 'Seasonal capacity plan', description: 'Plan autoscaling headroom for the holiday peak.', priority: 'medium', assignee: MARCUS, labels: [5], due: 30, weight: 2, checklist: [0, 0], idleDays: 3 },
  // Adventure Works
  { id: 14, column: 2, lane: 5, title: 'Partner portal build', description: 'Self-service portal for 200 reseller partners.', priority: 'high', assignee: AIKO, labels: [1, 4], due: 15, weight: 8, checklist: [1, 7], idleDays: 2 },
  { id: 15, column: 1, lane: 5, title: 'Reseller data import', description: 'Import reseller accounts and pricing tiers from spreadsheets.', priority: 'low', assignee: null, labels: [2], due: null, weight: 3, checklist: [0, 0], idleDays: 1 },
  { id: 16, column: 1, lane: 5, title: 'Contract amendment', description: 'Add the EMEA data-residency addendum.', priority: 'medium', assignee: PRIYA, labels: [5], due: 10, weight: 1, checklist: [0, 0], idleDays: 0 },
]

function buildCard(spec: CardSpec): Card {
  const position = CARD_SPECS.filter((c) => c.column === spec.column && c.lane === spec.lane && c.id < spec.id).length
  return {
    id: spec.id,
    uid: `crd${String(spec.id).padStart(8, '0')}`,
    column: spec.column,
    swimlane: spec.lane,
    title: spec.title,
    description: spec.description,
    priority: spec.priority,
    assignee: spec.assignee,
    labels: spec.labels.map((i) => LABELS[i - 1]),
    due_date: spec.due === null ? null : dateIn(spec.due),
    weight: spec.weight,
    position,
    created_by: PRIYA,
    created_at: ago((spec.idleDays + 40) * DAY),
    updated_at: ago(spec.idleDays * DAY),
    last_moved_at: ago(spec.idleDays * DAY),
    last_move_is_creation: false,
    attachment_count: spec.id === 2 ? 2 : 0,
    checklist_total: spec.checklist[1],
    checklist_done: spec.checklist[0],
    is_stale: spec.stale ?? false,
    archived_at: null,
    version: 1,
    custom_field_values: [],
    blocker_count: spec.blockers ?? 0,
    external_ref: null,
    is_blocked: (spec.blockers ?? 0) > 0,
    blocked_at: null,
    blocked_reason: '',
  }
}

export const CARDS: Card[] = CARD_SPECS.map(buildCard)

/** The card whose drawer is shown in shot 03. */
export const DETAIL_CARD = CARDS.find((c) => c.id === 2) as Card

export const BOARD_FULL: BoardFull = {
  health_status: null,
  effective_health_status: null,
  health_status_source: null,
  id: BOARD_ID,
  uid: BOARD_UID,
  name: 'Customer Onboarding Pipeline',
  description: 'Every customer account moves through the same five stages.',
  owner: PRIYA,
  group: 1,
  group_name: 'Client Delivery',
  group_detail: { id: 1, name: 'Client Delivery', parent: null, parent_name: null },
  columns: COLUMNS,
  swimlanes: SWIMLANES,
  cards: CARDS,
  labels: LABELS,
  members: TEAM.map((user, i) => ({
    id: i + 1,
    user,
    role: i === 0 ? ('admin' as const) : ('member' as const),
    joined_at: ago(110 * DAY),
  })),
  custom_field_definitions: [],
  swimlane_custom_field_definitions: [],
  staleness_threshold_days: 5,
  stale_warning_pct: 50,
  allowed_priorities: [],
  enforce_wip_limits: true,
  enforce_wip_hard: false,
  enforce_weight_limits: false,
  show_wip_at_limit: true,
  show_row_chip_field_names: true,
  export_min_role: 'viewer',
  card_density: 'comfortable',
  is_starred: true,
  created_at: ago(120 * DAY),
  updated_at: ago(1 * DAY),
  current_user_role: 'admin',
  capabilities: { movement_export: true },
  share_token: SHARE_TOKEN,
  share_token_expires_at: null,
  share_link_active: true,
  archived_card_count: 4,
}

// ---------------------------------------------------------------------------
// Card timeline (shot 03)
// ---------------------------------------------------------------------------

const move = (
  id: number,
  by: BoardUser,
  at: string,
  from: Column | null,
  to: Column,
  notes = '',
): CardMovement => ({
  id,
  card_uid: DETAIL_CARD.uid,
  card_title: DETAIL_CARD.title,
  from_column: from?.id ?? null,
  from_column_name: from?.name ?? '',
  from_column_uid: from?.uid ?? '',
  to_column: to.id,
  to_column_name: to.name,
  to_column_uid: to.uid,
  from_swimlane: from ? SWIMLANES[0].id : null,
  from_swimlane_name: from ? SWIMLANES[0].name : '',
  from_swimlane_uid: from ? SWIMLANES[0].uid : '',
  to_swimlane: SWIMLANES[0].id,
  to_swimlane_name: SWIMLANES[0].name,
  to_swimlane_uid: SWIMLANES[0].uid,
  moved_by: by,
  moved_at: at,
  notes,
  movement_type: 'move',
  imported_from_username: null,
})

const MOVES: CardMovement[] = [
  move(904, PRIYA, ago(1 * DAY), COLUMNS[2], COLUMNS[3], 'Okta sandbox verified; handing to the customer.'),
  move(903, MARCUS, ago(6 * DAY), COLUMNS[1], COLUMNS[2]),
  move(902, PRIYA, ago(13 * DAY), COLUMNS[0], COLUMNS[1]),
  move(901, PRIYA, ago(21 * DAY), null, COLUMNS[0]),
]

const moveEntry = (m: CardMovement): CardTimelineEntry => ({
  id: m.id,
  kind: 'move',
  ts: m.moved_at,
  actor: m.moved_by,
  event_type: 'move',
  data: m as unknown as Record<string, unknown>,
  imported_from_username: null,
})

const activityEntry = (
  id: number,
  event_type: string,
  actor: BoardUser,
  at: string,
  from_value: string,
  to_value: string,
): CardTimelineEntry => ({
  id,
  kind: 'activity',
  ts: at,
  actor,
  event_type,
  data: { id, event_type, from_value, to_value, actor, created_at: at, imported_from_username: null },
  imported_from_username: null,
})

/** Newest first, as the server returns it. */
export const TIMELINE: CardTimelineEntry[] = [
  moveEntry(MOVES[0]),
  activityEntry(803, 'priority_change', PRIYA, ago(2 * DAY), 'medium', 'high'),
  moveEntry(MOVES[1]),
  activityEntry(802, 'assignee_change', MARCUS, ago(9 * DAY), 'Marcus Webb', 'Priya Raman'),
  moveEntry(MOVES[2]),
  moveEntry(MOVES[3]),
]

export const COMMENTS: CardComment[] = [
  {
    id: 701,
    author: MARCUS,
    body: 'Northwind confirmed the 14 IdP groups. Role mapping is ready for review.',
    created_at: ago(2 * DAY + 3 * HOUR),
    updated_at: ago(2 * DAY + 3 * HOUR),
    imported_from_username: null,
  },
]

/** Checklist for the detail card (shot 03), in server order. */
export const CHECKLIST: CardChecklistItem[] = [
  ['Map IdP groups to Meridian roles', true],
  ['Confirm just-in-time provisioning', true],
  ['Test deprovisioning in the sandbox', true],
  ['Share the access review report', true],
  ['Customer sign-off on role mapping', false],
  ['Schedule production cutover', false],
].map(([text, done], position) => ({
  id: position + 1,
  text: text as string,
  is_checked: done as boolean,
  position,
  created_by: PRIYA,
}))

// ---------------------------------------------------------------------------
// Dashboard (shot 01): boards + groups
// ---------------------------------------------------------------------------

const boardItem = (
  id: number,
  name: string,
  description: string,
  extra: Partial<Board> = {},
): Board => ({
  health_status: null,
  effective_health_status: null,
  health_status_source: null,
  id,
  uid: `bd${String(id).padStart(10, '0')}`,
  name,
  description,
  owner: PRIYA,
  group: null,
  group_name: null,
  member_count: 5,
  card_count: 12,
  archived_card_count: 0,
  staleness_threshold_days: 5,
  stale_warning_pct: 50,
  allowed_priorities: [],
  enforce_wip_limits: true,
  enforce_wip_hard: false,
  enforce_weight_limits: false,
  show_wip_at_limit: true,
  show_row_chip_field_names: true,
  export_min_role: 'viewer',
  card_density: 'comfortable',
  is_starred: false,
  created_at: ago(120 * DAY),
  updated_at: ago(1 * DAY),
  ...extra,
})

export const BOARDS: Board[] = [
  boardItem(BOARD_ID, 'Customer Onboarding Pipeline', 'Every customer account moves through the same five stages.', {
    group: 1, group_name: 'Client Delivery', card_count: CARDS.length, archived_card_count: 4, is_starred: true,
  }),
  boardItem(102, 'Renewals and Expansions', 'Annual renewals, by account owner.', {
    group: 1, group_name: 'Client Delivery', card_count: 23, member_count: 4, is_starred: true,
  }),
  boardItem(103, 'EMEA Go-Lives', 'Regional launch checklist for EMEA customers.', {
    group: 2, group_name: 'EMEA Accounts', card_count: 9, member_count: 3,
  }),
  boardItem(104, 'Partner Launch Tracker', 'Reseller and integration partner launches.', {
    card_count: 14, member_count: 6, is_starred: true,
  }),
  boardItem(105, 'Security Questionnaires', 'Inbound vendor security reviews, one lane per customer.', {
    card_count: 17, member_count: 3,
  }),
  boardItem(106, 'Incident Retrospectives', 'Post-incident actions with an owner and a due date.', {
    card_count: 8, member_count: 5,
  }),
]

const groupItem = (id: number, name: string, description: string, extra: Partial<Group> = {}): Group => ({
  health_status: null,
  effective_health_status: null,
  health_status_source: null,
  id,
  name,
  description,
  owner: PRIYA,
  parent: null,
  parent_name: null,
  member_count: 5,
  board_count: 2,
  subgroup_count: 0,
  created_at: ago(150 * DAY),
  default_board_member_role: 'member',
  allowed_priorities: [],
  shared_labels: [],
  is_starred: false,
  navigation_only: false,
  can_place_boards: true,
  ...extra,
})

export const GROUPS: Group[] = [
  groupItem(1, 'Client Delivery', 'Everything the delivery team runs for customer accounts.', {
    board_count: 2,
    subgroup_count: 1,
    is_starred: true,
    shared_labels: [
      { id: 11, name: 'SSO', color: '#3B82F6' },
      { id: 12, name: 'Data migration', color: '#F59E0B' },
      { id: 13, name: 'Security review', color: '#EF4444' },
      { id: 14, name: 'Contract', color: '#8B5CF6' },
    ],
    ancestors: [],
  }),
  groupItem(2, 'EMEA Accounts', 'Regional delivery for European and Middle East customers.', {
    parent: 1,
    parent_name: 'Client Delivery',
    board_count: 1,
    member_count: 3,
    ancestors: [{ id: 1, name: 'Client Delivery' }],
  }),
  groupItem(3, 'Platform Operations', 'Reliability, incidents, and capacity planning.', {
    board_count: 1,
    member_count: 4,
  }),
]

export const GROUP_MEMBERS: GroupMembership[] = TEAM.map((user, i) => ({
  id: i + 1,
  user,
  role: i === 0 ? ('admin' as const) : i === 1 ? ('admin' as const) : ('member' as const),
  joined_at: ago((140 - i * 10) * DAY),
  is_inherited: false,
  inherited_from: null,
}))

// ---------------------------------------------------------------------------
// Public share page (shot 05)
// ---------------------------------------------------------------------------

export const PUBLIC_BOARD: BoardPublic = {
  uid: BOARD_UID,
  name: BOARD_FULL.name,
  // The share payload omits column `policy` (#1101, PublicColumnSerializer).
  columns: COLUMNS.map((c) => ({
    id: c.id, uid: c.uid, name: c.name, position: c.position, color: c.color,
    wip_limit: c.wip_limit, weight_limit: c.weight_limit,
    allow_card_creation: c.allow_card_creation, is_done: c.is_done,
  })),
  swimlanes: SWIMLANES.map(
    (s): PublicSwimlane => ({
      id: s.id,
      uid: s.uid,
      name: s.name,
      position: s.position,
      color: s.color,
      is_collapsed: s.is_collapsed,
      created_at: s.created_at,
    }),
  ),
  labels: LABELS,
  cards: CARDS.map(
    (c): PublicCard => ({
      uid: c.uid,
      column: c.column,
      swimlane: c.swimlane,
      title: c.title,
      priority: c.priority,
      labels: c.labels,
      due_date: c.due_date,
      weight: c.weight,
      position: c.position,
      checklist_total: c.checklist_total,
      checklist_done: c.checklist_done,
      assignee: c.assignee ? { display_name: c.assignee.display_name } : null,
      last_moved_at: c.last_moved_at,
      last_move_is_creation: false,
      is_stale: c.is_stale,
      blocker_count: c.blocker_count,
    }),
  ),
}

// ---------------------------------------------------------------------------
// Admin (shot 06)
// ---------------------------------------------------------------------------

const adminUser = (
  user: BoardUser,
  email: string,
  extra: Partial<AdminUser> = {},
): AdminUser => ({
  id: user.id,
  username: user.username,
  email,
  display_name: user.display_name,
  first_name: user.display_name.split(' ')[0],
  last_name: user.display_name.split(' ').slice(1).join(' '),
  avatar_url: '',
  is_active: true,
  is_site_admin: false,
  can_access_all_content: false,
  is_superuser: false,
  must_change_password: false,
  date_joined: ago(130 * DAY),
  owned_boards: [],
  has_completed_tour: true,
  ...extra,
})

export const ADMIN_USERS: AdminUser[] = [
  adminUser(PRIYA, 'priya.raman@meridiancloud.example', {
    is_site_admin: true,
    owned_boards: BOARDS.slice(0, 3).map((b) => ({ id: b.id, uid: b.uid, name: b.name })),
  }),
  adminUser(MARCUS, 'marcus.webb@meridiancloud.example', { is_site_admin: true, date_joined: ago(125 * DAY) }),
  adminUser(ELENA, 'elena.sokolova@meridiancloud.example', { date_joined: ago(100 * DAY) }),
  adminUser(TOMAS, 'tomas.herrera@meridiancloud.example', { date_joined: ago(90 * DAY) }),
  adminUser(AIKO, 'aiko.tanaka@meridiancloud.example', { date_joined: ago(45 * DAY) }),
  adminUser(person(6, 'devon', 'Devon Clarke'), 'devon.clarke@meridiancloud.example', {
    is_active: false,
    date_joined: ago(200 * DAY),
  }),
]

export const SITE_SETTINGS: SiteSettings = {
  registration_mode: 'invite_only',
  uploads_enabled: true,
  maintenance_mode: false,
  maintenance_message: '',
}

export const ADMIN_INVITE_LINKS: AdminInviteLink[] = [
  {
    id: 1,
    prefix: 'vbni_4kQ7',
    expires_at: dateIn(5) + 'T00:00:00Z',
    single_use: true,
    used_at: null,
    revoked_at: null,
    created_at: ago(2 * DAY),
    use_count: 0,
    status: 'pending',
    created_by_username: 'priya',
    delivery: 'email',
  },
]

export const EMAIL_SETTINGS: SiteEmailSettings = {
  config_source: 'database',
  host: 'smtp.meridiancloud.example',
  port: 587,
  username: 'notifications',
  use_tls: true,
  use_ssl: false,
  from_email: 'no-reply@meridiancloud.example',
  timeout: 10,
  password_set: true,
  password_decryptable: true,
  effective_source: 'database',
  effective_host: 'smtp.meridiancloud.example',
  effective_port: 587,
  effective_from_email: 'no-reply@meridiancloud.example',
  effective_use_tls: true,
}
