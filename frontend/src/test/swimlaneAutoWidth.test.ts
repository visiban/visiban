import { describe, it, expect } from "vitest";
import { computeAutoSwimlaneWidth, DEFAULT_SWIMLANE_WIDTH, MAX_AUTO_SWIMLANE_WIDTH } from "../utils/swimlaneAutoWidth";
import type { SwimlaneCustomFieldDefinition } from "../types";

const def = (id: number, name: string, position: number, show_on_row = true, field_type = "text") =>
  ({ id, name, position, show_on_row, field_type }) as SwimlaneCustomFieldDefinition;
const lane = (name: string, values: [number, string][] = []) => ({
  name,
  custom_field_values: values.map(([field_definition, value]) => ({ field_definition, value })),
}) as never;

describe("computeAutoSwimlaneWidth", () => {
  it("never goes below the default width", () => {
    expect(computeAutoSwimlaneWidth([lane("A")], [])).toBe(DEFAULT_SWIMLANE_WIDTH);
    expect(computeAutoSwimlaneWidth([], undefined)).toBe(DEFAULT_SWIMLANE_WIDTH);
  });

  it("widens for a long lane name", () => {
    expect(computeAutoSwimlaneWidth([lane("Cascade Energy Partners International")], [])).toBeGreaterThan(DEFAULT_SWIMLANE_WIDTH);
  });

  it("widens for a long pinned chip but ignores unpinned fields", () => {
    const long = "Marcus Webb-Hargreaves III";
    const pinned = computeAutoSwimlaneWidth([lane("A", [[1, long]])], [def(1, "Account director", 0)]);
    const unpinned = computeAutoSwimlaneWidth([lane("A", [[1, long]])], [def(1, "Account director", 0, false)]);
    expect(pinned).toBeGreaterThan(DEFAULT_SWIMLANE_WIDTH);
    expect(unpinned).toBe(DEFAULT_SWIMLANE_WIDTH);
  });

  it("caps at the resize maximum", () => {
    expect(computeAutoSwimlaneWidth([lane("x".repeat(200))], [])).toBe(MAX_AUTO_SWIMLANE_WIDTH);
  });

  describe("hidden field names (#1418)", () => {
    const longName = "Account director for the region";

    it("defaults to counting the name, matching shown names", () => {
      const lanes = [lane("A", [[1, "Diane"]])];
      const defs = [def(1, longName, 0)];
      expect(computeAutoSwimlaneWidth(lanes, defs)).toBe(computeAutoSwimlaneWidth(lanes, defs, true));
      expect(computeAutoSwimlaneWidth(lanes, defs)).toBeGreaterThan(DEFAULT_SWIMLANE_WIDTH);
    });

    it("drops the name term for non-checkbox chips when names are hidden", () => {
      const lanes = [lane("A", [[1, "Diane"]])];
      const defs = [def(1, longName, 0)];
      expect(computeAutoSwimlaneWidth(lanes, defs, false)).toBe(DEFAULT_SWIMLANE_WIDTH);
    });

    it("still honors a long lane name when names are hidden", () => {
      const lanes = [lane("Cascade Energy Partners International", [[1, "Diane"]])];
      expect(computeAutoSwimlaneWidth(lanes, [def(1, longName, 0)], false)).toBeGreaterThan(DEFAULT_SWIMLANE_WIDTH);
    });

    it("keeps the name term for checkbox chips, which always show their name", () => {
      const lanes = [lane("A", [[1, "Yes"]])];
      const defs = [def(1, longName, 0, true, "checkbox")];
      expect(computeAutoSwimlaneWidth(lanes, defs, false)).toBe(computeAutoSwimlaneWidth(lanes, defs, true));
      expect(computeAutoSwimlaneWidth(lanes, defs, false)).toBeGreaterThan(DEFAULT_SWIMLANE_WIDTH);
    });
  });
});
