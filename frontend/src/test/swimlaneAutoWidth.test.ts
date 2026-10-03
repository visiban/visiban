import { describe, it, expect } from "vitest";
import { computeAutoSwimlaneWidth, DEFAULT_SWIMLANE_WIDTH, MAX_AUTO_SWIMLANE_WIDTH } from "../utils/swimlaneAutoWidth";
import type { SwimlaneCustomFieldDefinition } from "../types";

const def = (id: number, name: string, position: number, show_on_row = true) =>
  ({ id, name, position, show_on_row }) as SwimlaneCustomFieldDefinition;
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
});
