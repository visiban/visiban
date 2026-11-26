import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import CardChildrenRollup from "../components/Card/CardChildrenRollup";
import { neededNow, plannedPrefix, rollupSentence, rollupWarnings } from "../components/Card/childrenRollup";
import type { CardChildrenRollupVisible } from "../types";

// #2551 (rollup half): planned children are a dashed segment and their own count, out of "No work started" and
// "Work idle"; two row-2 warnings. Strings are the canvas v24 artboard 7 § 3 copy.
const NOW = Date.parse("2026-11-20T12:00:00Z");
const TODAY = "2026-11-20";
const ago = (days: number) => new Date(NOW - days * 86_400_000).toISOString();
const r = (over: Partial<CardChildrenRollupVisible> = {}): CardChildrenRollupVisible => ({
  visible: true, total: 6, done: 2, doing: 1, todo: 1, blocked: 0, last_moved_at: ago(1),
  planned: 2, planned_due_dates: [], needed_not_started: [], ...over,
});

describe("planned rollup helpers (#2551)", () => {
  it("neededNow drops planned children from the total only", () => {
    expect(neededNow(r())).toMatchObject({ total: 4, todo: 1, done: 2 });
    expect(neededNow(r({ planned: undefined }))).toMatchObject({ total: 6 });
  });

  it("warnings: not started per column, then the earliest passed planned date", () => {
    expect(rollupWarnings(r(), TODAY)).toEqual([]);
    expect(rollupWarnings(r({ needed_not_started: [{ column_name: "Qualify", count: 1 }] }), TODAY)[0].text)
      .toBe("Qualify: 1 child not started");
    expect(rollupWarnings(r({ needed_not_started: [{ column_name: "Proposal", count: 2 }] }), TODAY)[0].text)
      .toBe("Proposal: 2 children not started");
    const passed = rollupWarnings(r({ planned_due_dates: ["2026-11-04", "2026-11-20", "2026-12-04"] }), TODAY);
    expect(passed).toEqual([{ text: "1 planned date has passed: Nov 4", spoken: "1 planned date has passed, Nov 4" }]);
    expect(rollupWarnings(r({ planned_due_dates: ["2026-11-01", "2026-11-04"] }), TODAY)[0].text)
      .toBe("2 planned dates have passed: Nov 1");
    // Absent keys (a Children mode row) read as no warning.
    expect(rollupWarnings(r({ planned_due_dates: undefined, needed_not_started: undefined }), TODAY)).toEqual([]);
  });

  it("plannedPrefix joins the count and the movement, or stands alone", () => {
    expect(plannedPrefix(0, null)).toBeNull();
    expect(plannedPrefix(2, null)).toBe("2 planned");
    expect(plannedPrefix(2, { text: "Work moved 1d ago", spoken: "", tone: "neutral", idle: false })).toBe("2 planned · work moved 1d ago");
  });

  it("sentence counts planned on its own; a warning replaces the movement clause", () => {
    const movement = { text: "Work moved 1d ago", spoken: "work moved 1 day ago", tone: "neutral" as const, idle: false };
    expect(rollupSentence(r(), movement)).toBe("Children: 2 of 6 done, 1 doing, none blocked, 1 to do, 2 planned, work moved 1 day ago");
    const w = rollupWarnings(r({ planned: 1, todo: 2, needed_not_started: [{ column_name: "Qualify", count: 1 }] }), TODAY);
    expect(rollupSentence(r({ planned: 1, todo: 2 }), movement, w))
      .toBe("Children: 2 of 6 done, 1 doing, none blocked, 2 to do, 1 planned; Qualify: 1 child not started");
    const d = rollupWarnings(r({ planned: 1, doing: 2, planned_due_dates: ["2026-11-04"] }), TODAY);
    expect(rollupSentence(r({ planned: 1, doing: 2 }), movement, d)).toMatch(/1 planned; 1 planned date has passed, Nov 4$/);
  });
});

describe("CardChildrenRollup with planned children (#2551)", () => {
  it("draws planned children first as dashed segments and reads '2 planned · work moved'", () => {
    render(<CardChildrenRollup rollup={r()} density="comfortable" stalenessDays={14} now={NOW} today={TODAY} />);
    const segs = [...screen.getByTestId("rollup-segments").children].map((e) => e.getAttribute("data-segment"));
    expect(segs).toEqual(["planned", "planned", "todo", "doing", "done", "done"]);
    expect(screen.getByTestId("rollup-segments").firstElementChild).toHaveClass("border-dashed");
    expect(screen.getByTestId("rollup-movement")).toHaveTextContent("2 planned · work moved 1d ago");
    expect(screen.getByRole("group")).toHaveAccessibleName(
      "Children: 2 of 6 done, 1 doing, none blocked, 1 to do, 2 planned, work moved 1 day ago",
    );
  });

  it("planned work never reads as idle or not started: only the needed-now work does", () => {
    render(<CardChildrenRollup rollup={r({ done: 0, doing: 0, todo: 0, total: 2, last_moved_at: null })} density="comfortable" stalenessDays={7} now={NOW} today={TODAY} />);
    expect(screen.getByTestId("rollup-movement")).toHaveTextContent(/^2 planned$/);
    expect(screen.queryByText(/No work started|Work idle/)).toBeNull();
  });

  it("row 2 shows the warning in warning text with no glyph", () => {
    render(
      <CardChildrenRollup
        rollup={r({ planned: 1, todo: 2, needed_not_started: [{ column_name: "Qualify", count: 1 }] })}
        density="comfortable" stalenessDays={14} now={NOW} today={TODAY}
      />,
    );
    const w = screen.getByTestId("rollup-warning");
    expect(w).toHaveTextContent("Qualify: 1 child not started");
    expect(w).toHaveClass("text-warning-on-tint");
    expect(w.querySelector("svg")).toBeNull();
    expect(screen.queryByTestId("rollup-movement")).toBeNull();
  });

  it("past eight children the meter carries a planned group", () => {
    render(<CardChildrenRollup rollup={r({ total: 12, planned: 8 })} density="comfortable" stalenessDays={14} now={NOW} today={TODAY} />);
    expect(screen.getByTestId("rollup-meter").querySelector('[data-segment-group="planned"]')).toHaveClass("border-dashed");
  });

  it("uses the instance timezone's today when none is injected", () => {
    render(<CardChildrenRollup rollup={r({ planned: 1, doing: 2, planned_due_dates: ["2000-01-01"] })} density="comfortable" stalenessDays={14} now={NOW} />);
    expect(screen.getByTestId("rollup-warning")).toHaveTextContent("1 planned date has passed: Jan 1");
  });
});
