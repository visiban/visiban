/**
 * Board and group health status helpers (#1133): what to show, what to say.
 *
 * The server resolves the cascade (`effective_health_status`, and the group it
 * came from in `health_status_source`); the client never walks the tree
 * itself. These helpers only turn the three fields into display state and
 * copy, so the pill, the popover and the announcements say the same thing.
 */
import { healthLabel, type HealthDisplayValue, type HealthStatus } from "../constants/healthStatus";
import { DEMO_HEALTH_STATUS_REASON } from "../constants/demoCopy";
import type { BoardUser, HealthStatusSource } from "../types";
import { formatRelativeTime } from "./date";

export interface HealthFields {
  health_status: HealthStatus | null;
  effective_health_status: HealthStatus | null;
  health_status_source: HealthStatusSource | null;
}

/**
 * Which entity a health control edits. Boards and groups inherit through the
 * group tree (#1133); a swimlane (#2243) never inherits and never rolls up, so
 * its null means "no status" and its popover has no Inherit choice.
 */
export type HealthEntityKind = "board" | "group" | "swimlane";

/**
 * A swimlane's single stored value as the three-field shape the shared health
 * components take (#2243): the stored value is also the effective one, and
 * there is never a source, so the pill is never drawn as inherited (dashed).
 */
export function laneHealthFields(health_status: HealthStatus | null): HealthFields {
  return { health_status, effective_health_status: health_status, health_status_source: null };
}

export interface HealthDisplay {
  value: HealthDisplayValue;
  label: string;
  /** Name of the ancestor group the value comes from; null when set here or none. */
  inheritedFrom: string | null;
}

export function getHealthDisplay(fields: HealthFields): HealthDisplay {
  const value: HealthDisplayValue = fields.effective_health_status ?? "none";
  // Inherited only when this entity sets nothing itself. A value explicitly
  // set equal to the parent's is "set here" (the server sends no source).
  const inheritedFrom = fields.health_status === null && fields.effective_health_status !== null
    ? fields.health_status_source?.name ?? null
    : null;
  return { value, label: healthLabel(value), inheritedFrom };
}

/** The last set or confirm of an entity's own status (#2242); all null when never recorded. */
export interface HealthAttribution {
  health_status_changed_at: string | null;
  health_status_changed_by: BoardUser | null;
  health_status_note: string | null;
}

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/** "3d ago" within a week, else "on Sep 14" (formatRelativeTime's date form). "" when unknown. */
export function healthSetWhen(changedAt: string | null): string {
  if (!changedAt) return "";
  const rel = formatRelativeTime(changedAt);
  if (!rel) return "";
  const age = Date.now() - new Date(changedAt).getTime();
  return age < WEEK_MS ? rel : `on ${rel}`;
}

/** Who set it: display name, else username; null (removed account or automatic) reads "System". */
export function healthSetterName(user: BoardUser | null): string {
  if (!user) return "System";
  return user.display_name || user.username;
}

/**
 * The ONLY builder of the health attribution copy (#2242; frontend/CLAUDE.md):
 * "Set 3d ago by Priya", "Set on Sep 14 by Priya", "Set 2h ago by System".
 * "" when `changedAt` is null (a status set before history existed): callers
 * omit the clause.
 */
export function healthSetLine(changedAt: string | null, changedBy: BoardUser | null): string {
  const when = healthSetWhen(changedAt);
  if (!when) return "";
  return `Set ${when} by ${healthSetterName(changedBy)}`;
}

const TOOLTIP_NOTE_MAX = 120;

/**
 * `title` for a health pill: the trigger (interactive), a read-only pill, a
 * read-only trigger that opens the history (readonly), or the demo refusal.
 * `attribution` adds "Set 3d ago by Priya. Note: …" for a status set here,
 * and the source's time for an inherited one (#2242). `entityKind`
 * "swimlane" gives the lane wording (#2243).
 */
