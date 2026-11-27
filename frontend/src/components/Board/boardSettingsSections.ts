// Section model and "Find a setting" index for Board settings (#2436).
// Kept out of BoardSettingsModal.tsx so adding a setting is one line here and the
// modal shell stays small.

export type SettingsSection =
  | "members"
  | "display"
  | "rules"
  | "fields"
  | "field-sets"
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
  { label: "Fields", sections: ["fields", "field-sets", "swimlane-fields"] },
  { label: "Access", sections: ["members", "sharing"] },
  { label: "Integrations", sections: ["webhooks", "lens"] },
  { label: "Data", sections: ["export", "danger"] },
];

export const SECTION_LABELS: Record<SettingsSection, string> = {
  display: "Display",
  rules: "Rules & limits",
  fields: "Card fields",
  "field-sets": "Field sets",
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
  { section: "display", label: "Use my own density", keywords: "personal density override my view browser", target: "Use my own density" },
  { section: "display", label: "Your personal density override", keywords: "density personal", target: "Your personal density override" },
  { section: "display", label: "Board default preset", keywords: "preset layout default", target: "Board default preset" },
  { section: "display", label: "Columns", keywords: "hide show column visibility", target: "Columns" },
  { section: "display", label: "Swimlanes", keywords: "hide show lane visibility", target: "Swimlanes" },
  { section: "rules", label: "Enforce WIP limits", keywords: "wip work in progress limit block", target: "Enforce WIP limits" },
  { section: "rules", label: "Hard mode (no admin override)", keywords: "wip strict override", target: "Hard mode (no admin override)" },
  { section: "rules", label: "Let a card's assignee move it anyway", keywords: "assignee override wip weight limit bypass", target: "Let a card's assignee move it anyway" },
  { section: "rules", label: "Enforce weight limits", keywords: "weight limit points", target: "Enforce weight limits" },
  { section: "rules", label: "Show at-limit WIP indicator", keywords: "wip indicator at limit", target: "Show at-limit WIP indicator" },
  { section: "rules", label: "Limit enforcement", keywords: "wip weight limits enforce block", target: "Limit enforcement" },
  { section: "rules", label: "Swimlane rollup", keywords: "lane rollup total number field", target: "Swimlane rollup" },
  { section: "rules", label: "Stale card threshold", keywords: "stale aging days old", target: "Stale card threshold" },
  { section: "rules", label: "Card aging", keywords: "stale heatmap age", target: "Card aging settings" },
  { section: "rules", label: "Heatmap warning percentage", keywords: "heatmap aging warning", target: "Heatmap warning percentage" },
  { section: "rules", label: "Flow metrics: cycle time starts at", keywords: "cycle time commitment point column lead time", target: "Cycle time starts at" },
  { section: "rules", label: "Flow metrics: time zone for days and weeks", keywords: "time zone timezone utc throughput days weeks calendar", target: "Time zone for days and weeks" },
  { section: "rules", label: "Flow metrics", keywords: "cycle time lead time commitment point time zone", target: "Flow metrics" },
  { section: "rules", label: "Column policies", keywords: "policy policies entry criteria definition of done column guidance", target: "Column policies" },
  { section: "rules", label: "Child cards", keywords: "parent children subtasks", target: "Child cards" },
  { section: "rules", label: "Cards on this board can have children", keywords: "parent children subtasks hierarchy child cards switch", target: "Cards on this board can have children" },
  { section: "rules", label: "Parent card name", keywords: "parent name initiative opportunity release terminology what do you call", target: "What do you call a parent card on this board?" },
  { section: "rules", label: "Parent card name: singular", keywords: "parent name singular initiative opportunity release", target: "Singular" },
  { section: "rules", label: "Parent card name: plural", keywords: "parent name plural initiatives opportunities releases", target: "Plural" },
  { section: "rules", label: "Default child board", keywords: "add child where new child cards go preference", target: "Default child board" },
  { section: "rules", label: "Health status", keywords: "health review off track", target: "Health status" },
  { section: "rules", label: "Calculate health status automatically", keywords: "health automatic nightly rating", target: "Calculate health status automatically" },
  { section: "rules", label: "Off track at", keywords: "health flagged cards threshold", target: "Off track at" },
  { section: "rules", label: "Recompute now", keywords: "health refresh recalculate rating", target: "Recompute now" },
  { section: "rules", label: "Review status every", keywords: "health review reminder days", target: "Review status every" },
  { section: "fields", label: "Card fields", keywords: "custom field definitions add edit", target: undefined },
  { section: "fields", label: "Add card field", keywords: "new custom field create", target: "+ Add field" },
  { section: "field-sets", label: "Field sets", keywords: "group custom fields blocks meddic", target: "Field sets" },
  { section: "field-sets", label: "New field set", keywords: "add create group of fields", target: "New field set" },
  { section: "field-sets", label: "Copy a field set from another board", keywords: "copy import field set", target: "Copy from another board" },
  { section: "swimlane-fields", label: "Swimlane fields", keywords: "lane custom field definitions", target: undefined },
  { section: "swimlane-fields", label: "Add swimlane field", keywords: "new lane custom field create", target: "+ Add field" },
  { section: "swimlane-fields", label: "Show field names on row chips", keywords: "lane chips names", target: "Show field names on row chips" },
  { section: "members", label: "Members and roles", keywords: "invite people role access link", target: undefined },
  { section: "members", label: "Role descriptions", keywords: "roles permissions viewer member admin", target: "Role descriptions" },
  { section: "members", label: "Moderator", keywords: "moderator entitlement role member", target: "Moderator" },
  { section: "members", label: "Invite by email", keywords: "invite email address people add", target: "Invite by email" },
  { section: "members", label: "Invite email address", keywords: "invite email address", target: "Email address" },
  { section: "members", label: "Pending invites", keywords: "invite link outstanding expires revoke", target: "Pending invites" },
  { section: "sharing", label: "Public sharing", keywords: "share link read-only anonymous", target: "Public sharing" },
  { section: "sharing", label: "Enable public share link", keywords: "share link public anonymous turn on", target: "Enable public share link" },
  { section: "sharing", label: "Share link expires in", keywords: "share link expiry ttl expires in", target: "Expires in" },
  { section: "webhooks", label: "Webhooks", keywords: "integration endpoint secret notify", target: "Webhooks" },
  { section: "webhooks", label: "Add webhook", keywords: "integration endpoint new create", target: "Add webhook" },
  { section: "lens", label: "Issue board lens", keywords: "github gitlab repository issues read-only", target: "Issue board lens" },
  { section: "lens", label: "Connect a repository", keywords: "github gitlab repository issues lens", target: "Connect a repository" },
  { section: "export", label: "Export board", keywords: "download json csv backup", target: "Export board" },
  { section: "export", label: "Export format", keywords: "json csv download type", target: "Export format" },
  { section: "export", label: "Who can export", keywords: "permission role threshold", target: "Who can export" },
  { section: "export", label: "Export permission", keywords: "who can export role", target: "Export permission" },
  { section: "export", label: "Export history", keywords: "past exports audit who downloaded", target: "Export history" },
  { section: "danger", label: "Delete board", keywords: "remove permanently danger", target: "Danger zone" },
];

