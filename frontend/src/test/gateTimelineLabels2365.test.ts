import { describe, it, expect } from "vitest";
import { gateTransitionLabel, lastActivitySummary } from "../utils/cardTimelineLabels";
import type { CardTimelineEntry } from "../types";

const gate = { kind: "pass" as const, column_name: "Build", sub_column_name: "Review", to_index: 1, cause: "move" as const };

describe("gateTransitionLabel (#2365)", () => {
  it("names the sub-column reached and its stage", () => {
    expect(gateTransitionLabel(gate)).toBe("Moved to Review in Build");
    expect(gateTransitionLabel({ ...gate, kind: "reopen", sub_column_name: "Doing", to_index: 0 })).toBe("Moved back to Doing in Build");
  });

  it("falls back to the 1-based position and drops a missing stage name", () => {
    expect(gateTransitionLabel({ ...gate, sub_column_name: "", column_name: "" })).toBe("Moved to sub-column 2");
  });

  it("marks a stage-settings remap", () => {
    expect(gateTransitionLabel({ ...gate, kind: "reopen", cause: "stage_edited" })).toBe("Moved back to Review in Build (stage edited)");
  });
});

describe("lastActivitySummary for a gate entry (#2365)", () => {
  it("reads as who moved where", () => {
    const entry = {
      id: 1, kind: "gate", ts: new Date().toISOString(), event_type: "gate_passed", imported_from_username: null,
      actor: { id: 1, username: "jdoe", display_name: "Jane Doe", avatar_url: "" },
      data: gate as unknown as Record<string, unknown>,
    } as unknown as CardTimelineEntry;
    expect(lastActivitySummary(entry)).toBe("Jane Doe: Moved to Review in Build");
    expect(lastActivitySummary({ ...entry, actor: null })).toBe("Someone: Moved to Review in Build");
  });
});
