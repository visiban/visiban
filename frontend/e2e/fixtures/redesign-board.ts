/**
 * The fidelity-check board (#2279): `docs/development/board-redesign/sample-board.json`
 * (mirrored in redesign-sample-board.ts) expanded into
 * a `/full/` payload. 3 lanes, 7 columns, 29 cards, Discovery split into two sub-columns
 * with two tracks. Statuses are derived from a pinned clock (`REDESIGN_NOW`) so the
 * screenshots are stable.
 */
import sample from './redesign-sample-board'
import { BOARD_FULL, BOARD_USER, CARD } from './board'

/** The instant the spec pins the page clock to; the sample's "Oct 11" / "Nov 12" are relative to it. */
export const REDESIGN_NOW = '2026-11-14T15:00:00Z'
const NOW = new Date(REDESIGN_NOW).getTime()
const DAY = 86_400_000

const MONTHS: Record<string, number> = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 }
const ymd = (ms: number) => new Date(ms).toISOString().slice(0, 10)

const columns = sample.columns.map((c, i) => ({
  ...BOARD_FULL.columns[0],
  id: 100 + i,
  uid: `rdcol${String(i).padStart(6, '0')}`,
  name: c.name,
  position: i,
  color: c.color,
  wip_limit: c.wip_limit,
  is_done: c.name === 'Closed Won',
  sub_columns: c.sub_columns.map((n, j) => ({ id: 500 + j, uid: `rdsub${String(j).padStart(6, '0')}`, name: n, position: j })),
  tracks: [] as { id: number; field_id: number; field_uid: string; name: string; position: number }[],
}))

const trackNames = sample.tracks.names
const trackDefs = trackNames.map((name, i) => ({
  id: 900 + i, uid: `rdtrk${String(i).padStart(6, '0')}`, name, field_type: 'dropdown' as const,
  choices: ['Open', 'Done', 'N/A'], position: i + 1, show_on_card: false, is_required: false, help_text: '',
  number_prefix: '', number_suffix: '', number_decimals: null, choice_colors: {},
  threshold_direction: '' as const, threshold_warn: null, threshold_alert: null, threshold_warn_days: null, threshold_alert_days: null,
  created_at: '2026-01-01T00:00:00Z', is_dimension: true,
  choice_resolutions: { Open: 'open', Done: 'satisfied', 'N/A': 'not_applicable' } as Record<string, 'open' | 'satisfied' | 'not_applicable'>,
}))
const discovery = columns.find((c) => c.name === sample.tracks.column)!
discovery.tracks = trackDefs.map((d, i) => ({ id: 700 + i, field_id: d.id, field_uid: d.uid, name: d.name, position: i }))

const dealDef = {
  ...trackDefs[0], id: 899, uid: 'rdfield00deal', name: 'Deal value', field_type: 'number' as const, choices: [], position: 0,
  show_on_card: true, number_prefix: '$', is_dimension: false, choice_resolutions: {},
}

const laneFieldNames = Object.keys(sample.swimlanes[0].fields)
const laneDefs = laneFieldNames.map((name, i) => ({
  id: 300 + i, uid: `rdlnf${String(i).padStart(6, '0')}`, name, field_type: 'text' as const, choices: [], position: i,
  show_on_row: true, is_admin_only: false, is_required: false, help_text: '', number_prefix: '', number_suffix: '',
  number_decimals: null, choice_colors: {}, created_at: '2026-01-01T00:00:00Z',
}))

const swimlanes = sample.swimlanes.map((l, i) => ({
  ...BOARD_FULL.swimlanes[0],
  id: 200 + i,
  uid: `rdlane${String(i).padStart(6, '0')}`,
  name: l.name,
  position: i,
  color: l.color,
  wip_limit: l.wip_limit,
  custom_field_values: laneDefs.map((d) => ({ field_definition: d.id, value: (l.fields as Record<string, string>)[d.name] })),
}))

