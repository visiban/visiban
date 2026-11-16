import type { FilterState } from "../components/Board/FilterBar";

// #2357 — number custom-field card filter: equals (the original #371 shape),
// between (either bound optional, inclusive), is empty, and has a value.
//
// Persisted shape: { kind: "number", equals, op?, min?, max? }; an absent op
// means "eq". "at least" / "at most" are UI-only modes — they are stored as a
// "between" with one bound left empty, so the stored op enum stays small and
// is pinned against SavedFilterSerializer._CF_NUMBER_OPS by the shared
// backend/boards/tests/fixtures/filter_state_keys.json.
//
// Hard constraint: every non-eq entry carries `equals: ""`. A SPA built before
// #2357 reads only `equals` and skips an entry whose equals is "", so a range
// or empty/not-empty filter degrades to inactive there instead of silently
// filtering on a stale equals value.

export type NumberFilterOp = "eq" | "between" | "empty" | "not_empty";

export const NUMBER_FILTER_OPS: readonly NumberFilterOp[] = ["eq", "between", "empty", "not_empty"];

export interface NumberFilterValue {
  kind: "number";
  equals: string;
  op?: NumberFilterOp;
  min?: string;
  max?: string;
}

/** What the operator dropdown shows; "gte"/"lte" are derived from a one-bound "between". */
export type NumberFilterMode = "eq" | "between" | "gte" | "lte" | "empty" | "not_empty";

export const NUMBER_FILTER_MODE_OPTIONS: { value: NumberFilterMode; label: string }[] = [
  { value: "eq", label: "equals" },
  { value: "between", label: "between" },
  { value: "gte", label: "at least" },
  { value: "lte", label: "at most" },
  { value: "empty", label: "is empty" },
  { value: "not_empty", label: "has a value" },
];

/**
 * A bound as a number, or null when it is blank or not a finite number. A
 * non-finite bound (only reachable through a hand-edited saved filter or
 * localStorage entry — a number input yields "" for unparseable text) is
 * treated as absent, so it can never make a range match nothing by accident.
 */
