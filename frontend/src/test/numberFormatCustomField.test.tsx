import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, act, cleanup } from "@testing-library/react";
import CustomFieldValueInput from "../components/Card/CustomFieldValueInput";
import CustomFieldValueDisplay from "../components/Card/CustomFieldValueDisplay";
import {
  chipValueText, formatCustomFieldValue, formatNumberValue, numberFormatPayload, parseDecimalsInput,
} from "../utils/customFieldValue";
import type { FieldDefinitionShape } from "../types";

/**
 * #1391 (MR B) — display-only number formatting: the formatting util, the
 * renderer call sites that share it, and the adorned value editor.
 */

function numDef(overrides: Partial<FieldDefinitionShape> = {}): FieldDefinitionShape {
  return {
    name: "Budget", field_type: "number", choices: [], help_text: "",
    number_prefix: "", number_suffix: "", number_decimals: null,
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("formatNumberValue", () => {
  it("returns the raw text unchanged when every option is at its default", () => {
    for (const raw of ["1234.5", "1234567", "-5", "1e3", "0.10", " 42 "]) {
      expect(formatNumberValue(raw, {})).toBe(raw);
      expect(formatNumberValue(raw, { prefix: "", suffix: "", decimals: null })).toBe(raw);
    }
  });

  it("keeps the number as typed (no grouping) when decimals is null", () => {
    expect(formatNumberValue("1234.5", { prefix: "$" })).toBe("$1234.5");
    expect(formatNumberValue("1e3", { suffix: " h" })).toBe("1e3 h");
  });

  it("fixes decimals and adds grouping when decimals is set", () => {
    expect(formatNumberValue("1234.5", { decimals: 2 })).toBe("1,234.50");
    expect(formatNumberValue("1234.5", { decimals: 0 })).toBe("1,235");
    expect(formatNumberValue("0.1", { decimals: 10 })).toBe("0.1000000000");
    expect(formatNumberValue("1e3", { decimals: 0 })).toBe("1,000");
  });

  it("adds prefix and suffix verbatim, spaces included", () => {
    expect(formatNumberValue("5", { prefix: "$ ", suffix: " USD", decimals: 2 })).toBe("$ 5.00 USD");
    expect(formatNumberValue("8", { suffix: " h" })).toBe("8 h");
  });

  it("puts the minus sign before the prefix", () => {
    expect(formatNumberValue("-5", { prefix: "$", decimals: 2 })).toBe("-$5.00");
    expect(formatNumberValue("-5", { prefix: "$" })).toBe("-$5");
    expect(formatNumberValue("-1234.5", { prefix: "€", suffix: "k", decimals: 1 })).toBe("-€1,234.5k");
  });

  it("drops the sign when a negative value rounds to zero", () => {
    expect(formatNumberValue("-0.001", { prefix: "$", decimals: 2 })).toBe("$0.00");
  });

  it("formats a huge number without throwing", () => {
    expect(formatNumberValue("123456789012", { decimals: 2 })).toBe("123,456,789,012.00");
    expect(formatNumberValue("1e21", { decimals: 0 })).toBe("1,000,000,000,000,000,000,000");
  });

  it("passes a non-numeric or empty stored value through untouched", () => {
    expect(formatNumberValue("abc", { prefix: "$", decimals: 2 })).toBe("abc");
    expect(formatNumberValue("Infinity", { prefix: "$", decimals: 2 })).toBe("Infinity");
    expect(formatNumberValue("", { prefix: "$", decimals: 2 })).toBe("");
  });
});

describe("parseDecimalsInput", () => {
  it("maps empty to null and 0-10 to themselves", () => {
    expect(parseDecimalsInput("")).toBeNull();
    expect(parseDecimalsInput("  ")).toBeNull();
    expect(parseDecimalsInput("0")).toBe(0);
    expect(parseDecimalsInput("10")).toBe(10);
  });

  it("rejects anything else", () => {
    for (const bad of ["-1", "11", "2.5", "abc", "1e1"]) {
      expect(parseDecimalsInput(bad)).toBeUndefined();
    }
  });
});

describe("numberFormatPayload", () => {
  it("omits the keys for a non-number type", () => {
    expect(numberFormatPayload(false, { number_prefix: "$", number_suffix: "", number_decimals: "2" })).toEqual({});
  });

  it("returns null for invalid decimals and the parsed options otherwise", () => {
    expect(numberFormatPayload(true, { number_prefix: "", number_suffix: "", number_decimals: "11" })).toBeNull();
    expect(numberFormatPayload(true, { number_prefix: "$", number_suffix: " h", number_decimals: "" })).toEqual({
      number_prefix: "$", number_suffix: " h", number_decimals: null,
    });
  });
});

describe("number display call sites", () => {
  it("formatCustomFieldValue applies the definition's format (peek popover, filter chip)", () => {
    expect(formatCustomFieldValue(numDef({ number_prefix: "$", number_decimals: 2 }), "1234.5", "MM/DD/YYYY")).toBe("$1,234.50");
    expect(formatCustomFieldValue(numDef(), "1234.5", "MM/DD/YYYY")).toBe("1234.5");
  });

  it("a definition without the format keys at all renders as typed", () => {
    const legacy: FieldDefinitionShape = { name: "Budget", field_type: "number", choices: [], help_text: "" };
    expect(formatCustomFieldValue(legacy, "1234.5", "MM/DD/YYYY")).toBe("1234.5");
  });

  it("the card-face chip shows the formatted value", () => {
    render(<CustomFieldValueDisplay definition={numDef({ number_prefix: "$", number_decimals: 2 })} value="1234.5" variant="chip" />);
    expect(screen.getByText("$1,234.50")).toBeInTheDocument();
    expect(screen.getByTitle("Budget: $1,234.50")).toBeInTheDocument();
  });

  it("the swimlane row chip shows the formatted value", () => {
    render(<CustomFieldValueDisplay definition={numDef({ number_suffix: " h" })} value="8" variant="row-chip" />);
    expect(screen.getByText("8 h")).toBeInTheDocument();
  });

  it("the card-detail read view shows the formatted value", () => {
    render(<CustomFieldValueDisplay definition={numDef({ number_decimals: 1 })} value="-2" variant="detail" />);
    expect(screen.getByText("-2.0")).toBeInTheDocument();
  });

  it("chipValueText leaves a formatted number whole and slices everything else", () => {
    const long = "$1,234,567.50 USD";
    expect(chipValueText(numDef({ number_suffix: " USD" }), long, 16)).toBe(long);
    expect(chipValueText(numDef({ number_decimals: 0 }), "12345678901234567890", 16)).toBe("12345678901234567890");
    expect(chipValueText(numDef(), "12345678901234567890", 16)).toBe("1234567890123456…");
    expect(chipValueText({ ...numDef(), field_type: "text", number_suffix: " USD" }, "abcdefghijklmnopq", 16)).toBe("abcdefghijklmnop…");
  });

  it("the row chip keeps a formatted value whole past 20 characters", () => {
    render(<CustomFieldValueDisplay definition={numDef({ number_prefix: "$", number_suffix: " USD", number_decimals: 2 })} value="1234567890" variant="row-chip" />);
    expect(screen.getByText("$1,234,567,890.00 USD")).toBeInTheDocument();
  });

  it("an orphaned non-numeric value still renders raw", () => {
    render(<CustomFieldValueDisplay definition={numDef({ number_prefix: "$", number_decimals: 2 })} value="lots" variant="detail" />);
    expect(screen.getByText("lots")).toBeInTheDocument();
  });
});

describe("number value editor adornments", () => {
  it("renders exactly the plain input when there is no prefix or suffix", () => {
    const { container } = render(<CustomFieldValueInput definition={numDef({ number_decimals: 2 })} value="5" onCommit={vi.fn()} />);
    const input = screen.getByRole("spinbutton");
    expect(input.parentElement).toBe(container);
    expect(input).not.toHaveAttribute("aria-label");
    expect(input.className).toContain("border-line");
  });

  it("shows prefix and suffix as aria-hidden adornments and names the unit in the label", () => {
    render(<CustomFieldValueInput definition={numDef({ number_prefix: "$", number_suffix: " USD" })} value="5" onCommit={vi.fn()} />);
    const input = screen.getByRole("spinbutton", { name: "Budget ($ USD)" });
    expect(input).toHaveValue(5);
    const prefix = screen.getByText("$");
    const suffix = screen.getByText("USD", { exact: false });
    expect(prefix).toHaveAttribute("aria-hidden", "true");
    expect(suffix).toHaveAttribute("aria-hidden", "true");
    expect(prefix.className).toContain("select-none");
    const wrapper = input.parentElement!;
    expect(wrapper.className).toContain("focus-within:ring-2");
    expect(wrapper.className).toContain("bg-surface");
  });

  it("does not squeeze the input with a 10-character prefix and suffix at size sm", () => {
    render(<CustomFieldValueInput definition={numDef({ number_prefix: "ABCDEFGHIJ", number_suffix: "KLMNOPQRST" })} value="5" size="sm" onCommit={vi.fn()} />);
    const input = screen.getByRole("spinbutton", { name: "Budget (ABCDEFGHIJ KLMNOPQRST)" });
    expect(input.className).toContain("min-w-[4rem]");
    expect(input.className).toContain("w-20");
    const wrapper = input.parentElement!;
    expect(wrapper.className).toContain("w-auto");
    expect(wrapper.className).toContain("min-w-28");
    expect(wrapper.className).not.toMatch(/(^|\s)w-(28|40)(\s|$)/);
    expect(screen.getByText("ABCDEFGHIJ").className).toContain("shrink-0");
    expect(screen.getByText("KLMNOPQRST").className).toContain("shrink-0");
  });

  it("still commits the raw number, debounced", () => {
    vi.useFakeTimers();
    const onCommit = vi.fn();
    render(<CustomFieldValueInput definition={numDef({ number_suffix: "h" })} value="" onCommit={onCommit} />);
    fireEvent.change(screen.getByRole("spinbutton", { name: "Budget (h)" }), { target: { value: "42" } });
    expect(onCommit).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(600); });
    expect(onCommit).toHaveBeenCalledWith("42");
  });
});
