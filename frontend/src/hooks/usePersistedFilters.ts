import { useState, useCallback } from "react";
import { EMPTY_FILTER } from "../components/Board/FilterBar";
import type { FilterState } from "../components/Board/FilterBar";

function storageKey(boardId: number): string {
  return `board:${boardId}:filters`;
}

function load(boardId: number): FilterState {
  try {
    const raw = localStorage.getItem(storageKey(boardId));
    if (!raw) return EMPTY_FILTER;
    const parsed = JSON.parse(raw) as Partial<FilterState>;
    // Validate each field against the expected shape; fall back to EMPTY_FILTER
    // values for any field that is missing or the wrong type so corrupt storage
    // never causes a runtime error.
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
    };
  } catch {
    // Corrupt JSON or localStorage unavailable — start with empty filters.
    return EMPTY_FILTER;
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
 */
export function usePersistedFilters(boardId: number) {
  const [filters, setFiltersState] = useState<FilterState>(() => load(boardId));

  const setFilters = useCallback(
    (next: FilterState) => {
      save(boardId, next);
      setFiltersState(next);
    },
    [boardId],
  );

  return { filters, setFilters };
}