export function healthTitle(
  display: HealthDisplay,
  mode: "interactive" | "static" | "readonly" | "demo",
  attribution?: HealthAttribution | null,
  source?: HealthStatusSource | null,
  entityKind: HealthEntityKind = "board",
): string {
  if (mode === "demo") {
    const prefix = entityKind === "swimlane" ? "Lane health status" : "Health status";
    return `${prefix}: ${display.label}. ${DEMO_HEALTH_STATUS_REASON}`;
  }
  if (entityKind === "swimlane") {
    // Lanes (#2243): the title says the value is the lane's own, so a lane
    // pill next to the board's is never read as the board's status. Lanes
    // carry no attribution or history (#2242 is board/group only), so a
    // "readonly" lane reads exactly as a "static" one.
    if (display.value === "none") return "Set health status";
    const base = `Lane health status: ${display.label}. Separate from the board's status.`;
    return mode === "interactive" ? `${base} Click to change.` : base;
  }
  if (display.value === "none") {
    return mode === "interactive" ? "No status set. Click to set one." : "No status set.";
  }
  let base: string;
  if (display.inheritedFrom) {
    const when = healthSetWhen(source?.changed_at ?? null);
    base = when
      ? `Health status: ${display.label} (inherited from ${display.inheritedFrom}, set ${when}).`
      : `Health status: ${display.label} (inherited from ${display.inheritedFrom}).`;
  } else {
    base = `Health status: ${display.label}.`;
    if (attribution) {
      const line = healthSetLine(attribution.health_status_changed_at, attribution.health_status_changed_by);
      if (line) base += ` ${line}.`;
      const note = attribution.health_status_note;
      if (note) {
        base += ` Note: ${note.length > TOOLTIP_NOTE_MAX ? `${note.slice(0, TOOLTIP_NOTE_MAX)}…` : note}.`;
      }
    }
  }
  if (mode === "interactive") return `${base} Click to change.`;
  if (mode === "readonly") return `${base} Click for history.`;
  return base;
}

/** The group page caption (#2242): "Set 3d ago by Priya", or "Inherited from Eng · 3d ago". */
export function healthCaption(
  display: HealthDisplay,
  attribution: HealthAttribution | null | undefined,
  source: HealthStatusSource | null,
): string {
  if (display.inheritedFrom) {
    const when = healthSetWhen(source?.changed_at ?? null);
    return when ? `Inherited from ${display.inheritedFrom} · ${when}` : `Inherited from ${display.inheritedFrom}`;
  }
  if (display.value === "none" || !attribution) return "";
  return healthSetLine(attribution.health_status_changed_at, attribution.health_status_changed_by);
}

/** The message shown in the popover's error slot when a save fails. */
export function healthStatusErrorMessage(err: unknown): string {
  const response = (err as { response?: { status?: number; data?: unknown } } | null)?.response;
  if (response?.status === 403) return "Only admins can change health status.";
  if (response?.status === 400) {
    const data = response.data as { detail?: unknown; note?: unknown; status?: unknown } | null | undefined;
    const detail = data?.detail;
    if (typeof detail === "string" && detail.trim()) return detail;
    // POST health-status/ field errors (#2242): the first message of note or status.
    for (const field of [data?.note, data?.status]) {
      if (Array.isArray(field) && typeof field[0] === "string") return field[0];
    }
  }
  return "Could not save health status. Try again.";
}

/**
 * What the live region says after a successful save.
 *
 * `next` is the value just written (null = inherit / clear), `effective` the
 * server's resolved value after the write, `parentName` the group above the
 * entity (null at the root, where "inherit" means "clear").
 */
export function healthStatusAnnouncement(
  next: HealthStatus | null,
  effective: HealthStatus | null,
  parentName: string | null,
  lane?: { name: string },
): string {
  if (lane) {
    return next !== null
      ? `Lane ${lane.name} health status set to ${healthLabel(next)}.`
      : `Lane ${lane.name} health status cleared.`;
  }
  if (next !== null) return `Health status set to ${healthLabel(next)}.`;
  if (parentName !== null) return `Health status now follows ${parentName}: ${healthLabel(effective ?? "none")}.`;
  return "Health status cleared.";
}
