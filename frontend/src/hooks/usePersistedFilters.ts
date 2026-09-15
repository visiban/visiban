import { useState, useCallback } from "react";
import { EMPTY_FILTER } from "../components/Board/FilterBar";
import type { CustomFieldFilterValue, FilterState } from "../components/Board/FilterBar";

function storageKey(boardId: number): string {
  return `board:${boardId}:filters`;
}

// #371 — validates one stored CustomFieldFilterValue against its three
// possible shapes. A malformed entry (wrong kind, wrong value type) is
// dropped rather than failing the whole load, matching the per-field
// defensive pattern the other filters below already use.
function validCustomFieldFilterValue(v: unknown): v is CustomFieldFilterValue {
  if (typeof v !== "object" || v === null) return false;
  const obj = v as Record<string, unknown>;
  if (obj.kind === "text") return typeof obj.query === "string";
  if (obj.kind === "number" || obj.kind === "date") return typeof obj.equals === "string";
  if (obj.kind === "choice") return Array.isArray(obj.values) && obj.values.every((x) => typeof x === "string");
  return false;
}

// Exported for reuse by useSavedFilters' hydrateFilter, which needs the same
// defensive per-entry validation for a saved filter's state_json — not just
// this hook's own localStorage read.
export function loadCustomFields(raw: unknown): Record<number, CustomFieldFilterValue> {
  if (typeof raw !== "object" || raw === null) return {};
  const out: Record<number, CustomFieldFilterValue> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const id = Number(key);
    if (Number.isFinite(id) && validCustomFieldFilterValue(value)) out[id] = value;
  }
  return out;
}

function load(boardId: number, pinnedFieldIds: number[]): FilterState {
  try {
    const raw = localStorage.getItem(storageKey(boardId));
    if (!raw) return { ...EMPTY_FILTER, visibleCustomFieldFilterIds: pinnedFieldIds };
    const parsed = JSON.parse(raw) as Partial<FilterState>;
    // Validate each field against the expected shape; fall back to EMPTY_FILTER
    // values for any field that is missing or the wrong type so corrupt storage
    // never causes a runtime error.
    const visibleCustomFieldFilterIds =
      Array.isArray(parsed.visibleCustomFieldFilterIds) && parsed.visibleCustomFieldFilterIds.every((x) => typeof x === "number")
        ? (parsed.visibleCustomFieldFilterIds as number[])
        // Self-heal: a stale/never-set value falls back to the board's
        // *current* pinned fields, computed fresh at load time — not stored —
        // so a board whose pinned fields changed since the filters were last
        // saved doesn't show a toolbar seeded from a field that's no longer
        // pinned (or an empty toolbar from a board that had none pinned then).
        : pinnedFieldIds;
    return {
      search: typeof parsed.search === "string" ? parsed.search : "",
      assigneeIds: Array.isArray(parsed.assigneeIds) ? (parsed.assigneeIds as number[]) : [],
      labelIds: Array.isArray(parsed.labelIds) ? (parsed.labelIds as number[]) : [],
      priorities: Array.isArray(parsed.priorities) ? (parsed.priorities as FilterState["priorities"]) : [],
      dueDate:
        parsed.dueDate === "overdue" ||
        parsed.dueDate === "today" ||
        parsed.dueDate === "this_week" ||
        parsed.dueDate === "none"
          ? parsed.dueDate
          : null,
      customFields: loadCustomFields(parsed.customFields),
      visibleCustomFieldFilterIds,
    };
  } catch {
    // Corrupt JSON or localStorage unavailable — start with empty filters.
    return { ...EMPTY_FILTER, visibleCustomFieldFilterIds: pinnedFieldIds };
  }
}

function save(boardId: number, filters: FilterState): void {
  try {
    localStorage.setItem(storageKey(boardId), JSON.stringify(filters));
  } catch {
    // localStorage unavailable (e.g. private browsing quota exceeded) — fail silently.
  }
}

/**
 * Persists board filter state to localStorage under `board:{boardId}:filters`.
 * Each board gets its own independent key so switching boards never bleeds
 * filter state from one board into another.
 *
 * `pinnedFieldIds` (#371) — the board's currently pinned custom fields, used
 * only to seed `visibleCustomFieldFilterIds` on first load or self-heal; it
 * does not re-run on every render, only inside the initial `useState`
 * lazy-initializer, matching this hook's existing "read once per boardId"
 * shape (a board switch always remounts via a new `boardId`, same as before).
 */
export function usePersistedFilters(boardId: number, pinnedFieldIds: number[] = []) {
  const [filters, setFiltersState] = useState<FilterState>(() => load(boardId, pinnedFieldIds));

  const setFilters = useCallback(
    (next: FilterState) => {
      save(boardId, next);
      setFiltersState(next);
    },
    [boardId],
  );

  return { filters, setFilters };
}
