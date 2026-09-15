import { describe, it, expect } from "vitest";
import {
  choiceColor,
  formatCustomFieldValue,
  isValidForType,
  withCustomFieldValue,
} from "../utils/customFieldValue";
import type { CustomFieldDefinition } from "../types";

function makeDefinition(overrides: Partial<CustomFieldDefinition> = {}): CustomFieldDefinition {
  return {
    id: 1,
    uid: "cfuid001",
    name: "Sprint",
    field_type: "text",
    choices: [],
    position: 0,
    show_on_card: false,
    is_required: false,
    help_text: "",
    created_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

describe("choiceColor", () => {
  it("is deterministic for the same input", () => {
    expect(choiceColor("Beta")).toBe(choiceColor("Beta"));
  });

  it("returns a hex color from the shared palette", () => {
    expect(choiceColor("Beta")).toMatch(/^#[0-9A-F]{6}$/i);
  });

  it("differs for different inputs (not a constant fallback)", () => {
    // Not a strict guarantee across all strings given a bounded palette, but
    // true for this specific pair — regressions here usually mean the hash
    // was replaced with something that always returns index 0.
    expect(choiceColor("Beta")).not.toBe(choiceColor("Gamma-long-string-2"));
  });
});

describe("isValidForType", () => {
  it("treats an empty string as always valid, regardless of type", () => {
    for (const field_type of ["text", "number", "date", "dropdown", "checkbox"] as const) {
      expect(isValidForType(makeDefinition({ field_type }), "")).toBe(true);
    }
  });

  it("accepts a finite number string for number fields", () => {
    expect(isValidForType(makeDefinition({ field_type: "number" }), "42")).toBe(true);
    expect(isValidForType(makeDefinition({ field_type: "number" }), "-3.5")).toBe(true);
  });

  it("rejects a non-numeric string for number fields", () => {
    expect(isValidForType(makeDefinition({ field_type: "number" }), "not-a-number")).toBe(false);
  });

  it("accepts a well-formed YYYY-MM-DD string for date fields", () => {
    expect(isValidForType(makeDefinition({ field_type: "date" }), "2026-03-12")).toBe(true);
  });

  it("rejects a malformed date string", () => {
    expect(isValidForType(makeDefinition({ field_type: "date" }), "March 12")).toBe(false);
    expect(isValidForType(makeDefinition({ field_type: "date" }), "2026/03/12")).toBe(false);
  });

  it("accepts only the literal strings 'true'/'false' for checkbox fields", () => {
    expect(isValidForType(makeDefinition({ field_type: "checkbox" }), "true")).toBe(true);
    expect(isValidForType(makeDefinition({ field_type: "checkbox" }), "false")).toBe(true);
    expect(isValidForType(makeDefinition({ field_type: "checkbox" }), "yes")).toBe(false);
    expect(isValidForType(makeDefinition({ field_type: "checkbox" }), "1")).toBe(false);
  });

  it("never rejects a dropdown value — orphaned choices are a display concern, not a validity one", () => {
    expect(isValidForType(makeDefinition({ field_type: "dropdown", choices: ["A", "B"] }), "no-longer-a-choice")).toBe(true);
  });

  it("always accepts a text value", () => {
    expect(isValidForType(makeDefinition({ field_type: "text" }), "anything at all")).toBe(true);
  });

  // #1121 — this guard exists specifically because field_type has no backend
  // immutability check, so a stored value can legitimately stop matching its
  // field's current type after an admin retypes the field.
  it("flags a value that no longer parses after a simulated retype", () => {
    const retyped = makeDefinition({ field_type: "number" });
    expect(isValidForType(retyped, "waiting on legal review")).toBe(false);
  });
});

describe("formatCustomFieldValue", () => {
  it("formats a date value using the given date format", () => {
    expect(formatCustomFieldValue(makeDefinition({ field_type: "date" }), "2026-03-12", "MM/DD/YYYY")).toBe("03/12/2026");
  });

  it("formats checkbox 'true' as 'Yes' and 'false' as 'No'", () => {
    expect(formatCustomFieldValue(makeDefinition({ field_type: "checkbox" }), "true", "MM/DD/YYYY")).toBe("Yes");
    expect(formatCustomFieldValue(makeDefinition({ field_type: "checkbox" }), "false", "MM/DD/YYYY")).toBe("No");
  });

  it("passes text, number, and dropdown values through unchanged", () => {
    expect(formatCustomFieldValue(makeDefinition({ field_type: "text" }), "hello", "MM/DD/YYYY")).toBe("hello");
    expect(formatCustomFieldValue(makeDefinition({ field_type: "number" }), "8", "MM/DD/YYYY")).toBe("8");
    expect(formatCustomFieldValue(makeDefinition({ field_type: "dropdown" }), "Beta", "MM/DD/YYYY")).toBe("Beta");
  });
});

describe("withCustomFieldValue", () => {
  it("inserts a new entry when the field has no existing value", () => {
    const result = withCustomFieldValue([], 5, "14");
    expect(result).toEqual([{ field_definition: 5, value: "14" }]);
  });

  it("replaces an existing entry for the same field, preserving other entries", () => {
    const current = [
      { field_definition: 1, value: "old" },
      { field_definition: 2, value: "untouched" },
    ];
    const result = withCustomFieldValue(current, 1, "new");
    expect(result).toEqual([
      { field_definition: 1, value: "new" },
      { field_definition: 2, value: "untouched" },
    ]);
  });

  it("clearing sends an empty string rather than removing the entry", () => {
    const current = [{ field_definition: 1, value: "set" }];
    const result = withCustomFieldValue(current, 1, "");
    expect(result).toEqual([{ field_definition: 1, value: "" }]);
  });

  it("does not mutate the input array", () => {
    const current = [{ field_definition: 1, value: "a" }];
    withCustomFieldValue(current, 1, "b");
    expect(current).toEqual([{ field_definition: 1, value: "a" }]);
  });
});
