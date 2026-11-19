// Active-filter chip derivation shared by FilterBar's chip row and the Filter
// panel's "Filtered by" row (#2315), so both dismiss exactly the same way.
import type { BoardFull, BoardUser } from "../../types";
import { userDisplayName } from "../../types";
import { formatCustomFieldValue } from "../../utils/customFieldValue";
import type { LaneValueFormatter } from "../../utils/laneFilter";
import { numberFilterDisplay } from "../../utils/numberFilter";
import { stageSubColumns } from "../../utils/stages";
import { DUE_DATE_OPTIONS, TRACK_STATE_OPTIONS, PRIORITY_OPTIONS, emptyCustomFieldFilterValue, isCustomFieldFilterActive } from "./filterOptions";
import type { FilterState } from "./FilterBar";

export interface FilterChipItem {
  key: string;
  label: string;
  colorDot?: string;
  avatarUser?: BoardUser;
  onDismiss: () => void;
}

/** Formats a swimlane custom-field value for a lane chip or rule summary. */
export function makeLaneValueFormatter(
  swimlaneDefs: (Parameters<typeof formatCustomFieldValue>[0] & { id: number })[] | undefined,
  userDateFormat: string,
): LaneValueFormatter {
  return (field, raw) => {
    // A built-in field (#2336, string id) has no definition and shows as stored.
    const def = (swimlaneDefs ?? []).find((d) => d.id === field.id);
    if (!def) return raw;
    const shown = formatCustomFieldValue(def, raw, userDateFormat);
    // A number with no display format comes back as typed; group its
    // thousands so "Deal value 50,000 or more" reads at a glance.
    if (def.field_type === "number" && shown === raw && Number.isFinite(Number(raw))) {
      return Number(raw).toLocaleString("en-US", { maximumFractionDigits: 10 });
    }
    return shown;
  };
}

/**
 * One chip per active filter value (search and lane rules excluded: the search
 * input already shows its state and lane chips carry their own join logic).
 * Dismissing a chip clears only that value; a custom field keeps its control
 * visible (visibleCustomFieldFilterIds is untouched).
 */
export function buildFilterChips(
  board: BoardFull,
  filters: FilterState,
  onChange: (next: FilterState) => void,
  userDateFormat: string,
): FilterChipItem[] {
  const chips: FilterChipItem[] = [];

  // Assignee choices: the board's members, then any assignee on a card who is
  // not in the member list. The list omits users with all-content access for
  // readers who are not site admins (#1714), and their cards stay filterable.
  const assigneeUsers = new Map<number, BoardUser>(board.members.map((m) => [m.user.id, m.user]));
  for (const card of board.cards) {
    if (card.assignee && !assigneeUsers.has(card.assignee.id)) assigneeUsers.set(card.assignee.id, card.assignee);
  }

  for (const assigneeId of filters.assigneeIds) {
    if (assigneeId === -1) {
      chips.push({
        key: "assignee:-1",
        label: "Unassigned",
        onDismiss: () => onChange({ ...filters, assigneeIds: filters.assigneeIds.filter((id) => id !== -1) }),
      });
    } else {
      const assignee = assigneeUsers.get(assigneeId);
      if (assignee) {
        chips.push({
          key: `assignee:${assigneeId}`,
          label: userDisplayName(assignee),
          avatarUser: assignee,
          onDismiss: () => onChange({ ...filters, assigneeIds: filters.assigneeIds.filter((id) => id !== assigneeId) }),
        });
      }
    }
  }

  for (const labelId of filters.labelIds) {
    const label = board.labels.find((l) => l.id === labelId);
    if (label) {
      chips.push({
        key: `label:${labelId}`,
        label: label.name,
        colorDot: label.color,
        onDismiss: () => onChange({ ...filters, labelIds: filters.labelIds.filter((id) => id !== labelId) }),
      });
    }
  }

  for (const priority of filters.priorities) {
    const option = PRIORITY_OPTIONS.find((o) => o.value === priority);
    if (option) {
      chips.push({
        key: `priority:${priority}`,
        label: option.label,
        colorDot: option.color,
        onDismiss: () => onChange({ ...filters, priorities: filters.priorities.filter((p) => p !== priority) }),
      });
    }
  }

  if (filters.dueDate !== null) {
    const option = DUE_DATE_OPTIONS.find((o) => o.value === filters.dueDate);
    if (option) {
      chips.push({
        key: `due:${filters.dueDate}`,
        label: option.label,
        onDismiss: () => onChange({ ...filters, dueDate: null }),
      });
    }
  }

  if (filters.blockedOnly) {
    chips.push({
      key: "blocked-only",
      label: "Blocked only",
      onDismiss: () => onChange({ ...filters, blockedOnly: false }),
    });
  }

  // #2367 — one chip per picked sub-column ("Review: Doing") and per track state.
  // An id that no longer resolves (a removed sub-column) has no chip, like a removed label.
  for (const id of filters.subColumnIds ?? []) {
    for (const col of board.columns) {
      const sub = stageSubColumns(col).find((s) => s.id === id);
      if (!sub) continue;
      chips.push({
        key: `sub:${id}`,
        label: `${col.name}: ${sub.name}`,
        onDismiss: () => {
          const rest = (filters.subColumnIds ?? []).filter((x) => x !== id);
          onChange({ ...filters, subColumnIds: rest.length > 0 ? rest : undefined });
        },
      });
    }
  }
  for (const state of filters.trackStates ?? []) {
    const option = TRACK_STATE_OPTIONS.find((o) => o.value === state);
    if (!option) continue;
    chips.push({
      key: `track:${state}`,
      label: `Any track ${option.label.toLowerCase()}`,
      onDismiss: () => {
        const rest = (filters.trackStates ?? []).filter((x) => x !== state);
        onChange({ ...filters, trackStates: rest.length > 0 ? rest : undefined });
      },
    });
  }

  // #371 — custom field filter chips. Dismissing clears the value but keeps
  // the field in visibleCustomFieldFilterIds so its (now-empty) control
  // doesn't disappear mid-interaction.
  for (const def of board.custom_field_definitions) {
    const v = filters.customFields[def.id];
    if (!v || !isCustomFieldFilterActive(v)) continue;
    const displayValue = v.kind === "choice" || v.kind === "multi_choice" ? v.values.join(", ") : v.kind === "text" ? v.query : v.kind === "number" ? numberFilterDisplay(v, (raw) => formatCustomFieldValue(def, raw, userDateFormat)) : formatCustomFieldValue(def, v.equals, userDateFormat);
    chips.push({
      key: `cf:${def.id}`,
      label: `${def.name}: ${displayValue}`,
      onDismiss: () => onChange({ ...filters, customFields: { ...filters.customFields, [def.id]: emptyCustomFieldFilterValue(def) } }),
    });
  }

  return chips;
}
