import { describe, it, expect } from "vitest";
import { buildCsv, csvField, type AnalyticsData } from "../components/Board/flowMetrics/heatmap";

function data(name: string, col: string, dwell: number | null = 3.2): AnalyticsData {
  return {
    days: 30,
    columns: [col],
    done_columns: [],
    swimlanes: [{
      id: 1, name,
      avg_days_per_column: { [col]: dwell }, is_outlier: {},
      deal_velocity_days: null, stalled_cards: [],
    }],
  } as unknown as AnalyticsData;
}

describe("heatmap CSV fields", () => {
  it("quotes a comma", () => expect(csvField("Design, UX")).toBe('"Design, UX"'));
  it("doubles embedded quotes", () => expect(csvField('Say "hi"')).toBe('"Say ""hi"""'));
  it("quotes newlines", () => expect(csvField("a\nb")).toBe('"a\nb"'));
  it("leaves plain text alone", () => expect(csvField("Plain")).toBe("Plain"));
  it.each(["=", "+", "-", "@", "\t", "\r"])("strips leading %j like the backend", (c) => {
    expect(csvField(`${c}${c}SUM(A1)`)).toBe("SUM(A1)");
  });
  it("does not strip mid-string characters", () => expect(csvField("a=b-c")).toBe("a=b-c"));
  it("keeps numbers, including negative, unchanged", () => {
    expect(csvField(-1.5)).toBe("-1.5");
    expect(csvField(0)).toBe("0");
  });
});

describe("buildCsv", () => {
  it("keeps one column per field for a name with a comma", () => {
    const rows = buildCsv(data("Design, UX", "Todo"), "age").split("\n");
    expect(rows[1]).toBe('"Design, UX",3.2,,0');
  });
  it("escapes column names in headers", () => {
    const header = buildCsv(data("Lane", 'Q,"A"'), "age").split("\n")[0];
    expect(header).toBe('Swimlane,"Current (Q,""A"", days)",Velocity (days),Stalled cards');
  });
  it("neutralizes leading formula characters in swimlane and header names", () => {
    const csv = buildCsv(data("=Lane", "@Col"), "age");
    const [h, r] = csv.split("\n");
    // The header cell starts with the mode label, so the column name is never a leading character.
    expect(h).toBe('Swimlane,"Current (@Col, days)",Velocity (days),Stalled cards');
    expect(r.startsWith("Lane,")).toBe(true);
  });
  it("leaves a negative numeric dwell value as a number", () => {
    expect(buildCsv(data("L", "C", -1.5), "age").split("\n")[1]).toBe("L,-1.5,,0");
  });
});
