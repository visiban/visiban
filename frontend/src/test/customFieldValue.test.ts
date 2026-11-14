import { describe, it, expect } from "vitest";
import {
  CUSTOM_FIELD_VALUE_MAX,
  URL_ERROR_COPY,
  choiceColor,
  formatCustomFieldValue,
  isValidForType,
  normalizeUrl,
  pastedChoicesToAdd,
  urlDisplayHostname,
  urlErrorFromServer,
  withCustomFieldValue,
  thresholdLevel,
  thresholdPhrase,
  thresholdDraftError,
  thresholdPayload,
  thresholdDraftFrom,
} from "../utils/customFieldValue";
import { todayInTimezone } from "../utils/date";
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
    number_prefix: "", number_suffix: "", number_decimals: null, choice_colors: {},
    threshold_direction: "", threshold_warn: null, threshold_alert: null, threshold_warn_days: null, threshold_alert_days: null, created_at: "2026-01-01T00:00:00Z",
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

describe("pastedChoicesToAdd (#2192)", () => {
  it("splits on LF, CRLF, bare CR, and tab", () => {
    expect(pastedChoicesToAdd("a\nb\r\nc\rd\te", [])).toEqual(["a", "b", "c", "d", "e"]);
  });

  it("trims, drops blanks, and keeps commas inside a choice", () => {
    expect(pastedChoicesToAdd("  a  \n\n\t \nSmith, J\n", [])).toEqual(["a", "Smith, J"]);
  });

  it("skips choices already present (compared trimmed) and repeats within the paste", () => {
    expect(pastedChoicesToAdd("a\nb\nb\nc", [" a ", ""])).toEqual(["b", "c"]);
  });

  it("returns nothing for blank text", () => {
    expect(pastedChoicesToAdd(" \r\n\t", ["a"])).toEqual([]);
  });
});


