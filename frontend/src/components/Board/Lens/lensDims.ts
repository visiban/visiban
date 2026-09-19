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

/** Max labels the server accepts in one `?labels=` filter. Mirrors
 *  `MAX_LENS_LABELS` in `backend/git_lens/views.py` — keep in lockstep. */
export const MAX_LENS_LABELS = 5;

/** The synthetic "no value on this dimension" sentinel. Mirrors `_NONE` in
 *  `backend/git_lens/providers.py`; as a `?milestone=` value it means "only issues
 *  with no milestone". */
export const LENS_NONE = "__none__";

/**
 * Labels from the `?labels=` param: split, trimmed, deduped, sorted, capped.
 *
 * This deliberately mirrors `_parse_filters` in `backend/git_lens/views.py`
 * exactly. The sort is not cosmetic: the server hashes the sorted list into the
 * board cache key, so `?labels=b,a` and `?labels=a,b` are one cache entry and one
 * upstream fetch. Emitting an unsorted list from here would mint a second key for
 * the same filter on every reorder.
 */
export function parseLensLabels(raw: string | null | undefined): string[] {
  if (!raw) return [];
  const seen = new Set<string>();
  for (const chunk of raw.split(",")) {
    const value = chunk.trim();
    if (value) seen.add(value);
  }
  return Array.from(seen).sort().slice(0, MAX_LENS_LABELS);
}

/** Canonical `?labels=` value for a selection — the inverse of parseLensLabels. */
export function serializeLensLabels(labels: string[]): string {
  return parseLensLabels(labels.join(",")).join(",");
}

/** Number of active filters from the URL params — the Row-2 Filters badge and
 *  the provenance banner both read this, so it lives in one place. Counts one per
 *  active *dimension*, not one per selected label. */
export function lensFilterActiveCount(params: URLSearchParams): number {
  const state = params.get("state");
  const milestone = params.get("milestone") ?? "";
  const assignee = (params.get("assignee") ?? "").trim();
  const labels = parseLensLabels(params.get("labels"));
  const q = (params.get("q") ?? "").trim();
  return (
    (state === "open" || state === "closed" ? 1 : 0) +
    (milestone ? 1 : 0) +
    (labels.length > 0 ? 1 : 0) +
    (assignee ? 1 : 0) +
    (q ? 1 : 0)
  );
}
