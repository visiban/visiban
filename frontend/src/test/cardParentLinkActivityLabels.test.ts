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
