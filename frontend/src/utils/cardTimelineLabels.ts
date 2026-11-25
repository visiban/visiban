import type { CardActivity, CardGateTransition, CardMovement, CardTimelineEntry } from "../types";
import { userDisplayName } from "../types";
import { formatBlockedDuration } from "./blockedState";
import { formatDateStr } from "./date";

/** Longest item name a History label quotes before an ellipsis (#2199). */
const ITEM_TEXT_IN_LABEL_MAX = 40;

/**
 * `Checklist item "Write tests"`, or `Checklist item` when the row names no
 * item (#2199). The name is capped: the History row is a single truncated
 * line, and a long name must not push the from → to values out of view.
 */
function checklistItemLead(itemText: string | null | undefined): string {
  if (!itemText) return "Checklist item";
  const name = itemText.length > ITEM_TEXT_IN_LABEL_MAX
    ? `${itemText.slice(0, ITEM_TEXT_IN_LABEL_MAX - 1)}\u2026`
    : itemText;
  return `Checklist item "${name}"`;
}

/** Caps a custom field name for a History row, like the checklist item name. */
function cappedName(name: string): string {
  return name.length > ITEM_TEXT_IN_LABEL_MAX ? `${name.slice(0, ITEM_TEXT_IN_LABEL_MAX - 1)}\u2026` : name;
}

/**
 * The " · Assigned by {name}" tail of an assignee override row (#2594), or ""
 * with no assigner (admin basis, older or imported row, deleted account).
 * Exposed so the History row can render it apart from the truncating text.
 */
export function overrideAssignerSuffix(event_type: string, data: Record<string, unknown>): string {
  const d = data as unknown as CardActivity;
  return event_type === "override_used" && d.from_value === "assignee" && d.assigned_by
    ? ` · Assigned by ${userDisplayName(d.assigned_by)}`
    : "";
}

/** One-line description of a timeline activity entry (the History tab's row text). */
export function activityLabel(
  event_type: string,
  data: Record<string, unknown>,
  userDateFormat = "MM/DD/YYYY"
): string {
  const d = data as unknown as CardActivity;
  switch (event_type) {
    case "priority_change":
      return `Priority: ${d.from_value} → ${d.to_value}`;
    case "weight_change":
      return `Weight: ${d.from_value} → ${d.to_value}`;
    case "assignee_change":
      return `Assignee: ${d.from_value} → ${d.to_value}`;
    case "label_change":
      return `Labels: ${d.to_value}`;
    case "title_change":
      return `Renamed: "${d.from_value}" → "${d.to_value}"`;
    case "description_change":
      return "Description updated";
    case "comment_added":
      return "Comment added";
    case "attachment_added":
      return `Attached: ${d.to_value || "file"}`;
    case "attachment_deleted":
      return `Removed: ${d.from_value || "file"}`;
    case "due_date_change": {
      const fmt = (iso: string) => (iso ? formatDateStr(iso, userDateFormat) : "(none)");
      return `Due date: ${fmt(d.from_value)} → ${fmt(d.to_value)}`;
    }
    // #445: per-item assignee and due date. Not grouped like the other
    // checklist events, whose to_value is the item text. #2199: item_text
    // names the item; rows recorded before 1.3 have none and keep the
    // unnamed label.
    case "checklist_item_assigned":
      return `${checklistItemLead(d.item_text)} assignee: ${d.from_value || "(none)"} → ${d.to_value || "(none)"}`;
    case "checklist_item_due_changed": {
      const fmt = (iso: string) => (iso ? formatDateStr(iso, userDateFormat) : "(none)");
      return `${checklistItemLead(d.item_text)} due: ${fmt(d.from_value)} → ${fmt(d.to_value)}`;
    }
    // Manual block state (#1149): blocked carries the reason; unblocked the
    // reason it cleared (from_value) and the optional resolution (to_value).
    case "blocked":
      return d.to_value ? `Blocked: ${d.to_value}` : "Blocked";
    case "unblocked": {
      // The timeline adds the closed block's duration (#1149); null or
      // absent when it has no matching block (e.g. imported history).
      const seconds = (data as { block_duration_seconds?: number | null }).block_duration_seconds;
      const head = typeof seconds === "number" ? `Unblocked after ${formatBlockedDuration(seconds * 1000, 2)}` : "Unblocked";
      return d.to_value ? `${head}: ${d.to_value}` : d.from_value ? `${head} (was: ${d.from_value})` : head;
    }
    // Any custom field value change (#1921); item_text names the field.
    case "custom_field_changed":
      return `${d.item_text ? cappedName(d.item_text) : "Custom field"}: ${d.from_value || "(none)"} → ${d.to_value || "(none)"}`;
    // Cross-board links (#1104). The row names nothing about the other card,
    // not even its id (from_value and to_value are blank), because it may be on
    // a board this reader cannot open. The label ignores both values anyway.
    case "parent_linked":
      return "Parent linked";
    case "parent_unlinked":
      return "Parent unlinked";
    case "child_linked":
      return "Child linked";
    case "child_unlinked":
      return "Child unlinked";
    // #2208: the whole board on the other end was deleted. The parent's row
    // carries only a count (to_value); neither row names the board, so every
    // reader gets the same sentence whether or not they could open it.
    case "children_removed_board_deleted": {
      const n = Number.parseInt(d.to_value ?? "", 10);
      const count = Number.isFinite(n) && n > 0 ? n : 1;
      return `${count} ${count === 1 ? "child" : "children"} removed: their board was deleted`;
    }
    case "parent_removed_board_deleted":
      return "Parent removed: its board was deleted";
    // #2371 planned children. The rows carry only cause codes, so these
    // sentences never name the parent, its board or column, or who moved it
    // (the reader may be unable to open the parent's board).
    // A parent release stores the child's due date (ISO, or blank) in to_value.
    case "planned_released": {
      if (d.from_value === "pulled") return "Needed now: started before the parent got there";
      const due = /^\d{4}-\d{2}-\d{2}$/.test(d.to_value ?? "") ? formatDateStr(d.to_value, userDateFormat) : "";
      return due ? `Needed now: the parent moved on · due date ${due} now counts` : "Needed now: the parent moved on";
    }
    case "needed_changed":
      if (d.to_value === "now") return d.from_value === "column_deleted" ? "Needed: Now (its column was deleted)" : "Needed: Now";
      return d.from_value === "created" ? "Created planned for a later stage" : "Needed column changed";
    // #1923: from_value is the actor basis, to_value the kinds, item_text the
    // reason. #2594: an assignee override names who assigned the card; with no
    // assigner (admin basis, older or imported row, deleted account) the row
    // names no one rather than guessing.
    case "override_used": {
      const list = (d.to_value ?? "").split(",").filter(Boolean).map((k) => (k === "wip" ? "WIP" : k));
      const kinds = list.join(" and ");
      const noun = list.length > 1 ? "limits" : "limit";
      const basis = d.from_value === "assignee" ? "assignee override" : "admin override";
      const head = `${kinds ? `${kinds.charAt(0).toUpperCase()}${kinds.slice(1)}` : "Card"} ${noun} overridden (${basis})`;
      const withReason = d.item_text ? `${head}. Reason: ${d.item_text}` : head;
      return `${withReason}${overrideAssignerSuffix(event_type, d)}`;
    }
    case "archived":
      return "Card archived";
    case "reactivated":
      return "Card reactivated";
    default:
      return event_type.replace(/_/g, " ");
  }
}

