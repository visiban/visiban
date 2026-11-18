import { describe, it, expect, vi } from "vitest";
import { render, screen, within, fireEvent } from "@testing-library/react";
import LaneFieldGrid from "../components/Board/LaneFieldGrid";
import CustomFieldValueDisplay from "../components/Card/CustomFieldValueDisplay";
import { laneGridFields } from "../utils/laneBand";
import type { Swimlane, SwimlaneCustomFieldDefinition } from "../types";

const def = (id: number, name: string, extra: Record<string, unknown> = {}) =>
  ({ id, uid: `sf${id}`, name, field_type: "text", choices: [], position: id, show_on_row: false, is_admin_only: false, choice_colors: {}, ...extra }) as unknown as SwimlaneCustomFieldDefinition;
const lane = (values: [number, string][]) =>
  ({ id: 1, name: "North", custom_field_values: values.map(([field_definition, value]) => ({ field_definition, value })) }) as unknown as Swimlane;

describe("laneGridFields (#2354)", () => {
  it("returns every definition in position order with empty values for unset fields", () => {
    const out = laneGridFields(lane([[2, "b"]]), [def(3, "C"), def(1, "A"), def(2, "B")], true);
    expect(out.map((f) => [f.def.name, f.value])).toEqual([["A", ""], ["B", "b"], ["C", ""]]);
  });
  it("is empty without definitions", () => {
    expect(laneGridFields(lane([]), undefined, true)).toEqual([]);
  });
});

describe("LaneFieldGrid (#2354)", () => {
  it("renders a labeled dl with a fixed label column and a tinted divider", () => {
    render(<LaneFieldGrid id="g1" laneName="North" laneColor="#ff0000" fields={laneGridFields(lane([[1, "x"]]), [def(1, "Owner")], true)} />);
    const grid = screen.getByTestId("swimlane-field-grid");
    expect(grid).not.toHaveAttribute("aria-label");
    expect(grid.style.borderColor).toContain("color-mix");
    expect(grid.className).toContain("grid-cols-[repeat(auto-fill,minmax(18rem,1fr))]");
  });

  it("does not let a double-click on the grid bubble to the band (it would open Edit swimlane)", () => {
    const onBand = vi.fn();
    render(<div onDoubleClick={onBand}><LaneFieldGrid id="g1" laneName="North" laneColor={null} fields={laneGridFields(lane([[1, "x"]]), [def(1, "Owner")], true)} /></div>);
    fireEvent.doubleClick(screen.getByText("Owner"));
    expect(onBand).not.toHaveBeenCalled();
  });

  it("renders every multi-select chip unclamped and titles clamped text and URLs", () => {
    const choices = Array.from({ length: 12 }, (_, i) => `choice-${i}`);
    const fields = laneGridFields(
      lane([[1, JSON.stringify(choices)], [2, "https://example.com/a/very/long/path"], [3, "plain text value"]]),
      [def(1, "Tags", { field_type: "multi_select", choices }), def(2, "Link", { field_type: "url" }), def(3, "Note")],
      true,
    );
    render(<LaneFieldGrid id="g1" fields={fields} />);
    const dds = screen.getByTestId("swimlane-field-grid").querySelectorAll("dd");
    expect(dds[0]).not.toHaveClass("line-clamp-2");
    for (const c of choices) expect(within(dds[0] as HTMLElement).getByText(c)).toBeInTheDocument();
    expect(dds[1]).toHaveClass("line-clamp-2");
    expect(dds[1].querySelector("[title]")).toHaveAttribute("title", "https://example.com/a/very/long/path");
    expect(dds[2].querySelector("[title]")).toHaveAttribute("title", "plain text value");
  });

  it("uses a plain border-line without a lane color", () => {
    render(<LaneFieldGrid id="g1" laneName="North" fields={[]} />);
    const grid = screen.getByTestId("swimlane-field-grid");
    expect(grid).toHaveClass("border-line");
    expect(grid.getAttribute("style")).toBeNull();
    expect(grid.id).toBe("g1");
  });

  it("shows the tinted border when the lane has a color", () => {
    render(<LaneFieldGrid id="g1" laneName="North" laneColor="#ff0000" fields={[]} />);
    expect(screen.getByTestId("swimlane-field-grid")).not.toHaveClass("border-line");
  });

  it("renders label, value, dash and admin-only glyph per row", () => {
    const defs = [def(1, "Owner"), def(2, "ARR", { is_admin_only: true }), def(3, "Site", { field_type: "url" })];
    render(<LaneFieldGrid id="g" laneName="North" fields={laneGridFields(lane([[1, "Avery"], [3, "https://example.com/a"]]), defs, true)} />);
    const grid = screen.getByTestId("swimlane-field-grid");
    const terms = within(grid).getAllByRole("term");
    expect(terms.map((t) => t.textContent)).toEqual(["Owner", "ARR", "Site"]);
    expect(within(terms[1]).getByLabelText("Admin-only field")).toBeInTheDocument();
    expect(terms[0]).toHaveClass("w-36");
    expect(within(grid).getByText("Avery")).toBeInTheDocument();
    expect(within(grid).getByText("Not set")).toHaveClass("sr-only");
    expect(within(grid).getByRole("link")).toHaveAttribute("href", "https://example.com/a");
  });
});

