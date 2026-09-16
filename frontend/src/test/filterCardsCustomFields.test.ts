import { describe, it, expect } from "vitest";
import { filterCards, hasActiveClientFilters } from "../utils/filterCards";
import { EMPTY_FILTER } from "../components/Board/FilterBar";
import type { Card } from "../types";

// #371 — filterCards' custom-field predicate coverage. Only the fields this
// module actually reads are populated; the rest are the minimum Card shape.
function makeCard(overrides: Partial<Card> = {}): Card {
  return {
    id: 1, uid: "carduid00001", column: 10, swimlane: 20, title: "Card",
    description: "", priority: "medium", assignee: null, labels: [],
    due_date: null, weight: 1, position: 0, created_by: null,
    created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z",
    last_moved_at: null, attachment_count: 0, checklist_total: 0, checklist_done: 0,
    is_stale: false, archived_at: null, version: 1,
    custom_field_values: [],
    blocker_count: 0,
    ...overrides,
  };
}

describe("filterCards — custom field filters (#371)", () => {
  it("returns every card when no custom field filter is active", () => {
    const cards = [makeCard({ id: 1 }), makeCard({ id: 2 })];
    expect(filterCards(cards, EMPTY_FILTER)).toEqual([1, 2]);
  });

  describe("text kind", () => {
    it("matches a card whose value contains the query, case-insensitively", () => {
      const cards = [
        makeCard({ id: 1, custom_field_values: [{ field_definition: 5, value: "Waiting on Legal review" }] }),
        makeCard({ id: 2, custom_field_values: [{ field_definition: 5, value: "Ready" }] }),
      ];
      const filters = { ...EMPTY_FILTER, customFields: { 5: { kind: "text" as const, query: "legal" } } };
      expect(filterCards(cards, filters)).toEqual([1]);
    });

    it("excludes a card with no value at all for the filtered field", () => {
      const cards = [makeCard({ id: 1, custom_field_values: [] })];
      const filters = { ...EMPTY_FILTER, customFields: { 5: { kind: "text" as const, query: "legal" } } };
      expect(filterCards(cards, filters)).toEqual([]);
    });

    it("does not filter when the query is empty (open control, no value)", () => {
      const cards = [makeCard({ id: 1, custom_field_values: [] })];
      const filters = { ...EMPTY_FILTER, customFields: { 5: { kind: "text" as const, query: "" } } };
      expect(filterCards(cards, filters)).toEqual([1]);
    });
  });

  describe("number kind", () => {
    it("matches on numeric equality, not string equality", () => {
      const cards = [
        makeCard({ id: 1, custom_field_values: [{ field_definition: 5, value: "8" }] }),
        makeCard({ id: 2, custom_field_values: [{ field_definition: 5, value: "8.0" }] }),
        makeCard({ id: 3, custom_field_values: [{ field_definition: 5, value: "13" }] }),
      ];
      const filters = { ...EMPTY_FILTER, customFields: { 5: { kind: "number" as const, equals: "8" } } };
      expect(filterCards(cards, filters)).toEqual([1, 2]);
    });

    it("excludes a card whose value doesn't parse as a number (e.g. after a retype, #1121)", () => {
      const cards = [makeCard({ id: 1, custom_field_values: [{ field_definition: 5, value: "not-a-number" }] })];
      const filters = { ...EMPTY_FILTER, customFields: { 5: { kind: "number" as const, equals: "8" } } };
      expect(filterCards(cards, filters)).toEqual([]);
    });
  });

  describe("date kind", () => {
    it("matches on exact YYYY-MM-DD string equality", () => {
      const cards = [
        makeCard({ id: 1, custom_field_values: [{ field_definition: 5, value: "2026-03-12" }] }),
        makeCard({ id: 2, custom_field_values: [{ field_definition: 5, value: "2026-03-13" }] }),
      ];
      const filters = { ...EMPTY_FILTER, customFields: { 5: { kind: "date" as const, equals: "2026-03-12" } } };
      expect(filterCards(cards, filters)).toEqual([1]);
    });
  });

  describe("choice kind (dropdown / checkbox)", () => {
    it("matches a card whose value is in the selected choices", () => {
      const cards = [
        makeCard({ id: 1, custom_field_values: [{ field_definition: 5, value: "Beta" }] }),
        makeCard({ id: 2, custom_field_values: [{ field_definition: 5, value: "GA" }] }),
      ];
      const filters = { ...EMPTY_FILTER, customFields: { 5: { kind: "choice" as const, values: ["Beta", "Alpha"] } } };
      expect(filterCards(cards, filters)).toEqual([1]);
    });

    it("does not filter when no choices are selected", () => {
      const cards = [makeCard({ id: 1, custom_field_values: [] })];
      const filters = { ...EMPTY_FILTER, customFields: { 5: { kind: "choice" as const, values: [] } } };
      expect(filterCards(cards, filters)).toEqual([1]);
    });

    it("matches checkbox filtering, treating true/false as choice values", () => {
      const cards = [
        makeCard({ id: 1, custom_field_values: [{ field_definition: 5, value: "true" }] }),
        makeCard({ id: 2, custom_field_values: [{ field_definition: 5, value: "false" }] }),
      ];
      const filters = { ...EMPTY_FILTER, customFields: { 5: { kind: "choice" as const, values: ["true"] } } };
      expect(filterCards(cards, filters)).toEqual([1]);
    });
  });

  it("AND-combines multiple custom field filters with each other and with built-in dimensions", () => {
    const cards = [
      makeCard({ id: 1, priority: "high", custom_field_values: [{ field_definition: 5, value: "14" }, { field_definition: 6, value: "Beta" }] }),
      makeCard({ id: 2, priority: "high", custom_field_values: [{ field_definition: 5, value: "14" }, { field_definition: 6, value: "GA" }] }),
      makeCard({ id: 3, priority: "low", custom_field_values: [{ field_definition: 5, value: "14" }, { field_definition: 6, value: "Beta" }] }),
    ];
    const filters = {
      ...EMPTY_FILTER,
      priorities: ["high" as const],
      customFields: {
        5: { kind: "number" as const, equals: "14" },
        6: { kind: "choice" as const, values: ["Beta"] },
      },
    };
    expect(filterCards(cards, filters)).toEqual([1]);
  });
});

