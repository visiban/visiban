import type { CardActivity, CardMovement, CardTimelineEntry } from "../types";
import { userDisplayName } from "../types";
import { formatBlockedDuration } from "./blockedState";
import { formatDateStr } from "./date";

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
    case "archived":
      return "Card archived";
    case "reactivated":
      return "Card reactivated";
    default:
      return event_type.replace(/_/g, " ");
  }
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
  return `${who}: ${activityLabel(entry.event_type, entry.data, userDateFormat)}`;
}
