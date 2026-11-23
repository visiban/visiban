import { describe, it, expect } from "vitest";
import { activeDueDate } from "../utils/plannedFields";
import { agingReference } from "../utils/agingTint";
import { filterCards } from "../utils/filterCards";
import { cardShowChip, showChipCardIds, showChipCounts } from "../utils/showChips";
import { cardBoardStatus } from "../constants/laneStatus";
import { buildKeyFacts } from "../utils/cardKeyFacts";
import { EMPTY_FILTER } from "../components/Board/FilterBar";
import type { BoardFull, Card } from "../types";

// #2371: a planned child's stored date is inactive, on every surface that judges Overdue or Due soon.
const PAST = "2020-01-02";

function makeCard(overrides: Partial<Card> = {}): Card {
  return {
    id: 1, uid: "carduid02371", column: 10, swimlane: 20, title: "Card",
    description: "", priority: "medium", assignee: null, labels: [],
    due_date: null, weight: 1, position: 0, created_by: null,
    created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z",
    last_moved_at: null, attachment_count: 0, checklist_total: 0, checklist_done: 0,
    is_stale: false, archived_at: null, version: 1, custom_field_values: [],
    blocker_count: 0, external_ref: null, is_blocked: false, blocked_at: null, blocked_reason: "",
    ...overrides,
  };
}

const planned = makeCard({ id: 1, due_date: PAST, planned: true });
const ordinary = makeCard({ id: 2, due_date: PAST });
const released = makeCard({ id: 3, due_date: PAST, planned: false, planned_released_at: "2026-11-20T00:00:00Z" });
const columns = [{ id: 10, is_done: false }];

describe("activeDueDate (#2371)", () => {
  it("is null while planned and the stored date otherwise", () => {
    expect(activeDueDate(planned)).toBeNull();
    expect(activeDueDate(ordinary)).toBe(PAST);
    expect(activeDueDate(released)).toBe(PAST);
    expect(activeDueDate({ due_date: PAST })).toBe(PAST);
  });
});

describe("planned children leave Overdue (#2371)", () => {
  it("the Due date: Overdue filter keeps only the live dates", () => {
    const filters = { ...EMPTY_FILTER, dueDate: "overdue" as const };
    expect(filterCards([planned, ordinary, released], filters)).toEqual([2, 3]);
  });

  it("the Show chips count a planned child in no chip", () => {
    expect(cardShowChip(planned, false)).toBeNull();
    expect(cardShowChip(ordinary, false)).toBe("overdue");
    const counts = showChipCounts([planned], columns);
    expect(counts).toEqual({ all: 1, overdue: 0, stale: 0, due_soon: 0 });
    expect([...showChipCardIds([planned, ordinary], columns, "overdue")]).toEqual([2]);
  });

  it("the lane squares and band counts read it as on track", () => {
    expect(cardBoardStatus(planned, false)).toBe("ok");
    expect(cardBoardStatus(ordinary, false)).toBe("overdue");
  });

  it("the key facts do not call it overdue", () => {
    const board = { columns: [{ id: 10, is_done: false, name: "To do" }], swimlanes: [], custom_field_definitions: [] } as unknown as BoardFull;
    const due = (card: Card) => buildKeyFacts({ card, board, userTimezone: "UTC", userDateFormat: "MM/DD/YYYY" }).find((f) => f.key === "due");
    expect(due(planned)?.label).not.toContain("overdue");
    expect(due(planned)?.tone).toBeUndefined();
    expect(due(ordinary)?.label).toContain(", overdue");
  });
});

describe("agingReference (#2371)", () => {
  const base = { created_at: "2025-01-01T00:00:00Z", last_moved_at: "2025-06-01T00:00:00Z" };
  it("has no reference while planned", () => {
    expect(agingReference({ ...base, planned: true })).toBeNull();
  });
  it("uses the later of the last move and the release", () => {
    expect(agingReference({ ...base, planned: false, planned_released_at: "2026-11-20T00:00:00Z" })).toBe("2026-11-20T00:00:00Z");
    expect(agingReference({ ...base, planned_released_at: "2024-01-01T00:00:00Z" })).toBe(base.last_moved_at);
    expect(agingReference({ created_at: base.created_at, last_moved_at: null, planned_released_at: "2026-11-20T00:00:00Z" })).toBe("2026-11-20T00:00:00Z");
    expect(agingReference(base)).toBe(base.last_moved_at);
  });
});
