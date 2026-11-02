/**
 * Board and group health status display constants (#1133).
 *
 * The one place the four health states get their word, description and tint.
 * Pills, the popover's radio cards and any future surface read these maps; no
 * component defines its own status-to-class map (frontend/CLAUDE.md § Badges
 * and labels). Every pairing is the `/20` tint with on-tint text (#1550),
 * pinned at >= 5.26:1 in both themes by `src/test/onTintTokens.test.ts`.
 */
import type { HealthStatus } from "../types";

export type { HealthStatus } from "../types";

/** A health value, or `"none"` for the "No status" presentation of null. */
export type HealthDisplayValue = HealthStatus | "none";

/** The stored values in scale order: best to worst. Mirrors the backend enum. */
export const HEALTH_STATUS_VALUES: readonly HealthStatus[] = ["on_track", "at_risk", "off_track"];

export const HEALTH_STATUS_LABELS: Record<HealthStatus, string> = {
  on_track: "On track",
  at_risk: "At risk",
  off_track: "Off track",
};

export const NO_STATUS_LABEL = "No status";

/** One-line meaning shown under each choice in the health popover. */
export const HEALTH_STATUS_DESCRIPTIONS: Record<HealthStatus, string> = {
  on_track: "Work is going as planned.",
  at_risk: "Something could slip without action.",
  off_track: "The plan is not being met.",
};

/** Tint, border and on-tint text per state. Full class literals so Tailwind keeps them. */
export const HEALTH_STATUS_STYLES: Record<HealthDisplayValue, string> = {
  on_track: "bg-success/20 border-success/60 text-success-on-tint",
  at_risk: "bg-warning/20 border-warning/60 text-warning-on-tint",
  off_track: "bg-danger/20 border-danger/60 text-danger-on-tint",
  none: "bg-fg-muted/20 border-fg-muted/60 text-muted-on-tint",
};

/** On-tint text color alone, for the shape inside a popover radio card. */
export const HEALTH_STATUS_TEXT: Record<HealthDisplayValue, string> = {
  on_track: "text-success-on-tint",
  at_risk: "text-warning-on-tint",
  off_track: "text-danger-on-tint",
  none: "text-muted-on-tint",
};

export function healthLabel(value: HealthDisplayValue): string {
  return value === "none" ? NO_STATUS_LABEL : HEALTH_STATUS_LABELS[value];
}
