import { describe, it, expect } from "vitest";
import { filterCards, hasActiveClientFilters, pruneStaleCustomFields, pruneStaleFilters, pruneStaleLabelIds } from "../utils/filterCards";
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
    blocker_count: 0, external_ref: null, is_blocked: false, blocked_at: null, blocked_reason: '',
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

    it("supports * / ? wildcards and /regex/ (#2227)", () => {
      const cards = [
        makeCard({ id: 1, custom_field_values: [{ field_definition: 5, value: "Ethan Ross" }] }),
        makeCard({ id: 2, custom_field_values: [{ field_definition: 5, value: "Ross Ethan" }] }),
        makeCard({ id: 3, custom_field_values: [{ field_definition: 5, value: "Amy Lee" }] }),
      ];
      const run = (query: string) =>
        filterCards(cards, { ...EMPTY_FILTER, customFields: { 5: { kind: "text" as const, query } } });
      expect(run("e*ross")).toEqual([1]);
      expect(run("amy ?ee")).toEqual([3]);
      expect(run("/^ethan/")).toEqual([1]);
      expect(run("/ross$|lee$/")).toEqual([1, 3]);
    });

    it("treats an invalid pattern as an inactive filter, not match-nothing (#2227)", () => {
      const cards = [
        makeCard({ id: 1, custom_field_values: [{ field_definition: 5, value: "Ethan Ross" }] }),
        makeCard({ id: 2, custom_field_values: [] }),
      ];
      for (const query of ["/[/", "/(a+)+$/"]) {
        const filters = { ...EMPTY_FILTER, customFields: { 5: { kind: "text" as const, query } } };
        expect(filterCards(cards, filters)).toEqual([1, 2]);
        expect(hasActiveClientFilters(filters)).toBe(false);
      }
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

    // #1848 — a checkbox row only exists when set; clearing deletes it.
    describe("checkbox with no stored row", () => {
      const defs = [{ id: 5, field_type: "checkbox" }];
      const cards = [
        makeCard({ id: 1, custom_field_values: [] }),
        makeCard({ id: 2, custom_field_values: [{ field_definition: 5, value: "true" }] }),
        makeCard({ id: 3, custom_field_values: [{ field_definition: 5, value: "false" }] }),
      ];
      const f = (values: string[]) => ({ ...EMPTY_FILTER, customFields: { 5: { kind: "choice" as const, values } } });

      it("No matches unchecked and never-set cards, not checked ones", () => {
        expect(filterCards(cards, f(["false"]), null, "2026-01-01", defs)).toEqual([1, 3]);
      });
      it("Yes matches only checked cards", () => {
        expect(filterCards(cards, f(["true"]), null, "2026-01-01", defs)).toEqual([2]);
      });
      it("both selected matches every card", () => {
        expect(filterCards(cards, f(["true", "false"]), null, "2026-01-01", defs)).toEqual([1, 2, 3]);
      });
      it("a dropdown with no row still matches nothing", () => {
        const dd = [{ id: 5, field_type: "dropdown" }];
        expect(filterCards(cards, f(["false"]), null, "2026-01-01", dd)).toEqual([3]);
      });
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

describe("pruneStaleLabelIds (#1888)", () => {
  it("drops label ids that are no longer on the board and keeps live ones", () => {
    const f = { ...EMPTY_FILTER, labelIds: [1, 2, 3] };
    const pruned = pruneStaleLabelIds(f, [{ id: 1 }, { id: 3 }]);
    expect(pruned.labelIds).toEqual([1, 3]);
    expect(pruned).not.toBe(f);
  });

  it("returns the same object when nothing is stale or no label filter is set", () => {
    const f = { ...EMPTY_FILTER, labelIds: [1] };
    expect(pruneStaleLabelIds(f, [{ id: 1 }])).toBe(f);
    expect(pruneStaleLabelIds(EMPTY_FILTER, [])).toBe(EMPTY_FILTER);
  });

  it("a filter pruned of its only (deleted) label no longer hides every card", () => {
    const cards = [makeCard({ id: 1 }), makeCard({ id: 2 })];
    const f = { ...EMPTY_FILTER, labelIds: [9] };
    expect(filterCards(cards, f)).toEqual([]);
    expect(filterCards(cards, pruneStaleLabelIds(f, []))).toEqual([1, 2]);
  });
});

describe("pruneStaleCustomFields (#1928)", () => {
  const f = {
    ...EMPTY_FILTER,
    customFields: { 5: { kind: "text" as const, query: "x" }, 9: { kind: "text" as const, query: "y" } },
    visibleCustomFieldFilterIds: [5, 9],
  };

  it("drops entries and visible ids for deleted fields and keeps live ones", () => {
    const pruned = pruneStaleCustomFields(f, [{ id: 5 }]);
    expect(Object.keys(pruned.customFields)).toEqual(["5"]);
    expect(pruned.visibleCustomFieldFilterIds).toEqual([5]);
    expect(pruned).not.toBe(f);
  });

  it("prunes a stale visible id even when no filter value is set", () => {
    const g = { ...EMPTY_FILTER, visibleCustomFieldFilterIds: [9] };
    expect(pruneStaleCustomFields(g, []).visibleCustomFieldFilterIds).toEqual([]);
  });

  it("returns the same object when nothing is stale", () => {
    expect(pruneStaleCustomFields(f, [{ id: 5 }, { id: 9 }])).toBe(f);
    expect(pruneStaleCustomFields(EMPTY_FILTER, [])).toBe(EMPTY_FILTER);
  });

  it("a filter on a deleted field no longer hides every card; a live one still filters", () => {
    const cards = [makeCard({ id: 1 }), makeCard({ id: 2, custom_field_values: [{ field_definition: 5, value: "x" }] })];
    expect(filterCards(cards, f)).toEqual([]);
    expect(filterCards(cards, pruneStaleCustomFields(f, []))).toEqual([1, 2]);
    expect(filterCards(cards, pruneStaleCustomFields({ ...f, customFields: { 5: f.customFields[5] } }, [{ id: 5 }]))).toEqual([2]);
  });

  it("pruneStaleFilters applies both label and custom-field pruning", () => {
    const g = { ...f, labelIds: [1, 2] };
    const out = pruneStaleFilters(g, { labels: [{ id: 1 }], custom_field_definitions: [{ id: 9 }] });
    expect(out.labelIds).toEqual([1]);
    expect(Object.keys(out.customFields)).toEqual(["9"]);
  });
});