describe("thresholdLevel / thresholdPhrase (#1122)", () => {
  // 2026-03-10 12:00 UTC: still 2026-03-10 in New York, already 2026-03-11 in Auckland.
  const NOW = new Date("2026-03-10T12:00:00Z");
  const num = (o: Partial<CustomFieldDefinition> = {}) =>
    makeDefinition({ field_type: "number", threshold_direction: "above", threshold_warn: 10, threshold_alert: 20, ...o });
  const date = (o: Partial<CustomFieldDefinition> = {}) =>
    makeDefinition({ field_type: "date", threshold_direction: "below", threshold_warn_days: 3, threshold_alert_days: 0, ...o });

  it("is inclusive at both boundaries, alert winning over warning", () => {
    expect(thresholdLevel(num(), "9.99", NOW, "UTC")).toBe("none");
    expect(thresholdLevel(num(), "10", NOW, "UTC")).toBe("warn");
    expect(thresholdLevel(num(), "20", NOW, "UTC")).toBe("alert");
    expect(thresholdLevel(num(), "1e3", NOW, "UTC")).toBe("alert");
    expect(thresholdLevel(num(), "+15", NOW, "UTC")).toBe("warn");
    expect(thresholdLevel(num(), "1.50", NOW, "UTC")).toBe("none");
  });

  it("handles below, a single threshold, off, unparseable values and other types", () => {
    const below = num({ threshold_direction: "below", threshold_warn: 5, threshold_alert: 0 });
    expect(thresholdLevel(below, "5", NOW, "UTC")).toBe("warn");
    expect(thresholdLevel(below, "-1", NOW, "UTC")).toBe("alert");
    expect(thresholdLevel(below, "6", NOW, "UTC")).toBe("none");
    expect(thresholdLevel(num({ threshold_warn: null }), "15", NOW, "UTC")).toBe("none");
    expect(thresholdLevel(num({ threshold_alert: null }), "99", NOW, "UTC")).toBe("warn");
    expect(thresholdLevel(num({ threshold_direction: "" }), "99", NOW, "UTC")).toBe("none");
    expect(thresholdLevel(num(), "lots", NOW, "UTC")).toBe("none");
    expect(thresholdLevel(num(), "", NOW, "UTC")).toBe("none");
    expect(thresholdLevel(num({ field_type: "text" }), "99", NOW, "UTC")).toBe("none");
    expect(thresholdLevel(makeDefinition({ field_type: "number" }), "99", NOW, "UTC")).toBe("none");
  });

  it("measures dates in days from today in the viewer's timezone", () => {
    expect(thresholdLevel(date(), "2026-03-14", NOW, "UTC")).toBe("none");
    expect(thresholdLevel(date(), "2026-03-13", NOW, "UTC")).toBe("warn");
    expect(thresholdLevel(date(), "2026-03-10", NOW, "UTC")).toBe("alert");
    expect(thresholdLevel(date(), "2026-01-01", NOW, "UTC")).toBe("alert");
    // The same instant is a day later in Auckland: the 13th is only 2 days out there.
    expect(thresholdLevel(date({ threshold_warn_days: 2, threshold_alert_days: 1 }), "2026-03-12", NOW, "America/New_York")).toBe("warn");
    expect(thresholdLevel(date({ threshold_warn_days: 2, threshold_alert_days: 1 }), "2026-03-12", NOW, "Pacific/Auckland")).toBe("alert");
    const above = date({ threshold_direction: "above", threshold_warn_days: 30, threshold_alert_days: 60 });
    expect(thresholdLevel(above, "2026-05-09", NOW, "UTC")).toBe("alert");
    expect(thresholdLevel(above, "2026-04-09", NOW, "UTC")).toBe("warn");
  });

  it("treats a blank timezone as UTC, the same today as due dates", () => {
    // 23:30 UTC on Mar 12 is already Mar 13 in Auckland. A blank zone must
    // count Mar 12 (UTC), whatever zone the browser itself is in.
    const late = new Date("2026-03-12T23:30:00Z");
    const def = date({ threshold_warn_days: 2, threshold_alert_days: 1 });
    const savedTz = process.env.TZ;
    process.env.TZ = "Pacific/Auckland";
    try {
      expect(todayInTimezone("", late)).toBe("2026-03-12");
      // Mar 14 is 2 days out from UTC's Mar 12 (warn); from Auckland's Mar 13 it would be 1 (alert).
      expect(thresholdLevel(def, "2026-03-14", late, "")).toBe("warn");
      expect(thresholdLevel(def, "2026-03-14", late, "Pacific/Auckland")).toBe("alert");
    } finally {
      if (savedTz === undefined) delete process.env.TZ;
      else process.env.TZ = savedTz;
    }
  });

  it("reads only the canonical YYYY-MM-DD form the server stores, and ignores garbage", () => {
    // The server canonicalizes every date value to YYYY-MM-DD (#2218), so
    // the compact and ISO-week spellings it used to keep are no longer read.
    expect(thresholdLevel(date(), "2026-03-10", NOW, "UTC")).toBe("alert");
    expect(thresholdLevel(date(), " 2026-03-10 ", NOW, "UTC")).toBe("alert");
    expect(thresholdLevel(date(), "20260310", NOW, "UTC")).toBe("none");
    expect(thresholdLevel(date(), "2026-W11-2", NOW, "UTC")).toBe("none");
    expect(thresholdLevel(date(), "2026-3-10", NOW, "UTC")).toBe("none");
    expect(thresholdLevel(date(), "2026-02-30", NOW, "UTC")).toBe("none");
    expect(thresholdLevel(date(), "next week", NOW, "UTC")).toBe("none");
    expect(thresholdLevel(date(), "2026-03-10", NOW, "Not/AZone")).toBe("alert");
  });

  it("phrases the crossed threshold in words, with the field's number format", () => {
    const money = num({ number_prefix: "$", number_decimals: 0, threshold_warn: 5000, threshold_alert: 6000 });
    expect(thresholdPhrase(money, "alert")).toBe("Alert: at or above $6,000");
    expect(thresholdPhrase(money, "warn")).toBe("Warning: at or above $5,000");
    expect(thresholdPhrase(money, "none")).toBe("");
    expect(thresholdPhrase(num({ threshold_direction: "below", threshold_warn: 5, threshold_alert: 1 }), "warn")).toBe("Warning: at or below 5");
    expect(thresholdPhrase(date(), "alert")).toBe("Alert: today or earlier");
    expect(thresholdPhrase(date(), "warn")).toBe("Warning: 3 days from today or earlier");
    expect(thresholdPhrase(date({ threshold_direction: "above", threshold_warn_days: -1, threshold_alert_days: 1 }), "warn")).toBe("Warning: 1 day ago or later");
    expect(thresholdPhrase(num({ threshold_alert: null }), "alert")).toBe("");
  });

  it("validates a settings draft with the server's rules and builds the payload", () => {
    expect(thresholdDraftError(false, { direction: "", warn: "x", alert: "" })).toBeNull();
    expect(thresholdDraftError(false, { direction: "above", warn: "", alert: "" })).toBe("Enter a warning or an alert threshold.");
    expect(thresholdDraftError(false, { direction: "above", warn: "abc", alert: "" })).toBe("Enter a number.");
    expect(thresholdDraftError(false, { direction: "above", warn: "1e16", alert: "" })).toBe("Enter a number.");
    expect(thresholdDraftError(false, { direction: "above", warn: "5", alert: "5" })).toBe("The alert threshold must be above the warning threshold.");
    expect(thresholdDraftError(false, { direction: "below", warn: "5", alert: "6" })).toBe("The alert threshold must be below the warning threshold.");
    expect(thresholdDraftError(true, { direction: "below", warn: "1.5", alert: "" })).toMatch(/whole days/);
    expect(thresholdDraftError(true, { direction: "below", warn: "3651", alert: "" })).toMatch(/whole days/);
    expect(thresholdDraftError(true, { direction: "below", warn: "3", alert: "-1" })).toBeNull();

    expect(thresholdPayload("text", { direction: "above", warn: "1", alert: "" })).toEqual({});
    expect(thresholdPayload("number", { direction: "above", warn: "", alert: "" })).toBeNull();
    expect(thresholdPayload("number", { direction: "above", warn: " 5000 ", alert: "6000.5" })).toEqual({
      threshold_direction: "above", threshold_warn: 5000, threshold_alert: 6000.5, threshold_warn_days: null, threshold_alert_days: null,
    });
    expect(thresholdPayload("date", { direction: "below", warn: "3", alert: "0" })).toEqual({
      threshold_direction: "below", threshold_warn: null, threshold_alert: null, threshold_warn_days: 3, threshold_alert_days: 0,
    });
    // Off clears every stored value, whatever is still typed.
    expect(thresholdPayload("number", { direction: "", warn: "5", alert: "" })).toEqual({
      threshold_direction: "", threshold_warn: null, threshold_alert: null, threshold_warn_days: null, threshold_alert_days: null,
    });
    expect(thresholdDraftFrom(date())).toEqual({ direction: "below", warn: "3", alert: "0" });
    expect(thresholdDraftFrom(makeDefinition({ field_type: "number" }))).toEqual({ direction: "", warn: "", alert: "" });
  });
});
