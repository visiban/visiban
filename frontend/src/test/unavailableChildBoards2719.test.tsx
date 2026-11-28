import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import ChildCardsSettings from "../components/Board/ChildCardsSettings";
import { unavailableOption, unavailableReasonCopy } from "../components/Card/childBoardOptionsCap";
import { getDefaultChildBoardOptions } from "../api/boards";

vi.mock("../api/boards", () => ({
  getChildrenSettingBlockers: vi.fn().mockResolvedValue({ child_cards: 0, parent_cards: 0, default_of: [] }),
  getDefaultChildBoardOptions: vi.fn(),
}));

const OPTIONS = {
  boards: [{ id: 7, name: "Seven" }],
  boards_total: 1,
  unavailable: [{ id: 9, name: "Child Board test", reason: "no_swimlane" as const }],
};

const base = { id: 1, default_child_board: null, parent_name_singular: "", parent_name_plural: "" };

beforeEach(() => {
  vi.mocked(getDefaultChildBoardOptions).mockReset().mockResolvedValue(OPTIONS);
});

describe("unavailableReasonCopy / unavailableOption (#2719)", () => {
  it("says what to fix for each reason, and still reads for one it does not know", () => {
    expect(unavailableReasonCopy("no_swimlane")).toBe("add a swimlane first");
    expect(unavailableReasonCopy("first_column_closed")).toBe("its first column doesn't allow new cards");
    expect(unavailableReasonCopy("no_column")).toBe("add a column first");
    expect(unavailableReasonCopy("something_new")).toBe("it can't take children yet");
  });

  it("makes a disabled select option whose description starts with a capital", () => {
    expect(unavailableOption({ id: 9, name: "Child Board test", reason: "no_swimlane" })).toEqual({
      value: "9", label: "Child Board test", disabled: true, description: "Add a swimlane first",
    });
  });
});

describe("ChildCardsSettings default child board select (#2719)", () => {
  it("offers the boards the admin could pick once they qualify as disabled options, after the selectable ones", async () => {
    const user = userEvent.setup();
    render(<ChildCardsSettings board={{ ...base, cards_can_have_children: true }} onUpdate={vi.fn()} />);
    const select = screen.getByRole("combobox", { name: /Default child board/ });
    await waitFor(() => expect(select.getAttribute("aria-describedby")?.split(" ")).toHaveLength(2));
    // No list beside the select any more: the reasons are in it and in its description.
    expect(screen.queryByTestId("unavailable-child-boards")).toBeNull();
    const summaryId = select.getAttribute("aria-describedby")!.split(" ")[1];
    expect(document.getElementById(summaryId)).toHaveTextContent("Unavailable: Child Board test (Add a swimlane first).");
    await user.click(select);
    expect(screen.getAllByRole("option").map((o) => o.getAttribute("aria-disabled"))).toEqual([null, null, "true"]);
    const child = screen.getByRole("option", { name: "Child Board test" });
    expect(child).toHaveAccessibleDescription("Add a swimlane first");
  });

  it("keeps a current default that no longer qualifies selectable, by name, as the current default", async () => {
    const user = userEvent.setup();
    render(<ChildCardsSettings board={{ ...base, default_child_board: 9, cards_can_have_children: true }} onUpdate={vi.fn()} />);
    const select = screen.getByRole("combobox", { name: /Default child board/ });
    await waitFor(() => expect(select).toHaveTextContent("Child Board test"));
    await user.click(select);
    const current = screen.getByRole("option", { name: "Child Board test" });
    expect(current).not.toHaveAttribute("aria-disabled");
    expect(current).toHaveAttribute("aria-selected", "true");
    expect(current).toHaveAccessibleDescription("Current default");
    expect(screen.getAllByRole("option", { name: "Child Board test" })).toHaveLength(1);
  });

  it("a failed options read shows no unavailable boards", async () => {
    vi.mocked(getDefaultChildBoardOptions).mockReset().mockRejectedValue(new Error("down"));
    const user = userEvent.setup();
    render(<ChildCardsSettings board={{ ...base, cards_can_have_children: true }} onUpdate={vi.fn()} />);
    await waitFor(() => expect(getDefaultChildBoardOptions).toHaveBeenCalled());
    const select = screen.getByRole("combobox", { name: /Default child board/ });
    await user.click(select);
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual(["None (ask each time)"]);
    expect(select.getAttribute("aria-describedby")?.split(" ")).toHaveLength(1);
  });
});
