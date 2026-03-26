import { useState, useEffect, useCallback } from "react";
import type { SavedFilter } from "../types";
import type { FilterState } from "../components/Board/FilterBar";
import { EMPTY_FILTER } from "../components/Board/FilterBar";
import {
  listSavedFilters,
  createSavedFilter,
  deleteSavedFilter,
} from "../api/savedFilters";

/**
 * Manages the list of saved filter presets for a board.
 *
 * Filters are loaded from the backend on mount so they persist across devices.
 * The list is kept in local state and updated optimistically on create/delete
 * to avoid an extra round-trip for the common happy-path case.
 */
export function useSavedFilters(boardId: number) {
  const [savedFilters, setSavedFilters] = useState<SavedFilter[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    listSavedFilters(boardId)
      .then((filters) => setSavedFilters(filters))
      .catch(() => setError("Failed to load saved filters."))
      .finally(() => setLoading(false));
  }, [boardId]);

  const saveFilter = useCallback(
    async (name: string, filters: FilterState): Promise<{ error?: string }> => {
      try {
        const created = await createSavedFilter(boardId, {
          name,
          state_json: filters as unknown as Record<string, unknown>,
        });
        setSavedFilters((prev) =>
          [...prev, created].sort((a, b) => a.name.localeCompare(b.name)),
        );
        return {};
      } catch (err: unknown) {
        const detail =
          (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail ??
          "Failed to save filter.";
        return { error: detail };
      }
    },
    [boardId],
  );

  const removeFilter = useCallback(
    async (filterId: number): Promise<void> => {
      // Optimistic removal — revert on network failure is not implemented;
      // the user can reload to restore the list. This keeps the UX snappy
      // for the typical success case.
      setSavedFilters((prev) => prev.filter((f) => f.id !== filterId));
      try {
        await deleteSavedFilter(boardId, filterId);
      } catch {
        // Revert the optimistic removal on failure.
        listSavedFilters(boardId)
          .then((filters) => setSavedFilters(filters))
          .catch(() => {/* best-effort revert; ignore secondary error */});
      }
    },
    [boardId],
  );

  /**
   * Convert a saved filter's state_json back into a FilterState, falling back
   * to EMPTY_FILTER for any field that is missing or the wrong type. This
   * protects against saved state that was captured before a filter shape change.
   */
  const hydrateFilter = useCallback((saved: SavedFilter): FilterState => {
    const s = saved.state_json;
    return {
      search: typeof s["search"] === "string" ? s["search"] : EMPTY_FILTER.search,
      assigneeIds: Array.isArray(s["assigneeIds"])
        ? (s["assigneeIds"] as number[])
        : EMPTY_FILTER.assigneeIds,
      labelIds: Array.isArray(s["labelIds"])
        ? (s["labelIds"] as number[])
        : EMPTY_FILTER.labelIds,
      priorities: Array.isArray(s["priorities"])
        ? (s["priorities"] as FilterState["priorities"])
        : EMPTY_FILTER.priorities,
      dueDate:
        s["dueDate"] === "overdue" ||
        s["dueDate"] === "today" ||
        s["dueDate"] === "this_week" ||
        s["dueDate"] === "none"
          ? s["dueDate"]
          : EMPTY_FILTER.dueDate,
    };
  }, []);

  return { savedFilters, loading, error, saveFilter, removeFilter, hydrateFilter };
}
