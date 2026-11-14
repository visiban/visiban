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
import type { HealthStatusSource } from "../types";

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

/** `title` for a health pill: the trigger (interactive), a read-only pill, or the demo refusal. */
export function healthTitle(
  display: HealthDisplay, mode: "interactive" | "static" | "demo", entityKind: HealthEntityKind = "board",
): string {
  if (mode === "demo") return `Health status: ${display.label}. ${DEMO_HEALTH_STATUS_REASON}`;
  if (entityKind === "swimlane") {
    // Lanes (#2243): the title says the value is the lane's own, so a lane
    // pill next to the board's is never read as the board's status.
    if (display.value === "none") return "Set health status";
    const base = `Lane health status: ${display.label}. Separate from the board's status.`;
    return mode === "interactive" ? `${base} Click to change.` : base;
  }
  if (display.value === "none") {
    return mode === "interactive" ? "No status set. Click to set one." : "No status set.";
  }
  const base = display.inheritedFrom
    ? `Health status: ${display.label} (inherited from ${display.inheritedFrom}).`
    : `Health status: ${display.label}.`;
  return mode === "interactive" ? `${base} Click to change.` : base;
}

/** The message shown in the popover's error slot when a save fails. */
export function healthStatusErrorMessage(err: unknown): string {
  const response = (err as { response?: { status?: number; data?: unknown } } | null)?.response;
  if (response?.status === 403) return "Only admins can change health status.";
  if (response?.status === 400) {
    const detail = (response.data as { detail?: unknown } | null | undefined)?.detail;
    if (typeof detail === "string" && detail.trim()) return detail;
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