// #371 — regression coverage for a real bug: BoardView's own gate for "is any
// client-side filter active" (used to decide whether filterCards runs at
// all) was not updated when the custom-fields dimension was added, so a
// custom-field-only filter silently left every card visible while the
// toolbar chip claimed a filter was active. hasActiveClientFilters is the
// single source of truth BoardView now calls instead of a second, inline
// copy of this same disjunction — these tests exist specifically so that
// dimension can never again drift out of sync the way it did once already.
describe("hasActiveClientFilters (#371 regression)", () => {
  it("is false for EMPTY_FILTER", () => {
    expect(hasActiveClientFilters(EMPTY_FILTER)).toBe(false);
  });

  it("is true when a custom field filter alone is active — the exact bug this guards against", () => {
    const filters = { ...EMPTY_FILTER, customFields: { 5: { kind: "text" as const, query: "sprint 14" } } };
    expect(hasActiveClientFilters(filters)).toBe(true);
  });

  it("is false when a custom field control is open (visibleCustomFieldFilterIds) but carries no value", () => {
    const filters = { ...EMPTY_FILTER, visibleCustomFieldFilterIds: [5] };
    expect(hasActiveClientFilters(filters)).toBe(false);
  });

  it("is true for each of the pre-existing dimensions (assignee/label/priority/due date)", () => {
    expect(hasActiveClientFilters({ ...EMPTY_FILTER, assigneeIds: [1] })).toBe(true);
    expect(hasActiveClientFilters({ ...EMPTY_FILTER, labelIds: [1] })).toBe(true);
    expect(hasActiveClientFilters({ ...EMPTY_FILTER, priorities: ["high"] })).toBe(true);
    expect(hasActiveClientFilters({ ...EMPTY_FILTER, dueDate: "overdue" })).toBe(true);
  });

  it("is false for search alone — search is handled by BoardView's separate server-side path, not this gate", () => {
    expect(hasActiveClientFilters({ ...EMPTY_FILTER, search: "bug" })).toBe(false);
  });
});
