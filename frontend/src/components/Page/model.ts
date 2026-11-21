/** Non-component exports of the shared parts (#2475), kept apart for fast refresh. */
import type { ReactNode } from "react";

/** Listing tones. "No status" is deliberately absent: it never appears in a listing (health rule 3). */
export type StatusTone = "on_track" | "at_risk" | "off_track" | "pending";
/** Header controls can also show the hollow "No status" pill. */
export type StatusControlTone = StatusTone | "none";

export const STATUS_TONE_LABEL: Record<StatusControlTone, string> = {
  on_track: "On track",
  at_risk: "At risk",
  off_track: "Off track",
  pending: "Pending",
  none: "No status",
};

export interface SettingsSection {
  /** The `?tab=` value; deep links keep working. */
  id: string;
  label: string;
  /** Extra words "Find a setting" matches (the settings inside the section). */
  keywords?: string[];
  /** Group heading above the section in the nav (Site admin: Instance, People). Consecutive sections with the same group share one heading. */
  group?: string;
  /** Count shown at the right of the nav item (Users = total). Omitted until known. */
  count?: number;
  render: () => ReactNode;
}

/** Sections whose label or keywords contain `query` (case-insensitive). */
export function filterSettingsSections(sections: SettingsSection[], query: string): SettingsSection[] {
  const q = query.trim().toLowerCase();
  if (!q) return sections;
  return sections.filter((s) => [s.label, ...(s.keywords ?? [])].some((w) => w.toLowerCase().includes(q)));
}