const labelNames = Array.from(new Set(sample.cards.map((c) => c.label)))
const labelColors = ['#3B82F6', '#10B981', '#F59E0B', '#8B5CF6']
const labels = labelNames.map((name, i) => ({ id: 400 + i, name, color: labelColors[i % labelColors.length] }))

const DANA = { id: 2, username: 'dana', display_name: 'Dana Ellis', avatar_url: '' }

const cards = sample.cards.map((c, i) => {
  const col = columns.find((x) => x.name === c.column)!
  const lane = swimlanes.find((x) => x.name === c.swimlane)!
  let due: string | null = null
  let stale = false
  let movedMs = NOW - 2 * DAY
  if (c.status === 'overdue') {
    const [m, d] = String(c.status_detail).split(' ')
    due = ymd(Date.UTC(2026, MONTHS[m], Number(d)))
  } else if (c.status === 'due soon') {
    due = ymd(NOW + 3 * DAY)
  } else if (c.status === 'stale') {
    stale = true
    movedMs = NOW - Number(c.status_detail) * DAY
  }
  const values: { field_definition: number; value: string }[] = [{ field_definition: dealDef.id, value: String(c.deal_value) }]
  if ('tracks' in c && c.tracks) {
    for (const d of trackDefs) {
      const v = (c.tracks as Record<string, string>)[d.name]
      if (v === 'done') values.push({ field_definition: d.id, value: 'Done' })
      if (v === 'na') values.push({ field_definition: d.id, value: 'N/A' })
    }
  }
  const sub = 'sub_column' in c ? col.sub_columns.findIndex((s) => s.name === c.sub_column) : 0
  return {
    ...CARD,
    id: 1000 + i,
    uid: `rdcard${String(i).padStart(5, '0')}`,
    column: col.id,
    swimlane: lane.id,
    title: c.title,
    description: '',
    priority: 'medium' as const,
    labels: [labels.find((l) => l.name === c.label)!],
    due_date: due,
    position: i,
    is_stale: stale,
    created_at: new Date(movedMs).toISOString(),
    last_moved_at: new Date(movedMs).toISOString(),
    column_entered_at: new Date(movedMs).toISOString(),
    custom_field_values: values,
    gates_passed: Math.max(sub, 0),
    // Every third card is assigned, so the face shows the avatar the reference draws.
    assignee: i % 3 === 0 ? DANA : null,
  }
})

export const REDESIGN_BOARD = {
  ...BOARD_FULL,
  id: 77,
  uid: 'rdboard0077x',
  name: 'Sales pipeline',
  columns,
  swimlanes,
  cards,
  labels,
  members: [{ ...BOARD_FULL.members[0], user: BOARD_USER }],
  custom_field_definitions: [dealDef, ...trackDefs],
  swimlane_custom_field_definitions: laneDefs,
  staleness_threshold_days: 14,
  card_density: 'comfortable' as const,
  default_preset: 'classic' as const,
}

/**
 * Board history for the activity drawer capture: seven moves between the sample's
 * columns, newest first, so the drawer lists entries like the reference does.
 */
export const REDESIGN_MOVEMENTS = cards.slice(0, 7).map((card, i) => {
  const to = columns[Math.min(i + 1, columns.length - 1)]
  const from = columns[Math.min(i, columns.length - 1)]
  const lane = swimlanes.find((l) => l.id === card.swimlane)!
  return {
    id: 8000 + i,
    card_uid: card.uid,
    card_title: card.title,
    from_column: from.id, from_column_name: from.name, from_column_uid: from.uid,
    to_column: to.id, to_column_name: to.name, to_column_uid: to.uid,
    from_swimlane: lane.id, from_swimlane_name: lane.name, from_swimlane_uid: lane.uid,
    to_swimlane: lane.id, to_swimlane_name: lane.name, to_swimlane_uid: lane.uid,
    moved_by: DANA,
    moved_at: new Date(NOW - (i + 1) * 3 * 3_600_000).toISOString(),
    notes: '',
    movement_type: 'move' as const,
    imported_from_username: null,
  }
})