describe('CustomFieldValueDisplay variant="grid-value" (#2354)', () => {
  const shape = (extra: Record<string, unknown> = {}) => def(1, "F", extra);
  const dd = (d: SwimlaneCustomFieldDefinition, value: string | undefined) =>
    render(<CustomFieldValueDisplay definition={d} value={value} variant="grid-value" />).container;

  it("renders the value only, with no label", () => {
    const c = dd(shape(), "hello");
    expect(c).toHaveTextContent("hello");
    expect(c).not.toHaveTextContent("F");
  });
  it.each([undefined, ""])("renders a dash plus sr-only Not set for %s", (v) => {
    const c = dd(shape(), v);
    expect(c.querySelector('[aria-hidden="true"]')).toHaveTextContent("—");
    expect(c.querySelector(".sr-only")).toHaveTextContent("Not set");
  });
  it("renders an empty multi-select as unset", () => {
    const c = dd(shape({ field_type: "multi_select", choices: ["a", "b"] }), "[]");
    expect(c.querySelector(".sr-only")).toHaveTextContent("Not set");
  });
  it("renders multi-select values as chips", () => {
    const c = dd(shape({ field_type: "multi_select", choices: ["a", "b"] }), '["a","b"]');
    expect(c).toHaveTextContent("a");
    expect(c).toHaveTextContent("b");
  });
  it("renders a colored dropdown choice as a badge", () => {
    const c = dd(shape({ field_type: "dropdown", choices: ["High"], choice_colors: { High: "red" } }), "High");
    expect(c).toHaveTextContent("High");
  });
  it("renders a plain dropdown choice with its dot", () => {
    const c = dd(shape({ field_type: "dropdown", choices: ["Low"] }), "Low");
    expect(c).toHaveTextContent("Low");
  });
  it("renders an invalid value as plain text", () => {
    const c = dd(shape({ field_type: "number" }), "abc");
    expect(c).toHaveTextContent("abc");
  });
  it("renders a url as a link", () => {
    render(<CustomFieldValueDisplay definition={shape({ field_type: "url" })} value="https://example.com" variant="grid-value" />);
    expect(screen.getByRole("link")).toBeInTheDocument();
  });

  it("drops admin-only definitions for a non-admin and keeps them for an admin", () => {
    const defs = [def(1, "Owner"), def(2, "ARR", { is_admin_only: true })];
    expect(laneGridFields(lane([[2, "9"]]), defs, false).map((f) => f.def.name)).toEqual(["Owner"]);
    expect(laneGridFields(lane([[2, "9"]]), defs, true).map((f) => f.def.name)).toEqual(["Owner", "ARR"]);
  });
});
