import { describe, it, expect } from "vitest";
import {
  CUSTOM_FIELD_VALUE_MAX,
  URL_ERROR_COPY,
  choiceColor,
  formatCustomFieldValue,
  isValidForType,
  normalizeUrl,
  urlDisplayHostname,
  urlErrorFromServer,
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
    for (const field_type of ["text", "number", "date", "dropdown", "checkbox", "url"] as const) {
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

describe("normalizeUrl (#1390)", () => {
  it("accepts http and https URLs as typed", () => {
    expect(normalizeUrl("https://wiki.example.com/a?b=1#c")).toEqual({ ok: true, url: "https://wiki.example.com/a?b=1#c" });
    expect(normalizeUrl("http://10.0.0.5:8080/status")).toEqual({ ok: true, url: "http://10.0.0.5:8080/status" });
    // Scheme case is preserved — the server stores as typed.
    expect(normalizeUrl("HTTPS://Example.com/")).toEqual({ ok: true, url: "HTTPS://Example.com/" });
  });

  it("prepends https:// to a bare domain, including host:port forms", () => {
    expect(normalizeUrl("example.com")).toEqual({ ok: true, url: "https://example.com" });
    expect(normalizeUrl("example.com/path")).toEqual({ ok: true, url: "https://example.com/path" });
    expect(normalizeUrl("localhost:8080")).toEqual({ ok: true, url: "https://localhost:8080" });
    expect(normalizeUrl("example.com:8443/x")).toEqual({ ok: true, url: "https://example.com:8443/x" });
  });

  it("trims surrounding whitespace", () => {
    expect(normalizeUrl("  https://example.com  ")).toEqual({ ok: true, url: "https://example.com" });
  });

  it("rejects — never rewrites — a non-http(s) scheme", () => {
    for (const raw of ["javascript:alert(1)", "JaVaScript:alert(1)", "data:text/html,<b>x</b>", "ftp://files.example.com", "mailto:a@example.com"]) {
      expect(normalizeUrl(raw)).toEqual({ ok: false, error: "scheme" });
    }
  });

  it("rejects values with no hostname or that the server would refuse", () => {
    for (const raw of ["", "   ", "https://", "http://a\\b", "https://user:pass@example.com", "https://exa mple.com", "https://ex%61mple.com", "https://example.com:99999", "\u0001https://example.com"]) {
      expect(normalizeUrl(raw).ok).toBe(false);
    }
  });

  it("enforces the 500-character cap, counting an added scheme", () => {
    const base = "https://example.com/";
    const atCap = base + "a".repeat(CUSTOM_FIELD_VALUE_MAX - base.length);
    expect(normalizeUrl(atCap).ok).toBe(true);
    expect(normalizeUrl(atCap + "a")).toEqual({ ok: false, error: "length" });
    const bare = "example.com/" + "a".repeat(CUSTOM_FIELD_VALUE_MAX - "example.com/".length);
    expect(normalizeUrl(bare)).toEqual({ ok: false, error: "length" });
  });

  it("drives isValidForType for url fields", () => {
    const url = makeDefinition({ field_type: "url" });
    expect(isValidForType(url, "https://example.com")).toBe(true);
    expect(isValidForType(url, "javascript:alert(1)")).toBe(false);
  });

  it("formats a url value as the full address", () => {
    expect(formatCustomFieldValue(makeDefinition({ field_type: "url" }), "https://www.example.com/x", "MM/DD/YYYY")).toBe("https://www.example.com/x");
  });
});

describe("urlDisplayHostname / urlErrorFromServer (#1390)", () => {
  it("strips only a leading www.", () => {
    expect(urlDisplayHostname("https://www.example.com/a")).toBe("example.com");
    expect(urlDisplayHostname("https://docs.www.example.com")).toBe("docs.www.example.com");
  });

  it("maps a 400 to the editor copy and ignores other failures", () => {
    const err400 = (msg: string) => ({ response: { status: 400, data: { custom_field_values: [msg] } } });
    expect(urlErrorFromServer(err400("'Docs': Only http and https URLs are allowed."))).toBe(URL_ERROR_COPY.scheme);
    expect(urlErrorFromServer(err400("'Docs' value is longer than 500 characters."))).toBe(URL_ERROR_COPY.length);
    expect(urlErrorFromServer(err400("'Docs': Enter a valid URL."))).toBe(URL_ERROR_COPY.invalid);
    expect(urlErrorFromServer({ response: { status: 500, data: {} } })).toBeNull();
    expect(urlErrorFromServer(new Error("network"))).toBeNull();
  });
});
