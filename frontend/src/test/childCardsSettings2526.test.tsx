import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import ChildCardsSettings from "../components/Board/ChildCardsSettings";

vi.mock("../api/boards", () => ({
  getChildrenSettingBlockers: vi.fn().mockResolvedValue({ child_cards: 0, parent_cards: 0, default_of: [] }),
  getDefaultChildBoardOptions: vi.fn().mockResolvedValue([{ id: 7, name: "Seven" }]),
}));

const base = { id: 1, default_child_board: null, parent_name_singular: "", parent_name_plural: "" };

// #2526: onUpdate may return a promise; a rejection must not escape as an unhandled rejection.
describe("ChildCardsSettings onUpdate handling (#2526)", () => {
  it("passes the toggle patch to onUpdate and swallows a rejection", async () => {
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    const onUpdate = vi.fn().mockRejectedValue(new Error("boom"));
    render(<ChildCardsSettings board={{ ...base, cards_can_have_children: false }} onUpdate={onUpdate} />);
    const toggle = await screen.findByRole("switch");
    await userEvent.setup().click(toggle);
    expect(onUpdate).toHaveBeenCalledWith({ cards_can_have_children: true });
    await new Promise((r) => setTimeout(r, 20));
    expect(unhandled).not.toHaveBeenCalled();
    process.off("unhandledRejection", unhandled);
  });

  it("saves the default child board through the same guarded path", async () => {
    const onUpdate = vi.fn().mockRejectedValue(new Error("boom"));
    const user = userEvent.setup();
    render(<ChildCardsSettings board={{ ...base, cards_can_have_children: true }} onUpdate={onUpdate} />);
    await user.click((await screen.findAllByRole("combobox"))[0]);
    await user.click(await screen.findByRole("option", { name: "Seven" }));
    expect(onUpdate).toHaveBeenCalledWith({ default_child_board: 7 });
  });
});
