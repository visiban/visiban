import { describe, it, expect } from "vitest";
import { activityLabel } from "../utils/cardTimelineLabels";

const row = (event_type: string, from_value: string, to_value: string, item_text: string | null = "Security") => ({
  event_type, from_value, to_value, item_text,
});

describe("activityLabel for dimension plan edits (#2703)", () => {
  it("names the dimension and both owners, with Unassigned for none", () => {
    expect(activityLabel("dimension_owner_changed", row("dimension_owner_changed", "", "priya"))).toBe(
      "Security owner: Unassigned → priya",
    );
    expect(activityLabel("dimension_owner_changed", row("dimension_owner_changed", "priya", ""))).toBe(
      "Security owner: priya → Unassigned",
    );
  });

  it("shows the next action text in full", () => {
    expect(
      activityLabel("dimension_next_action_changed", row("dimension_next_action_changed", "", "Book review")),
    ).toBe("Security next action: (none) → Book review");
  });

  it("formats target dates in the reader's date format", () => {
    expect(
      activityLabel(
        "dimension_target_date_changed",
        row("dimension_target_date_changed", "2026-11-20", "2026-12-04"),
        "YYYY-MM-DD",
      ),
    ).toBe("Security target date: 2026-11-20 → 2026-12-04");
    expect(
      activityLabel("dimension_target_date_changed", row("dimension_target_date_changed", "2026-11-20", "")),
    ).toMatch(/→ \(none\)$/);
  });

  it("falls back to 'Dimension' on a row with no name", () => {
    expect(activityLabel("dimension_owner_changed", row("dimension_owner_changed", "a", "b", null))).toBe(
      "Dimension owner: a → b",
    );
  });
});