/** The React key and identity of a result: one per section and label. */
export function settingKey(e: Pick<SettingEntry, "section" | "label">): string {
  return `${e.section}-${e.label.toLowerCase()}`;
}

/** Entries whose section is available to this viewer, matching every typed word against label, section name and keywords. */
export function findSettings(query: string, available: ReadonlySet<SettingsSection>): SettingEntry[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  // A section that already has an index entry under its own name (Card fields, Swimlane fields,
  // Webhooks) gets no second, synthetic one: the pair would list the same row twice and share a key.
  const indexed = new Set(SETTINGS_INDEX.map((element) => settingKey(element)));
  const sectionEntries: SettingEntry[] = Array.from(available)
    .map((section) => ({ section, label: SECTION_LABELS[section], keywords: "section" }))
    .filter((e) => !indexed.has(settingKey(e)));
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
  const byLabel = Array.from(root.querySelectorAll<HTMLElement>("[aria-label]")).find((el) => {
    const name = el.getAttribute("aria-label");
    // A select's trigger is named "<label>: <selected value>", so the label alone is a prefix match.
    return name === target || (name !== null && name.startsWith(`${target}: `));
  });
  if (byLabel) return byLabel;
  const lower = target.toLowerCase();
  // Buttons and h4s are searched too, so an action ("Recompute now") or a sub-heading ("Invite by email") can be a target.
  const textual = Array.from(root.querySelectorAll<HTMLElement>("h3, h4, legend, label, button, span")).find((el) =>
    (el.textContent ?? "").trim().toLowerCase().startsWith(lower),
  );
  if (!textual) return null;
  return textual.tagName === "LEGEND" ? (textual.parentElement ?? textual) : textual;
}
