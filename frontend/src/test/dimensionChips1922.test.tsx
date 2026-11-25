import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { DimensionChips } from "../components/Card/TrackChips";
import { attentionText, dimensionsNeedingAttention, pinnedDimensionStates, DIMENSION_PIN_CAP } from "../utils/dimensionChips";
import type { Card, CustomFieldDefinition } from "../types";

const def = (id: number, name: string, extra: Partial<CustomFieldDefinition> = {}) => ({
  id, name, field_type: "dropdown", choices: ["Pending", "Approved", "Waived"], position: id,
  is_dimension: true, show_on_card: true,
  choice_resolutions: { Approved: "satisfied", Waived: "not_applicable" }, ...extra,
}) as unknown as CustomFieldDefinition;

const card = (values: Record<number, string>, plans: Card["dimension_plans"] = []) => ({
  custom_field_values: Object.entries(values).map(([k, v]) => ({ field_definition: Number(k), value: v })),
  dimension_plans: plans,
}) as unknown as Card;

const plan = (field_id: number, target_date: string | null) => ({ field_id, owner: null, next_action: "", target_date, updated_at: "" });

describe("pinnedDimensionStates (#1922)", () => {
  it("maps values to states, skips unpinned, non-dimension and track fields, and caps at 3", () => {
    const defs = [
      def(1, "Security"), def(2, "Budget"), def(3, "Legal"), def(4, "Tech"), def(5, "Ops"),
      def(6, "Hidden", { show_on_card: false }), def(7, "Plain", { is_dimension: false }),
    ];
    const states = pinnedDimensionStates(card({ 1: "Approved", 3: "Waived", 4: "Unknown" }), defs, [{ id: 2 }]);
    expect(states.map((s) => [s.name, s.state])).toEqual([["Security", "done"], ["Legal", "not_applicable"], ["Tech", "open"]]);
    expect(states).toHaveLength(DIMENSION_PIN_CAP);
  });
});

describe("dimensionsNeedingAttention (#1922)", () => {
  const defs = [def(1, "Security"), def(2, "Budget", { show_on_card: false }), def(3, "Legal")];
  it("counts open dimensions past their target date, pinned or not", () => {
    const c = card({ 3: "Approved" }, [plan(1, "2026-11-01"), plan(2, "2026-11-20"), plan(3, "2026-11-01")]);
    expect(dimensionsNeedingAttention(c, defs, "2026-11-25")).toEqual(["Security", "Budget"]);
  });
  it("never counts a dimension with no target date, or one due today or later", () => {
    const c = card({}, [plan(1, null), plan(3, "2026-11-25")]);
    expect(dimensionsNeedingAttention(c, defs, "2026-11-25")).toEqual([]);
    expect(dimensionsNeedingAttention({ custom_field_values: [] } as unknown as Card, defs, "2026-11-25")).toEqual([]);
  });
  it("words the count", () => {
    expect(attentionText(0)).toBe("");
    expect(attentionText(1)).toBe("1 needs attention");
    expect(attentionText(2)).toBe("2 need attention");
  });
});

describe("DimensionChips (#1922)", () => {
  it("spells out each state for screen readers and the tooltip, never color alone", () => {
    render(<DimensionChips dimensions={[{ id: 1, name: "Security", state: "open", fromLane: false }, { id: 2, name: "Budget", state: "done", fromLane: false }, { id: 3, name: "Legal", state: "not_applicable", fromLane: false }]} attention={[]} />);
    expect(screen.getByText("Security: open")).toHaveClass("sr-only");
    expect(screen.getByText("Budget: done").closest("li")).toHaveAttribute("title", "Budget: done. Set in the card's Custom fields.");
    expect(screen.getByText("Legal: not applicable").closest("li")).toHaveAttribute("data-dimension-state", "not_applicable");
    expect(screen.queryByTestId("card-dimension-attention")).not.toBeInTheDocument();
  });
  it("shows the attention count with words and names the dimensions in its tooltip", () => {
    render(<DimensionChips dimensions={[]} attention={["Security", "Budget"]} spelledOut />);
    const item = screen.getByTestId("card-dimension-attention");
    expect(item).toHaveTextContent("2 need attention");
    expect(item).toHaveAttribute("title", "Open dimensions past their target date: Security, Budget");
  });
  it("renders nothing with no pinned dimension and no attention", () => {
    const { container } = render(<DimensionChips dimensions={[]} attention={[]} />);
    expect(container).toBeEmptyDOMElement();
  });
  it("prints the state at phone width", () => {
    render(<DimensionChips dimensions={[{ id: 1, name: "Security", state: "open", fromLane: false }]} attention={[]} spelledOut />);
    expect(screen.getAllByText("Security: open")).toHaveLength(2);
  });
});
