import { describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import CardChildrenRollup from "../components/Card/CardChildrenRollup";
import { movementLine, relativeAge, rollupSentence } from "../components/Card/childrenRollup";
import { carryParent } from "../hooks/useBoard";
import type { Card, CardChildrenRollupVisible } from "../types";

const NOW = Date.parse("2026-11-20T12:00:00Z");
const ago = (days: number) => new Date(NOW - days * 86_400_000).toISOString();
const r = (over: Partial<CardChildrenRollupVisible> = {}): CardChildrenRollupVisible => ({
  visible: true, total: 5, done: 2, doing: 1, todo: 1, blocked: 1, last_moved_at: ago(1), ...over,
});

describe("children rollup helpers (#2210)", () => {
  it("relativeAge uses the canvas wording", () => {
    expect(relativeAge(new Date(NOW - 60_000).toISOString(), NOW)).toBe("just now");
    expect(relativeAge(new Date(NOW - 3_600_000).toISOString(), NOW)).toBe("1 hour ago");
    expect(relativeAge(new Date(NOW - 5 * 3_600_000).toISOString(), NOW)).toBe("5 hours ago");
    expect(relativeAge(ago(1), NOW)).toBe("1 day ago");
    expect(relativeAge(ago(9), NOW)).toBe("9 days ago");
  });

  it("picks the movement case", () => {
    expect(movementLine(r(), 14, NOW)).toMatchObject({ text: "Work moved 1 day ago", tone: "neutral", idle: false });
    expect(movementLine(r({ last_moved_at: ago(9) }), 7, NOW)).toMatchObject({ text: "Work idle 9 days", tone: "warning", idle: true });
    expect(movementLine(r({ done: 5, doing: 0, todo: 0, blocked: 0 }), 7, NOW)).toMatchObject({ text: "Last work done 1 day ago", tone: "success" });
    expect(movementLine(r({ done: 5, doing: 0, todo: 0, blocked: 0, last_moved_at: null }), 7, NOW).text).toBe("All done");
    expect(movementLine(r({ done: 0, doing: 0, todo: 5, blocked: 0 }), 7, NOW).text).toBe("No work started");
    expect(movementLine(r({ last_moved_at: null }), 7, NOW).text).toBe("No work started");
  });

  it("builds the accessible sentence variants", () => {
    const m = movementLine(r(), 14, NOW);
    expect(rollupSentence(r(), m)).toBe("Children: 2 of 5 done, 1 doing, 1 blocked, 1 to do, work moved 1 day ago");
    expect(rollupSentence(r({ blocked: 0, todo: 2 }), null)).toBe("Children: 2 of 5 done, 1 doing, none blocked, 2 to do");
    expect(rollupSentence(r({ done: 0, doing: 0, todo: 0, blocked: 5 }), null)).toBe("Children: all 5 blocked");
    expect(rollupSentence(r({ done: 5, doing: 0, todo: 0, blocked: 0 }), { text: "", spoken: "last done 1 day ago", tone: "success", idle: false }))
      .toBe("Children: all 5 done, last done 1 day ago");
    expect(rollupSentence(r({ total: 0, done: 0, doing: 0, todo: 0, blocked: 0 }), null)).toBe("Children: none");
    expect(rollupSentence({ visible: false, total: 3 }, null)).toBe("Children: 3 on a board you can't open");
  });
});

describe("CardChildrenRollup (#2210)", () => {
  it("comfortable: group name, both rows, one segment per child, blocked in danger", () => {
    render(<CardChildrenRollup rollup={r()} density="comfortable" stalenessDays={14} now={NOW} />);
    const group = screen.getByRole("group", { name: /^Children: 2 of 5 done/ });
    expect(group).toHaveClass("border-t", "border-line");
    expect(group.querySelectorAll("[data-segment]")).toHaveLength(5);
    expect([...group.querySelectorAll("[data-segment]")].map((s) => s.getAttribute("data-segment")))
      .toEqual(["todo", "blocked", "doing", "done", "done"]);
    expect(screen.getByTestId("rollup-blocked")).toHaveTextContent("1 blocked");
    expect(screen.getByTestId("rollup-blocked")).toHaveClass("text-danger-on-tint");
    expect(screen.getByTestId("rollup-movement")).toHaveTextContent("Work moved 1 day ago");
    // A neutral line never uses the clock glyph.
    expect(screen.queryByTestId("rollup-clock-glyph")).toBeNull();
  });

  it("idle uses warning text plus the clock; all blocked and all done read as such", () => {
    const { rerender } = render(<CardChildrenRollup rollup={r({ last_moved_at: ago(9) })} density="comfortable" stalenessDays={7} now={NOW} />);
    expect(screen.getByTestId("rollup-movement")).toHaveClass("text-warning-on-tint");
    expect(screen.getByTestId("rollup-clock-glyph")).toBeInTheDocument();
    rerender(<CardChildrenRollup rollup={r({ done: 0, doing: 0, todo: 0, blocked: 5 })} density="comfortable" stalenessDays={7} now={NOW} />);
    expect(screen.getByTestId("rollup-blocked")).toHaveTextContent("All blocked");
    rerender(<CardChildrenRollup rollup={r({ done: 5, doing: 0, todo: 0, blocked: 0 })} density="comfortable" stalenessDays={7} now={NOW} />);
    expect(screen.getByTestId("rollup-check-glyph")).toBeInTheDocument();
    expect(screen.queryByTestId("rollup-stack-glyph")).toBeNull();
  });

  it("more than 8 children draws one meter", () => {
    render(<CardChildrenRollup rollup={r({ total: 9, done: 4, doing: 3, todo: 1, blocked: 1 })} density="comfortable" stalenessDays={14} now={NOW} />);
    expect(screen.getByTestId("rollup-meter")).toBeInTheDocument();
    expect(screen.queryByTestId("rollup-segments")).toBeNull();
  });

  it("standard keeps row 1 with a bare blocked count, or Work idle when nothing is blocked", () => {
    const { rerender } = render(<CardChildrenRollup rollup={r()} density="standard" stalenessDays={14} now={NOW} />);
    expect(screen.queryByTestId("rollup-movement")).toBeNull();
    expect(screen.getByTestId("rollup-blocked")).toHaveTextContent(/^1$/);
    rerender(<CardChildrenRollup rollup={r({ blocked: 0, todo: 2, last_moved_at: ago(9) })} density="standard" stalenessDays={7} now={NOW} />);
    expect(screen.getByText("Work idle 9 days")).toBeInTheDocument();
  });

  it("dense draws glyph and N/M with no bar; the sentence stays whole", () => {
    render(<CardChildrenRollup rollup={r()} density="dense" stalenessDays={14} now={NOW} />);
    expect(screen.getByText("2/5")).toBeInTheDocument();
    expect(screen.queryByTestId("rollup-segments")).toBeNull();
    expect(screen.getByRole("group").getAttribute("aria-label")).toMatch(/work moved 1 day ago$/);
  });

  it("hidden and empty states are one quiet line, count only", () => {
    const { rerender } = render(<CardChildrenRollup rollup={{ visible: false, total: 5 }} density="comfortable" stalenessDays={14} now={NOW} />);
    expect(screen.getByText("5 children on a board you can't open")).toHaveClass("text-fg-tertiary");
    expect(screen.queryByTestId("rollup-segments")).toBeNull();
    rerender(<CardChildrenRollup rollup={{ visible: false, total: 1 }} density="comfortable" stalenessDays={14} now={NOW} />);
    expect(screen.getByText("1 child on a board you can't open")).toBeInTheDocument();
    rerender(<CardChildrenRollup rollup={r({ total: 0, done: 0, doing: 0, todo: 0, blocked: 0 })} density="comfortable" stalenessDays={14} now={NOW} />);
    expect(screen.getByRole("group", { name: "Children: none" })).toHaveTextContent("No children");
  });

  it("a live change rings the bar for 2s and announces politely", () => {
    vi.useFakeTimers();
    try {
      const { rerender } = render(<CardChildrenRollup rollup={r()} density="comfortable" stalenessDays={14} now={NOW} />);
      expect(screen.getByTestId("rollup-live")).toHaveTextContent("");
      rerender(<CardChildrenRollup rollup={r({ done: 3, doing: 0 })} density="comfortable" stalenessDays={14} now={NOW} />);
      expect(screen.getByTestId("rollup-live")).toHaveTextContent("Children: 3 of 5 done");
      expect(screen.getByTestId("rollup-segments")).toHaveClass("ring-2");
      // A refetch with the same counts inside the window must not keep the ring on.
      act(() => { vi.advanceTimersByTime(1000); });
      rerender(<CardChildrenRollup rollup={r({ done: 3, doing: 0 })} density="comfortable" stalenessDays={14} now={NOW + 1000} />);
      act(() => { vi.advanceTimersByTime(1000); });
      expect(screen.getByTestId("rollup-segments")).not.toHaveClass("ring-2");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("carryParent keeps children_rollup across a wholesale replace (#2210)", () => {
  it("carries the last read and lets a newer read win", () => {
    const prev = { id: 1, children_rollup: r() } as unknown as Card;
    expect(carryParent({ id: 1 } as unknown as Card, prev).children_rollup).toBe(prev.children_rollup);
    const fresh = { visible: false as const, total: 2 };
    expect(carryParent({ id: 1, children_rollup: fresh } as unknown as Card, prev).children_rollup).toBe(fresh);
  });
});
