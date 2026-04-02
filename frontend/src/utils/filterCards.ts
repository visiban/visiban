import type { Card } from "../types";
import { userDisplayName } from "../types";
import type { FilterState } from "../components/Board/FilterBar";

/**
 * Pure client-side card filter. Applies assignee, label, priority, due-date,
 * and optional full-text search filters to a list of cards.
 *
 * The `searchResults` parameter integrates server-side search results:
 * - null/undefined  → no server search active; search field is ignored here
 * - number[]        → card IDs returned by the server trigram search; this
 *                     function intersects them with the client-side criteria
 *
 * Note: server search matches title+description only (via trigram indexes in
 * migration 0030). When searchResults is null the local `filters.search` field
 * is used instead, matching against title, description, assignee name, and
 * label name — the client has richer context than the server search endpoint.
 */
export function filterCards(
  cards: Card[],
  filters: FilterState,
  searchResults?: number[] | null, // card IDs from server-side search, null means no search active
  todayOverride?: string // YYYY-MM-DD; when provided overrides the local clock (timezone-aware callers pass this)
): number[] {
  const todayStr = todayOverride ?? getTodayStr();
  const nextWeekStr = getNextWeekStr(todayStr);

  const searchResultSet = searchResults != null ? new Set(searchResults) : null;

  return cards
    .filter((card) => {
      // Server-side search intersection
      if (searchResultSet !== null && !searchResultSet.has(card.id)) return false;

      // Client-side full-text search (only when no server search is active)
      if (searchResultSet === null && filters.search) {
        const q = filters.search.toLowerCase();
        const matches =
          card.title.toLowerCase().includes(q) ||
          card.description.toLowerCase().includes(q) ||
          (card.assignee !== null && userDisplayName(card.assignee).toLowerCase().includes(q)) ||
          card.labels.some((l) => l.name.toLowerCase().includes(q));
        if (!matches) return false;
      }

      if (filters.assigneeIds.length > 0) {
        const matches = filters.assigneeIds.some((id) =>
          id === -1 ? card.assignee === null : card.assignee?.id === id
        );
        if (!matches) return false;
      }

      if (filters.labelIds.length > 0 && !filters.labelIds.every((id) => card.labels.some((l) => l.id === id))) {
        return false;
      }

      if (filters.priorities.length > 0 && !filters.priorities.includes(card.priority)) {
        return false;
      }

      if (filters.dueDate !== null) {
        if (filters.dueDate === "none" && card.due_date !== null) return false;
        if (filters.dueDate === "overdue") {
          if (!card.due_date || card.due_date >= todayStr) return false;
        }
        if (filters.dueDate === "today") {
          if (card.due_date !== todayStr) return false;
        }
        if (filters.dueDate === "this_week") {
          if (!card.due_date || card.due_date < todayStr || card.due_date >= nextWeekStr) return false;
        }
      }

      return true;
    })
    .map((c) => c.id);
}

function getTodayStr(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function getNextWeekStr(todayStr: string): string {
  const nextWeekMs = new Date(todayStr + "T00:00:00Z").getTime() + 7 * 86_400_000;
  const nw = new Date(nextWeekMs);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${nw.getUTCFullYear()}-${pad(nw.getUTCMonth() + 1)}-${pad(nw.getUTCDate())}`;
}
