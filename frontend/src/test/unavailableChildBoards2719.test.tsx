import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import ChildCardsSettings from "../components/Board/ChildCardsSettings";
import { unavailableReasonCopy } from "../components/Card/childBoardOptionsCap";

vi.mock("../api/boards", () => ({
  getChildrenSettingBlockers: vi.fn().mockResolvedValue({ child_cards: 0, parent_cards: 0, default_of: [] }),
  getDefaultChildBoardOptions: vi.fn().mockResolvedValue({
    boards: [{ id: 7, name: "Seven" }],
    boards_total: 1,
    unavailable: [{ id: 9, name: "Child Board test", reason: "no_swimlane" }],
  }),
}));

const base = { id: 1, default_child_board: null, parent_name_singular: "", parent_name_plural: "" };

describe("unavailableReasonCopy (#2719)", () => {
  it("says what to fix for each reason, and still reads for one it does not know", () => {
    expect(unavailableReasonCopy("no_swimlane")).toBe("add a swimlane first");
    expect(unavailableReasonCopy("first_column_closed")).toBe("its first column doesn't allow new cards");
    expect(unavailableReasonCopy("no_column")).toBe("add a column first");
    expect(unavailableReasonCopy("something_new")).toBe("it can't take children yet");
  });
});

describe("ChildCardsSettings default child board select (#2719)", () => {
  it("names the boards the admin could pick once they qualify, and describes the select with them", async () => {
    render(<ChildCardsSettings board={{ ...base, cards_can_have_children: true }} onUpdate={vi.fn()} />);
    const list = await screen.findByTestId("unavailable-child-boards");
    expect(list).toHaveTextContent("Child Board test: add a swimlane first");
    const select = screen.getByRole("combobox", { name: /Default child board/ });
    expect(select.getAttribute("aria-describedby")?.split(" ")).toContain(list.id);
  });
});