/**
 * One-line description of a gate transition (#2365): a move between
 * sub-columns inside a stage, or a stage-settings remap. The row names only
 * the sub-column the card reached (snapshotted, so it survives a rename or
 * delete); one with no name falls back to its 1-based position.
 */
export function gateTransitionLabel(
  g: Pick<CardGateTransition, "kind" | "column_name" | "sub_column_name" | "to_index" | "cause">,
): string {
  const where = gateWhere(g);
  // A stage-settings remap is a system change, not a person moving the card,
  // so it never uses a user-action verb (Jordan reads this in retrospectives).
  if (g.cause === "stage_edited") return `Now in ${where} (stage edited)`;
  return g.kind === "reopen" ? `Moved back to ${where}` : `Moved to ${where}`;
}

function gateWhere(
  g: Pick<CardGateTransition, "column_name" | "sub_column_name" | "to_index">,
): string {
  const sub = g.sub_column_name || `sub-column ${g.to_index + 1}`;
  return g.column_name ? `${sub} in ${g.column_name}` : sub;
}

/**
 * The card sheet's "Last activity" line (#967): who did what, without the
 * time (the caller appends the relative time). A move reads as a verb phrase
 * ("Jordan moved to Review"); an activity uses its History row text.
 */
export function lastActivitySummary(entry: CardTimelineEntry, userDateFormat = "MM/DD/YYYY"): string {
  const who = entry.actor ? userDisplayName(entry.actor) : "Someone";
  if (entry.kind === "move") {
    const m = entry.data as unknown as CardMovement;
    const to = m.to_column_name || "another column";
    return m.from_column === null ? `${who} created it in ${to}` : `${who} moved to ${to}`;
  }
  if (entry.kind === "gate") {
    const g = entry.data as unknown as CardGateTransition;
    // A remap has no actor action: use the system wording, without a name.
    if (g.cause === "stage_edited") return gateTransitionLabel(g);
    const where = gateWhere(g);
    return g.kind === "reopen" ? `${who} moved back to ${where}` : `${who} moved to ${where}`;
  }
  return `${who}: ${activityLabel(entry.event_type, entry.data, userDateFormat)}`;
}
