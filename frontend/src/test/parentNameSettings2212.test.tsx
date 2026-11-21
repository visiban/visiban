import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import ParentNameSettings from "../components/Board/ParentNameSettings";
import ChildCardsSettings from "../components/Board/ChildCardsSettings";

vi.mock("../api/boards", () => ({
  getChildrenSettingBlockers: vi.fn().mockResolvedValue({ parent_links: 0, child_links: 0, default_of: [] }),
  getDefaultChildBoardOptions: vi.fn().mockResolvedValue([]),
}));

const board = { id: 1, parent_name_singular: "", parent_name_plural: "" };

function setup(over: Partial<typeof board> = {}, onUpdate = vi.fn().mockResolvedValue(null)) {
  render(<ParentNameSettings board={{ ...board, ...over }} onUpdate={onUpdate} />);
  return { onUpdate, user: userEvent.setup() };
}

describe("ParentNameSettings (#2212)", () => {
  it("starts empty with the generic placeholders, labels and help text, nothing pressed", () => {
    setup();
    expect(screen.getByRole("group", { name: "What do you call a parent card on this board?" })).toBeInTheDocument();
    const singular = screen.getByLabelText("Singular");
    const plural = screen.getByLabelText("Plural");
    expect(singular).toHaveValue("");
    expect(singular).toHaveAttribute("placeholder", "Parent");
    expect(plural).toHaveAttribute("placeholder", "Parents");
    expect(singular).toHaveAttribute("maxLength", "24");
    expect(screen.getByText(/Starts empty, so the board says/)).toBeInTheDocument();
    for (const name of ["Opportunity", "Initiative", "Release"]) {
      expect(screen.getByRole("button", { name })).toHaveAttribute("aria-pressed", "false");
    }
  });

  it("saves a trimmed field on blur only when it changed", async () => {
    const { onUpdate, user } = setup();
    await user.type(screen.getByLabelText("Singular"), "  Epic ");
    await user.tab();
    expect(onUpdate).toHaveBeenCalledWith({ parent_name_singular: "Epic" });
    expect(screen.getByLabelText("Singular")).toHaveValue("Epic");
    onUpdate.mockClear();
    await user.click(screen.getByLabelText("Plural"));
    await user.tab();
    expect(onUpdate).not.toHaveBeenCalled();
  });

  it("a suggestion fills and saves both fields in one patch, and shows as pressed", async () => {
    const { onUpdate, user } = setup();
    await user.click(screen.getByRole("button", { name: "Initiative" }));
    expect(onUpdate).toHaveBeenCalledTimes(1);
    expect(onUpdate).toHaveBeenCalledWith({ parent_name_singular: "Initiative", parent_name_plural: "Initiatives" });
    expect(screen.getByRole("button", { name: "Initiative" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("parent-name-mark-Initiative")).toBeInTheDocument();
  });

  it("pressed is derived from both fields; the pressed suggestion clears both", async () => {
    const { onUpdate, user } = setup({ parent_name_singular: "Release", parent_name_plural: "Releases" });
    const release = screen.getByRole("button", { name: "Release" });
    expect(release).toHaveAttribute("aria-pressed", "true");
    await user.click(release);
    expect(onUpdate).toHaveBeenCalledWith({ parent_name_singular: "", parent_name_plural: "" });
    expect(screen.getByLabelText("Singular")).toHaveValue("");
  });

  it("only one field matching does not press the suggestion", () => {
    setup({ parent_name_singular: "Release", parent_name_plural: "Ships" });
    expect(screen.getByRole("button", { name: "Release" })).toHaveAttribute("aria-pressed", "false");
  });

  it("rolls back and alerts with the server message when the save fails", async () => {
    const err = { response: { data: { parent_name_singular: ["Use 24 characters or fewer."] } } };
    const { user } = setup({}, vi.fn().mockResolvedValue(err));
    await user.type(screen.getByLabelText("Singular"), "Epic");
    await user.tab();
    expect(await screen.findByRole("alert")).toHaveTextContent("Use 24 characters or fewer.");
    expect(screen.getByLabelText("Singular")).toHaveValue("");
  });

  it("falls back to generic copy when a rejected save carries no message", async () => {
    const { user } = setup({}, vi.fn().mockRejectedValue(new Error("network")));
    await user.click(screen.getByRole("button", { name: "Opportunity" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't save the parent name. Please try again.");
    expect(screen.getByLabelText("Plural")).toHaveValue("");
  });

  it("points both inputs at the help text, and at the alert with aria-invalid while an error shows", async () => {
    const { user } = setup({}, vi.fn().mockResolvedValue({ response: { data: { detail: "Nope." } } }));
    const singular = screen.getByLabelText("Singular");
    const plural = screen.getByLabelText("Plural");
    const help = screen.getByText(/Starts empty, so the board says/);
    expect(singular).toHaveAttribute("aria-describedby", help.id);
    expect(singular).not.toHaveAttribute("aria-invalid");
    await user.type(singular, "Epic");
    await user.tab();
    const alert = await screen.findByRole("alert");
    for (const input of [singular, plural]) {
      expect(input).toHaveAttribute("aria-describedby", `${help.id} ${alert.id}`);
      expect(input).toHaveAttribute("aria-invalid", "true");
    }
  });

  it("runs saves one at a time so an earlier failure cannot roll back after a later save started", async () => {
    let rejectFirst: (v: unknown) => void = () => {};
    const onUpdate = vi
      .fn()
      .mockImplementationOnce(() => new Promise((r) => { rejectFirst = r; }))
      .mockResolvedValue(null);
    const { user } = setup({}, onUpdate);
    await user.type(screen.getByLabelText("Singular"), "Epic");
    await user.tab();
    await user.click(screen.getByRole("button", { name: "Release" }));
    // The second save has not started: the first is still in flight.
    expect(onUpdate).toHaveBeenCalledTimes(1);
    rejectFirst(new Error("boom"));
    await vi.waitFor(() => expect(onUpdate).toHaveBeenCalledTimes(2));
    expect(onUpdate).toHaveBeenLastCalledWith({ parent_name_singular: "Release", parent_name_plural: "Releases" });
  });
});

describe("ChildCardsSettings hosts the parent name (#2212)", () => {
  it("shows the parent-name panel only while cards can have children", async () => {
    const base = { id: 1, default_child_board: null, parent_name_singular: "Epic", parent_name_plural: "" };
    const { rerender } = render(<ChildCardsSettings board={{ ...base, cards_can_have_children: false }} onUpdate={vi.fn()} />);
    expect(screen.queryByTestId("parent-name-settings")).not.toBeInTheDocument();
    rerender(<ChildCardsSettings board={{ ...base, cards_can_have_children: true }} onUpdate={vi.fn()} />);
    expect(await screen.findByTestId("parent-name-settings")).toBeInTheDocument();
    expect(screen.getByLabelText("Singular")).toHaveValue("Epic");
  });
});
