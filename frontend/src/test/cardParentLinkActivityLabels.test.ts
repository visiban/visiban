import { describe, expect, it } from "vitest";
import { activityLabel } from "../utils/cardTimelineLabels";

// #1104: link history rows name nothing about the other card, not even its id
// (the server leaves from_value and to_value blank), because it may be on a
// board the reader cannot open. The label must ignore any value it is handed.
describe("activityLabel for cross-board link rows", () => {
  it.each([
    ["parent_linked", "Parent linked"],
    ["parent_unlinked", "Parent unlinked"],
    ["child_linked", "Child linked"],
    ["child_unlinked", "Child unlinked"],
  ])("%s reads as %s and shows no value it is handed", (eventType, label) => {
    const text = activityLabel(eventType, { from_value: "4242", to_value: "4242" });
    expect(text).toBe(label);
    expect(text).not.toContain("4242");
  });
});

// #2208: a whole-board delete on the other end. The parent's row carries only
// a count; the label names no board, so every reader sees the same sentence.
describe("activityLabel for board-deleted link rows", () => {
  it.each([
    ["5", "5 children removed: their board was deleted"],
    ["1", "1 child removed: their board was deleted"],
    ["", "1 child removed: their board was deleted"],
    ["junk", "1 child removed: their board was deleted"],
  ])("children_removed_board_deleted with to_value %j", (toValue, label) => {
    expect(activityLabel("children_removed_board_deleted", { from_value: "", to_value: toValue })).toBe(label);
  });

  it("parent_removed_board_deleted ignores any value it is handed", () => {
    const text = activityLabel("parent_removed_board_deleted", { from_value: "Delivery", to_value: "Delivery" });
    expect(text).toBe("Parent removed: its board was deleted");
    expect(text).not.toContain("Delivery");
  });
});

// #2371: planned-child rows carry cause codes only; the labels name no parent,
// board, column or person, whatever value they are handed.
describe("activityLabel for planned-child rows", () => {
  it.each([
    ["planned_released", "parent_reached", "2026-12-04", "Needed now"],
    ["planned_released", "pulled", "", "Needed now: started before the parent got there"],
    ["needed_changed", "created", "planned", "Created planned for a later stage"],
    ["needed_changed", "manual", "planned", "Needed column changed"],
    ["needed_changed", "manual", "now", "Needed: Now"],
    ["needed_changed", "column_deleted", "now", "Needed: Now (its column was deleted)"],
  ])("%s %s → %s reads as %j", (eventType, from, to, label) => {
    expect(activityLabel(eventType, { from_value: from, to_value: to })).toBe(label);
  });

  it("never echoes a value it is handed", () => {
    for (const eventType of ["planned_released", "needed_changed"]) {
      const text = activityLabel(eventType, { from_value: "Proposal", to_value: "Proposal" });
      expect(text).not.toContain("Proposal");
    }
  });
});
