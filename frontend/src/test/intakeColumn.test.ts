import { describe, it, expect } from "vitest";
import type { Column } from "../types";
import { firstNotDoneColumn, isIntakeColumn, wouldBecomeIntakeColumn } from "../utils/intakeColumn";

const col = (id: number, position: number, is_done = false): Column => ({
  id, uid: `c${id}`, name: `Col ${id}`, position, color: "#000", wip_limit: null,
  weight_limit: null, allow_card_creation: true, is_done, policy: null,
});

describe("firstNotDoneColumn (#2298)", () => {
  it("returns the lowest-position not-done column", () => {
    expect(firstNotDoneColumn([col(1, 0), col(2, 1), col(3, 2, true)])?.id).toBe(1);
  });
  it("skips leading done columns", () => {
    expect(firstNotDoneColumn([col(1, 0, true), col(2, 1), col(3, 2)])?.id).toBe(2);
  });
  it("uses array order even when stale positions disagree (optimistic reorder)", () => {
    expect(firstNotDoneColumn([col(2, 1), col(1, 0)])?.id).toBe(2);
  });
  it("is null with no columns or only done columns", () => {
    expect(firstNotDoneColumn([])).toBeNull();
    expect(firstNotDoneColumn([col(1, 0, true)])).toBeNull();
  });
});

describe("isIntakeColumn", () => {
  const cols = [col(1, 0), col(2, 1), col(3, 2, true)];
  it("is true only for the first not-done column", () => {
    expect(isIntakeColumn(cols[0], cols)).toBe(true);
    expect(isIntakeColumn(cols[1], cols)).toBe(false);
    expect(isIntakeColumn(cols[2], cols)).toBe(false);
  });
  it("follows reordering", () => {
    const moved = [col(2, 1), col(1, 0), col(3, 2, true)];
    expect(isIntakeColumn(moved[0], moved)).toBe(true);
    expect(isIntakeColumn(moved[1], moved)).toBe(false);
  });
  it("is false for a done column even when it is first", () => {
    const doneFirst = [col(1, 0, true), col(2, 1)];
    expect(isIntakeColumn(doneFirst[0], doneFirst)).toBe(false);
    expect(isIntakeColumn(doneFirst[1], doneFirst)).toBe(true);
  });
});

describe("wouldBecomeIntakeColumn", () => {
  const cols = [col(1, 0), col(2, 1), col(3, 2, true)];
  it("is true on an empty board, appended or inserted", () => {
    expect(wouldBecomeIntakeColumn([], null)).toBe(true);
    expect(wouldBecomeIntakeColumn([], 0)).toBe(true);
  });
  it("treats a negative index as 0", () => {
    expect(wouldBecomeIntakeColumn(cols, -1)).toBe(true);
  });
  it("is true when inserted left of every not-done column", () => {
    expect(wouldBecomeIntakeColumn(cols, 0)).toBe(true);
  });
  it("is false when a not-done column sits to its left", () => {
    expect(wouldBecomeIntakeColumn(cols, 1)).toBe(false);
    expect(wouldBecomeIntakeColumn(cols, null)).toBe(false);
  });
  it("is true when only done columns sit to its left", () => {
    const doneFirst = [col(1, 0, true), col(2, 1)];
    expect(wouldBecomeIntakeColumn(doneFirst, 1)).toBe(true);
    expect(wouldBecomeIntakeColumn(doneFirst, 2)).toBe(false);
  });
  it("appending to a board of only done columns takes over", () => {
    expect(wouldBecomeIntakeColumn([col(1, 0, true)], null)).toBe(true);
  });
});
