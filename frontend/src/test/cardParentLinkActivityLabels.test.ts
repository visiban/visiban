import { describe, expect, it } from "vitest";
import { activityLabel } from "../utils/cardTimelineLabels";

// #1104: link history rows carry only the other card's id, which may be on a
// board the reader cannot open, so the label never shows it.
describe("activityLabel for cross-board link rows", () => {
  it.each([
    ["parent_linked", "Parent linked"],
    ["parent_unlinked", "Parent unlinked"],
    ["child_linked", "Child linked"],
    ["child_unlinked", "Child unlinked"],
  ])("%s reads as %s without the other card's id", (eventType, label) => {
    const text = activityLabel(eventType, { from_value: "4242", to_value: "4242" });
    expect(text).toBe(label);
    expect(text).not.toContain("4242");
  });
});
