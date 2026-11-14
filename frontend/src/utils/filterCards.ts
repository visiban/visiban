import type { Card } from "../types";
import { userDisplayName } from "../types";
import type { FilterState } from "../components/Board/FilterBar";
import { compileTextMatcher } from "./textMatch";
import { isCustomFieldFilterActive } from "../components/Board/FilterBar";
import { parseMultiSelect } from "./customFieldValue";
import { isCardBlocked } from "./blockedState";

/**
 * Whether any *client-side* filter dimension is active — everything
 * `filterCards` applies except `search`, which `BoardView` handles via a
 * separate server-side path (`useCardSearch` → `searchMatchIds`) and
 * intersects with this function's result rather than filtering through it.
 *
 * Extracted as its own export (#371) after a real bug: adding the
 * custom-fields dimension required updating this exact "what counts as
 * active" check in two places — `FilterBar`'s `countActiveFilters` (which
 * *was* updated) and this one, inline in `BoardView.tsx` (which briefly
 * wasn't) — and the drift meant a custom-field-only filter left the board
 * completely unfiltered while the toolbar chip claimed one was active. A
 * shared, exported, directly-testable function is the fix that actually
 * prevents a repeat, not just this one instance of it.
 */
export function hasActiveClientFilters(filters: FilterState): boolean {
  return (
    filters.assigneeIds.length > 0 ||
    filters.labelIds.length > 0 ||
    filters.priorities.length > 0 ||
    filters.dueDate !== null ||
    Object.values(filters.customFields).some(isCustomFieldFilterActive) ||
    !!filters.blockedOnly
  );
}

/**
 * Drop label ids that no longer exist on the board from a filter (#1888).
 * A saved/persisted/URL filter can name a deleted label; it would match no
 * card, and FilterBar shows no chip for it, so the board looks empty with
 * nothing to dismiss. Returns the same object when nothing needs pruning so
 * callers can detect a change by identity.
 */
export function pruneStaleLabelIds(filters: FilterState, labels: { id: number }[]): FilterState {
  if (filters.labelIds.length === 0) return filters;
  const live = new Set(labels.map((l) => l.id));
  if (filters.labelIds.every((id) => live.has(id))) return filters;
  return { ...filters, labelIds: filters.labelIds.filter((id) => live.has(id)) };
}

/**
 * Drop custom-field filter entries (and their visible-control ids) whose field
 * no longer exists on the board (#1928). Same shape as pruneStaleLabelIds: a
 * persisted/saved filter naming a deleted field matches no card and
 * FilterBar renders no chip for it. Returns the same object when nothing is
 * stale so callers can detect a change by identity.
 */
export function pruneStaleCustomFields(filters: FilterState, definitions: { id: number }[]): FilterState {
  const keys = Object.keys(filters.customFields);
  if (keys.length === 0 && filters.visibleCustomFieldFilterIds.length === 0) return filters;
  const live = new Set(definitions.map((d) => d.id));
  const staleKey = keys.some((k) => !live.has(Number(k)));
  const staleVisible = filters.visibleCustomFieldFilterIds.some((id) => !live.has(id));
  if (!staleKey && !staleVisible) return filters;
  return {
    ...filters,
    customFields: Object.fromEntries(Object.entries(filters.customFields).filter(([k]) => live.has(Number(k)))),
    visibleCustomFieldFilterIds: filters.visibleCustomFieldFilterIds.filter((id) => live.has(id)),
  };
}

/** Both stale-reference prunes (labels #1888, custom fields #1928) for a board. */
export function pruneStaleFilters(
  filters: FilterState,
  board: { labels: { id: number }[]; custom_field_definitions: { id: number }[] },
): FilterState {
  return pruneStaleCustomFields(pruneStaleLabelIds(filters, board.labels), board.custom_field_definitions);
}

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
  todayOverride?: string, // YYYY-MM-DD; when provided overrides the local clock (timezone-aware callers pass this)
  // #1848 — board field definitions, so a checkbox filter can treat a card with
  // no stored row as "false". Optional: omitted means no field is a checkbox.
  customFieldDefs?: ReadonlyArray<{ id: number; field_type: string }>
): number[] {
  const todayStr = todayOverride ?? getTodayStr();
  const nextWeekStr = getNextWeekStr(todayStr);

  const checkboxFieldIds = new Set(
    (customFieldDefs ?? []).filter((d) => d.field_type === "checkbox").map((d) => d.id)
  );

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

      // #1149 — manual or relation block, the same union the card face shows.
      if (filters.blockedOnly && !isCardBlocked(card)) return false;

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

      // #371 — custom field filters, AND-combined with everything above like
      // every other dimension. Equality-only for number/date (see FilterBar's
      // CustomFieldFilterValue JSDoc — the value is stored as TextField
      // server-side, so a range comparison would be lexicographic, not
      // numeric). A card with no CustomFieldValue row for a filtered field
      // never matches a non-empty filter on that field — matching every other
      // "no value = doesn't match a specific-value filter" dimension above.
      // Exception (#1848): a checkbox field treats a missing row as "false",
      // since unchecking deletes the row.
      for (const [idStr, cf] of Object.entries(filters.customFields)) {
        // An invalid pattern (#2227) is inactive, like a blank box.
        if (cf.kind === "text" && compileTextMatcher(cf.query).kind !== "ok") continue;
        if ((cf.kind === "number" || cf.kind === "date") && cf.equals === "") continue;
        if ((cf.kind === "choice" || cf.kind === "multi_choice") && cf.values.length === 0) continue;

        const fieldId = Number(idStr);
        let cardValue = card.custom_field_values.find((v) => v.field_definition === fieldId)?.value;
        // #1848 — a checkbox row is only stored when set and clearing deletes it
        // (CustomFieldValue docstring), so a missing row means unchecked: it must
        // match a "No" ("false") filter rather than nothing.
        if (cardValue === undefined && cf.kind === "choice" && checkboxFieldIds.has(fieldId)) {
          cardValue = "false";
        }

        if (cf.kind === "text") {
          const m = compileTextMatcher(cf.query);
          if (!cardValue || m.kind !== "ok" || !m.test(cardValue)) return false;
        } else if (cf.kind === "number") {
          const a = cardValue !== undefined ? Number(cardValue) : NaN;
          const b = Number(cf.equals);
          if (!Number.isFinite(a) || !Number.isFinite(b) || a !== b) return false;
        } else if (cf.kind === "date") {
          if (cardValue !== cf.equals) return false;
        } else if (cf.kind === "choice") {
          if (cardValue === undefined || !cf.values.includes(cardValue)) return false;
        } else if (cf.kind === "multi_choice") {
          // #1391 — exact membership in the parsed array, never a substring
          // test on the JSON text ("web" must not match "webhooks"). OR within
          // the field; an empty or unparseable value matches nothing.
          const entries = parseMultiSelect(cardValue);
          if (!cf.values.some((v) => entries.includes(v))) return false;
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
