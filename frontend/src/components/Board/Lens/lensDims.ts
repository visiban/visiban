// Pivot dimension options for the lens, shared between the Row-2 LensToolbar
// (which renders the dropdowns + writes the URL) and LensView (which reads the
// URL to drive the fetch). Mirror the backend serializer's accepted values
// (git_lens/serializers.py) — keep in lockstep.
export const COLUMN_DIM_OPTIONS = [
  { value: "pipeline", label: "Pipeline (workflow)" },
  { value: "status", label: "Status" },
  { value: "state", label: "State (open/closed)" },
];
export const SWIMLANE_DIM_OPTIONS = [
  { value: "milestone", label: "Milestone" },
  { value: "assignee", label: "Assignee" },
  { value: "label", label: "Label" },
];

export const COLUMN_DIM_KEYS = new Set(COLUMN_DIM_OPTIONS.map((o) => o.value));
export const SWIMLANE_DIM_KEYS = new Set(SWIMLANE_DIM_OPTIONS.map((o) => o.value));

/** Number of active filters from the URL params — the Row-2 Filters badge and
 *  the provenance banner both read this, so it lives in one place. */
export function lensFilterActiveCount(params: URLSearchParams): number {
  const state = params.get("state");
  const milestone = params.get("milestone") ?? "";
  const q = (params.get("q") ?? "").trim();
  return (state === "open" || state === "closed" ? 1 : 0) + (milestone ? 1 : 0) + (q ? 1 : 0);
}
