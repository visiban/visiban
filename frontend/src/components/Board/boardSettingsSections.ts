// Section model and "Find a setting" index for Board settings (#2436).
// Kept out of BoardSettingsModal.tsx so adding a setting is one line here and the
// modal shell stays small.

export type SettingsSection =
  | "members"
  | "display"
  | "rules"
  | "fields"
  | "swimlane-fields"
  | "sharing"
  | "webhooks"
  | "lens"
  | "export"
  | "danger";

/** Deep-link values accepted by `initialTab`. `data` predates the split (#2436) and maps to Export. */
export type SettingsInitialSection = SettingsSection | "data";

export function resolveInitialSection(t: SettingsInitialSection | undefined): SettingsSection | undefined {
  return t === "data" ? "export" : t;
}

export const SECTION_GROUPS: { label: string; sections: SettingsSection[] }[] = [
  { label: "Board", sections: ["display", "rules"] },
  { label: "Fields", sections: ["fields", "swimlane-fields"] },
  { label: "Access", sections: ["members", "sharing"] },
  { label: "Integrations", sections: ["webhooks", "lens"] },
  { label: "Data", sections: ["export", "danger"] },
];

export const SECTION_LABELS: Record<SettingsSection, string> = {
  display: "Display",
  rules: "Rules & limits",
  fields: "Card fields",
  "swimlane-fields": "Swimlane fields",
  members: "Members",
  sharing: "Sharing",
  webhooks: "Webhooks",
  lens: "Issue lens",
  export: "Export",
  danger: "Danger zone",
};

export interface SettingEntry {
  section: SettingsSection;
  label: string;
  /** Extra words that should find this setting. */
  keywords: string;
  /** What to scroll to and highlight inside the section: an exact `aria-label`, or the start of a heading/label's text. Omitted: the top of the section. */
  target?: string;
}

export const SETTINGS_INDEX: SettingEntry[] = [
  { section: "display", label: "Card density", keywords: "compact comfortable spacing", target: "Card density" },
  { section: "display", label: "Your personal density override", keywords: "density personal", target: "Your personal density override" },
  { section: "display", label: "Board default preset", keywords: "preset layout default", target: "Board default preset" },
  { section: "display", label: "Columns", keywords: "hide show column visibility", target: "Columns" },
  { section: "display", label: "Swimlanes", keywords: "hide show lane visibility", target: "Swimlanes" },
  { section: "rules", label: "Enforce WIP limits", keywords: "wip work in progress limit block", target: "Enforce WIP limits" },
  { section: "rules", label: "Hard mode (no admin override)", keywords: "wip strict override", target: "Hard mode (no admin override)" },
  { section: "rules", label: "Enforce weight limits", keywords: "weight limit points", target: "Enforce weight limits" },
  { section: "rules", label: "Show at-limit WIP indicator", keywords: "wip indicator at limit", target: "Show at-limit WIP indicator" },
  { section: "rules", label: "Limit enforcement", keywords: "wip weight limits enforce block", target: "Limit enforcement" },
  { section: "rules", label: "Swimlane rollup", keywords: "lane rollup total number field", target: "Swimlane rollup" },
  { section: "rules", label: "Stale card threshold", keywords: "stale aging days old", target: "Stale card threshold" },
  { section: "rules", label: "Card aging", keywords: "stale heatmap age", target: "Card aging settings" },
  { section: "rules", label: "Heatmap warning percentage", keywords: "heatmap aging warning", target: "Heatmap warning percentage" },
  { section: "rules", label: "Flow metrics: cycle time starts at", keywords: "cycle time commitment column lead time", target: "Cycle time starts at" },
  { section: "rules", label: "Flow metrics", keywords: "cycle time lead time commitment", target: "Flow metrics" },
  { section: "rules", label: "Column policies", keywords: "policy policies entry criteria definition of done column guidance", target: "Column policies" },
  { section: "rules", label: "Child cards", keywords: "parent children subtasks", target: "Child cards" },
  { section: "rules", label: "Health status", keywords: "health review off track", target: "Health status" },
  { section: "fields", label: "Card fields", keywords: "custom field definitions add edit", target: undefined },
  { section: "swimlane-fields", label: "Swimlane fields", keywords: "lane custom field definitions", target: undefined },
  { section: "swimlane-fields", label: "Show field names on row chips", keywords: "lane chips names", target: "Show field names on row chips" },
  { section: "members", label: "Members and roles", keywords: "invite people role access link", target: undefined },
  { section: "sharing", label: "Public sharing", keywords: "share link read-only anonymous", target: "Public sharing" },
  { section: "webhooks", label: "Webhooks", keywords: "integration endpoint secret notify", target: undefined },
  { section: "lens", label: "Issue board lens", keywords: "github gitlab repository issues read-only", target: "Issue board lens" },
  { section: "export", label: "Export board", keywords: "download json csv backup", target: "Export" },
  { section: "export", label: "Export permission", keywords: "who can export role", target: "Export permission" },
  { section: "export", label: "Export history", keywords: "past exports audit who downloaded", target: "Export history" },
  { section: "danger", label: "Delete board", keywords: "remove permanently danger", target: "Danger Zone" },
];

/** Entries whose section is available to this viewer, matching every typed word against label, section name and keywords. */
export function findSettings(query: string, available: ReadonlySet<SettingsSection>): SettingEntry[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  const sectionEntries: SettingEntry[] = Array.from(available).map((section) => ({
    section,
    label: SECTION_LABELS[section],
    keywords: "section",
  }));
  return [...sectionEntries, ...SETTINGS_INDEX]
    .filter((e) => available.has(e.section))
    .filter((e) => {
      const hay = `${e.label} ${SECTION_LABELS[e.section]} ${e.keywords}`.toLowerCase();
      return words.every((w) => hay.includes(w));
    })
    .slice(0, 8);
}

/** Finds the control a search result points at. */
export function locateSettingTarget(root: HTMLElement, target: string | undefined): HTMLElement | null {
  if (!target) return null;
  const byLabel = Array.from(root.querySelectorAll<HTMLElement>("[aria-label]")).find((el) => el.getAttribute("aria-label") === target);
  if (byLabel) return byLabel;
  const lower = target.toLowerCase();
  const textual = Array.from(root.querySelectorAll<HTMLElement>("h3, legend, label, span")).find((el) =>
    (el.textContent ?? "").trim().toLowerCase().startsWith(lower),
  );
  if (!textual) return null;
  return textual.tagName === "LEGEND" ? (textual.parentElement ?? textual) : textual;
}