export function finiteBound(s: string | undefined): number | null {
  if (s === undefined || s.trim() === "") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

export function numberFilterMode(v: NumberFilterValue): NumberFilterMode {
  const op = v.op ?? "eq";
  if (op !== "between") return op;
  const hasMin = (v.min ?? "") !== "";
  const hasMax = (v.max ?? "") !== "";
  if (hasMin && !hasMax) return "gte";
  if (hasMax && !hasMin) return "lte";
  return "between";
}

/**
 * The mode to show: the one the user picked while it still describes the
 * stored value, else the derived one. Needed because "at least" with its bound
 * still blank is stored exactly like an empty "between".
 */
export function displayedNumberFilterMode(v: NumberFilterValue, picked: NumberFilterMode | null): NumberFilterMode {
  if (v.op === "between") {
    if (picked === "between") return "between";
    if (picked === "gte" && (v.max ?? "") === "") return "gte";
    if (picked === "lte" && (v.min ?? "") === "") return "lte";
  }
  return numberFilterMode(v);
}

export function isNumberFilterActive(v: NumberFilterValue): boolean {
  const op = v.op ?? "eq";
  if (op === "empty" || op === "not_empty") return true;
  if (op === "between") return finiteBound(v.min) !== null || finiteBound(v.max) !== null;
  return v.equals !== "";
}

/** Both bounds set and min > max — still a valid filter, it just matches no card. */
export function isNumberRangeInverted(v: NumberFilterValue): boolean {
  if (v.op !== "between") return false;
  const lo = finiteBound(v.min);
  const hi = finiteBound(v.max);
  return lo !== null && hi !== null && lo > hi;
}

/**
 * Whether a card's stored value passes an active number filter. A card with
 * no stored value never matches a numeric comparison — only "is empty". The
 * comparison is numeric and unrounded: number_decimals only shapes the input
 * step, never the match.
 */
export function matchesNumberFilter(v: NumberFilterValue, cardValue: string | undefined): boolean {
  const op = v.op ?? "eq";
  const hasValue = cardValue !== undefined && cardValue.trim() !== "";
  if (op === "empty") return !hasValue;
  if (op === "not_empty") return hasValue;
  const a = hasValue ? Number(cardValue) : NaN;
  if (!Number.isFinite(a)) return false;
  if (op === "between") {
    const lo = finiteBound(v.min);
    const hi = finiteBound(v.max);
    return (lo === null || a >= lo) && (hi === null || a <= hi);
  }
  const b = Number(v.equals);
  return Number.isFinite(b) && a === b;
}

/**
 * The value an operator switch writes, carrying what the user already typed
 * where it still makes sense (equals -> between puts equals in min; between ->
 * equals takes min, else max; at least <-> at most moves the single bound).
 */
export function switchNumberFilterMode(v: NumberFilterValue, mode: NumberFilterMode, from: NumberFilterMode = numberFilterMode(v)): NumberFilterValue {
  const min = v.min ?? "";
  const max = v.max ?? "";
  const single = from === "eq" ? v.equals : from === "gte" ? min : from === "lte" ? max : "";
  switch (mode) {
    case "eq":
      return { kind: "number", equals: from === "between" || from === "gte" || from === "lte" ? min || max : from === "eq" ? v.equals : "" };
    case "between":
      if (from === "eq") return { kind: "number", equals: "", op: "between", min: v.equals, max: "" };
      if (from === "empty" || from === "not_empty") return { kind: "number", equals: "", op: "between", min: "", max: "" };
      return { kind: "number", equals: "", op: "between", min, max };
    case "gte":
      return { kind: "number", equals: "", op: "between", min: from === "between" ? min : single, max: "" };
    case "lte":
      return { kind: "number", equals: "", op: "between", min: "", max: from === "between" ? max : single };
    case "empty":
    case "not_empty":
      return { kind: "number", equals: "", op: mode };
  }
}

/** Chip / row-summary text; `format` renders one stored number (prefix, suffix, grouping). */
export function numberFilterDisplay(v: NumberFilterValue, format: (raw: string) => string): string {
  const op = v.op ?? "eq";
  if (op === "empty") return "empty";
  if (op === "not_empty") return "has a value";
  if (op === "eq") return format(v.equals);
  const lo = finiteBound(v.min) !== null ? format(v.min as string) : null;
  const hi = finiteBound(v.max) !== null ? format(v.max as string) : null;
  if (lo !== null && hi !== null) return `${lo}–${hi}`;
  if (lo !== null) return `≥ ${lo}`;
  // Only reachable with a bound; an entry with neither is inactive and never shown.
  return `≤ ${hi as string}`;
}

/** Input step: 10^-decimals when the field sets decimals, else "any". */
export function numberInputStep(decimals: number | null | undefined): string {
  return decimals == null ? "any" : (1 / 10 ** decimals).toFixed(decimals);
}

/** Validates a stored number entry (localStorage or a saved filter's state_json). */
export function isValidNumberFilterValue(obj: Record<string, unknown>): boolean {
  if (obj.kind !== "number" || typeof obj.equals !== "string") return false;
  if (obj.op !== undefined && !(typeof obj.op === "string" && (NUMBER_FILTER_OPS as readonly string[]).includes(obj.op))) return false;
  if (obj.min !== undefined && typeof obj.min !== "string") return false;
  if (obj.max !== undefined && typeof obj.max !== "string") return false;
  return true;
}

/**
 * Save payload only (#2357): an inactive number entry (a between / at least /
 * at most whose bound is still blank) is what the editor keeps in live state,
 * but the server rejects "between" with no bound. Collapse it to the inactive
 * equals shape, which the serializer accepts and every client reads as inactive.
 */
export function normalizeFiltersForSave(filters: FilterState): FilterState {
  const customFields: FilterState["customFields"] = {};
  for (const [id, cf] of Object.entries(filters.customFields ?? {})) {
    customFields[Number(id)] =
      cf.kind === "number" && !isNumberFilterActive(cf) ? { kind: "number", equals: "" } : cf;
  }
  return { ...filters, customFields };
}
