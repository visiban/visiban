import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import ChildCardsSettings from "../components/Board/ChildCardsSettings";
import { turnOffBody } from "../components/Board/childCardsTurnOff";
import { getChildrenSettingBlockers } from "../api/boards";
import { announced } from "./confirmAnnouncer";

vi.mock("../api/boards", () => ({
  getChildrenSettingBlockers: vi.fn(),
  getDefaultChildBoardOptions: vi.fn().mockResolvedValue({ boards: [], boards_total: 0 }),
}));

const board = { id: 1, name: "Pipeline", cards_can_have_children: true, default_child_board: null, parent_name_singular: "", parent_name_plural: "" };

// #2446: turning Child cards off with live parent links asks first (#2208 spec, canvas 2f c); it is no longer refused.
describe("ChildCardsSettings turn-off confirm (#2446)", () => {
  beforeEach(() => {
    vi.mocked(getChildrenSettingBlockers).mockResolvedValue({ child_cards: 0, parent_cards: 9, default_of: [] });
  });

  async function open(onUpdate = vi.fn().mockResolvedValue(null)) {
    const user = userEvent.setup();
    render(<ChildCardsSettings board={board} onUpdate={onUpdate} />);
    const sw = await screen.findByRole("switch");
    await waitFor(() => expect(getChildrenSettingBlockers).toHaveBeenCalled());
    await screen.findByTestId("children-status");
    return { user, sw, onUpdate };
  }

  it("is not a blocked state: the switch is enabled and has no reasons", async () => {
    const { sw } = await open();
    expect(sw).not.toHaveAttribute("aria-disabled");
    expect(screen.getByTestId("children-status")).toHaveTextContent(/^On\.$/);
    expect(screen.queryByText(/Can't be turned off/)).toBeNull();
  });

  it("opens the confirm with the spec copy, button order, focus on Turn off and the shared announcement", async () => {
    const { user, sw, onUpdate } = await open();
    await new Promise((r) => setTimeout(r, 0));
    await user.click(sw);
    const group = await screen.findByRole("group", { name: "Turn off children on Pipeline?" });
    expect(group).toHaveTextContent(turnOffBody(9));
    expect(group).toHaveTextContent("9 cards here have children. They keep them and stay linked, and the tab and rollup stay on those 9 cards. The 9 can still Add child; no other card can get children.");
    const buttons = Array.from(group.querySelectorAll("button")).map((b) => b.textContent);
    expect(buttons).toEqual(["Keep it on", "Turn off"]);
    expect(screen.getByRole("button", { name: "Turn off" })).toHaveFocus();
    expect(announced()).toContain("Turn off children on Pipeline?");
    expect(onUpdate).not.toHaveBeenCalled();
    // The switch stays mounted while the confirm is open.
    expect(sw).toBeInTheDocument();
  });

  it("Turn off saves the flip, closes, and returns focus to the switch", async () => {
    const { user, sw, onUpdate } = await open();
    await new Promise((r) => setTimeout(r, 0));
    await user.click(sw);
    await user.click(await screen.findByRole("button", { name: "Turn off" }));
    expect(onUpdate).toHaveBeenCalledWith({ cards_can_have_children: false });
    await waitFor(() => expect(screen.queryByTestId("children-off-confirm")).toBeNull());
    expect(sw).toHaveFocus();
  });

  it("Keep it on cancels without saving and returns focus to the switch", async () => {
    const { user, sw, onUpdate } = await open();
    await new Promise((r) => setTimeout(r, 0));
    await user.click(sw);
    await user.click(await screen.findByRole("button", { name: "Keep it on" }));
    expect(screen.queryByTestId("children-off-confirm")).toBeNull();
    expect(onUpdate).not.toHaveBeenCalled();
    expect(sw).toHaveFocus();
    expect(announced()).toBe("");
  });

  it("Escape cancels and returns focus to the switch, and is ignored while the request runs", async () => {
    let resolve: (v: unknown) => void = () => undefined;
    const onUpdate = vi.fn().mockImplementation(() => new Promise((r) => { resolve = r; }));
    const { user, sw } = await open(onUpdate);
    await new Promise((r) => setTimeout(r, 0));
    await user.click(sw);
    await screen.findByTestId("children-off-confirm");
    await user.keyboard("{Escape}");
    expect(screen.queryByTestId("children-off-confirm")).toBeNull();
    expect(sw).toHaveFocus();

    await user.click(sw);
    await user.click(await screen.findByRole("button", { name: "Turn off" }));
    expect(screen.getByRole("button", { name: "Turning off…" })).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByRole("button", { name: "Keep it on" })).toHaveAttribute("aria-disabled", "true");
    expect(sw).toHaveAttribute("aria-disabled", "true");
    await user.keyboard("{Escape}");
    expect(screen.getByTestId("children-off-confirm")).toBeInTheDocument();
    // A second click while running does not save twice; Keep it on is inert too.
    await user.click(screen.getByRole("button", { name: "Turning off…" }));
    await user.click(screen.getByRole("button", { name: "Keep it on" }));
    expect(onUpdate).toHaveBeenCalledTimes(1);
    resolve(null);
    await waitFor(() => expect(screen.queryByTestId("children-off-confirm")).toBeNull());
    expect(sw).not.toHaveAttribute("aria-disabled");
  });

  it("a refused save closes the confirm, shows the section error and returns focus to the switch", async () => {
    // BoardSettingsModal's onUpdate resolves after setting the section error (flipChildCards); it never rejects.
    function Harness() {
      const [error, setError] = useState<string | null>(null);
      return (
        <ChildCardsSettings
          board={board}
          error={error}
          onUpdate={async () => { setError("Failed to change the Child cards setting. Please try again."); return null; }}
        />
      );
    }
    const user = userEvent.setup();
    render(<Harness />);
    const sw = await screen.findByRole("switch");
    await waitFor(() => expect(getChildrenSettingBlockers).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 0));
    await user.click(sw);
    await user.click(await screen.findByRole("button", { name: "Turn off" }));
    await waitFor(() => expect(screen.queryByTestId("children-off-confirm")).toBeNull());
    expect(screen.getByTestId("children-error")).toHaveTextContent("Failed to change the Child cards setting. Please try again.");
    expect(sw).toHaveFocus();
    expect(sw).toHaveAttribute("aria-checked", "true");
    expect(sw).not.toHaveAttribute("aria-disabled");
  });

  it("swallows a rejected save and still closes", async () => {
    const { user, sw } = await open(vi.fn().mockRejectedValue(new Error("boom")));
    await new Promise((r) => setTimeout(r, 0));
    await user.click(sw);
    await user.click(await screen.findByRole("button", { name: "Turn off" }));
    await waitFor(() => expect(screen.queryByTestId("children-off-confirm")).toBeNull());
  });

  it("with 0 parent links there is no confirm: the flip saves at once", async () => {
    vi.mocked(getChildrenSettingBlockers).mockResolvedValue({ child_cards: 0, parent_cards: 0, default_of: [] });
    const { user, sw, onUpdate } = await open();
    await new Promise((r) => setTimeout(r, 0));
    await user.click(sw);
    expect(onUpdate).toHaveBeenCalledWith({ cards_can_have_children: false });
    expect(screen.queryByTestId("children-off-confirm")).toBeNull();
  });

  it.each([
    ["pending", () => new Promise<never>(() => undefined)],
    ["failed", () => Promise.reject(new Error("down"))],
  ])("with the blockers read %s, a click asks first with count-free copy instead of saving", async (_state, impl) => {
    vi.mocked(getChildrenSettingBlockers).mockImplementation(impl as () => Promise<never>);
    const onUpdate = vi.fn().mockResolvedValue(null);
    const user = userEvent.setup();
    render(<ChildCardsSettings board={board} onUpdate={onUpdate} />);
    const sw = await screen.findByRole("switch");
    await waitFor(() => expect(getChildrenSettingBlockers).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 0));
    await user.click(sw);
    const group = await screen.findByRole("group", { name: "Turn off children on Pipeline?" });
    expect(group).toHaveTextContent(turnOffBody(null));
    expect(group).not.toHaveTextContent(/\d/);
    expect(onUpdate).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Turn off" }));
    expect(onUpdate).toHaveBeenCalledWith({ cards_can_have_children: false });
  });

  it("uses singular copy for one parent and a generic name when the board has none", async () => {
    vi.mocked(getChildrenSettingBlockers).mockResolvedValue({ child_cards: 0, parent_cards: 1, default_of: [] });
    const user = userEvent.setup();
    render(<ChildCardsSettings board={{ ...board, name: "" }} onUpdate={vi.fn()} />);
    const sw = await screen.findByRole("switch");
    await waitFor(() => expect(getChildrenSettingBlockers).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 0));
    await user.click(sw);
    const group = await screen.findByRole("group", { name: "Turn off children on this board?" });
    expect(group).toHaveTextContent("1 card here has children. It keeps them and stays linked, and the tab and rollup stay on that card. It can still Add child; no other card can get children.");
  });
});
