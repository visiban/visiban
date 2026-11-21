/**
 * Child-side card links (#1104): the Parent row in card detail, the
 * "Link a parent" picker, the card-face parent line and the store's
 * carry-over of the per-reader `parent` key.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as cardsApi from "../api/cards";
import CardParentSection from "../components/Card/CardParentSection";
import ParentCardPicker from "../components/Card/ParentCardPicker";
import CardItem from "../components/Card/CardItem";
import { CARD_PARENT_REFETCH_EVENT, LINKED_CARD_HIDDEN, candidateDisabledReason, linkErrorCopy } from "../components/Card/cardParent";
import { carryParent } from "../hooks/useBoard";
import type { BoardFull, Card, CardParentVisible, ParentCandidate } from "../types";

vi.mock("@dnd-kit/core", () => ({
  useDraggable: () => ({ attributes: {}, listeners: {}, setNodeRef: () => {}, isDragging: false }),
}));

vi.mock("../api/cards", () => ({
  updateCard: vi.fn(),
  getCardParent: vi.fn(),
  getParentBoards: vi.fn(),
  getParentCandidates: vi.fn(),
  linkCardParent: vi.fn(),
  unlinkCardParent: vi.fn(),
}));

const childBoard = { id: 7, cards_can_have_children: false } as unknown as BoardFull;
const parentBoard = { id: 12, cards_can_have_children: true } as unknown as BoardFull;

const visibleParent: CardParentVisible = {
  hidden: false, id: 41, title: "Initech: security review", board_id: 12, board_name: "Pipeline",
  column_id: 3, column_name: "Qualify", swimlane_id: 4, swimlane_name: "Initech", archived: false,
  board_parent_name_singular: "",
};

function makeCard(overrides: Partial<Card> = {}): Card {
  return {
    id: 51, uid: "carduid00051", column: 10, swimlane: 20, title: "Pen-test scoping call",
    description: "", priority: "low", assignee: null, labels: [],
    due_date: null, weight: 1, position: 0, created_by: null,
    created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z",
    last_moved_at: null, attachment_count: 0, checklist_total: 0, checklist_done: 0,
    is_stale: false, archived_at: null, version: 1,
    custom_field_values: [],
    blocker_count: 0, external_ref: null, is_blocked: false, blocked_at: null, blocked_reason: "",
    ...overrides,
  };
}

function candidate(overrides: Partial<ParentCandidate> = {}): ParentCandidate {
  return {
    id: 41, title: "Initech: security review", column_id: 3, column_name: "Qualify",
    swimlane_id: 4, swimlane_name: "Initech", assignee: null, disabled_reason: null, children_board_name: null,
    ...overrides,
  };
}

const boards = [{ id: 12, name: "Pipeline", parent_name_plural: "" }];

beforeEach(() => {
  vi.mocked(cardsApi.getCardParent).mockReset().mockResolvedValue(null);
  vi.mocked(cardsApi.getParentBoards).mockReset().mockResolvedValue(boards);
  vi.mocked(cardsApi.getParentCandidates).mockReset().mockResolvedValue([]);
  vi.mocked(cardsApi.linkCardParent).mockReset().mockResolvedValue({ parent_id: 41, child_id: 51 });
  vi.mocked(cardsApi.unlinkCardParent).mockReset().mockResolvedValue({} as never);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("CardParentSection (#1104)", () => {
  it("renders nothing on a parent board, and never asks for parent boards there", async () => {
    const { container } = render(<CardParentSection board={parentBoard} card={makeCard({ parent: null })} canEdit />);
    await act(async () => {});
    expect(container).toBeEmptyDOMElement();
    expect(cardsApi.getParentBoards).not.toHaveBeenCalled();
  });

  it("renders nothing with no parent and no parent board to link to", async () => {
    vi.mocked(cardsApi.getParentBoards).mockResolvedValue([]);
    const { container } = render(<CardParentSection board={childBoard} card={makeCard({ parent: null })} canEdit />);
    await act(async () => {});
    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing for a viewer with no parent (no parent-boards read below member)", async () => {
    const { container } = render(<CardParentSection board={childBoard} card={makeCard({ parent: null })} canEdit={false} />);
    await act(async () => {});
    expect(container).toBeEmptyDOMElement();
    expect(cardsApi.getParentBoards).not.toHaveBeenCalled();
  });

  it("renders nothing when the parent-boards read fails", async () => {
    vi.mocked(cardsApi.getParentBoards).mockRejectedValue(new Error("boom"));
    const { container } = render(<CardParentSection board={childBoard} card={makeCard({ parent: null })} canEdit />);
    await act(async () => {});
    expect(container).toBeEmptyDOMElement();
  });

  it("shows Not linked with Link a parent when a parent board exists", async () => {
    render(<CardParentSection board={childBoard} card={makeCard({ parent: null })} canEdit />);
    expect(await screen.findByRole("button", { name: "Link a parent" })).toBeInTheDocument();
    expect(screen.getByText("Not linked")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Parent" })).toBeInTheDocument();
  });

  it("shows a visible parent as a link to its own board, its board and column, and a named Unlink", async () => {
    render(<CardParentSection board={childBoard} card={makeCard({ parent: visibleParent })} canEdit />);
    const link = screen.getByRole("link", { name: "Initech: security review" });
    expect(link).toHaveAttribute("href", "/boards/12?card=41");
    expect(screen.getByText("Pipeline › Qualify")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Unlink parent Initech: security review" })).toBeInTheDocument();
  });

  it("marks an archived parent", () => {
    render(<CardParentSection board={childBoard} card={makeCard({ parent: { ...visibleParent, archived: true } })} canEdit />);
    expect(screen.getByText("Pipeline › Qualify · Archived")).toBeInTheDocument();
  });

  it("shows only the shared string for a parent the viewer can't open", () => {
    render(<CardParentSection board={childBoard} card={makeCard({ parent: { hidden: true } })} canEdit />);
    const row = screen.getByTestId("card-parent-hidden");
    expect(row).toHaveTextContent(LINKED_CARD_HIDDEN);
    expect(row).toHaveTextContent("It is on a board you don't have access to.");
    expect(screen.getByRole("button", { name: "Unlink the linked card you can't open" })).toBeInTheDocument();
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("shows a linked parent read-only to a viewer, and without Unlink in the demo", () => {
    const { rerender } = render(<CardParentSection board={childBoard} card={makeCard({ parent: visibleParent })} canEdit={false} />);
    expect(screen.getByRole("link", { name: "Initech: security review" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Unlink/ })).toBeNull();
    rerender(<CardParentSection board={childBoard} card={makeCard({ parent: visibleParent })} canEdit demoMode />);
    expect(screen.queryByRole("button", { name: /Unlink/ })).toBeNull();
  });

  it("unlinks without asking, asks the board to re-read the card, and moves focus to Link a parent", async () => {
    const onRefetch = vi.fn();
    window.addEventListener(CARD_PARENT_REFETCH_EVENT, onRefetch);
    render(<CardParentSection board={childBoard} card={makeCard({ parent: visibleParent })} canEdit />);
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: "Unlink parent Initech: security review" }));
    const linkBtn = await screen.findByRole("button", { name: "Link a parent" });
    expect(cardsApi.unlinkCardParent).toHaveBeenCalledWith(7, 51);
    expect(onRefetch).toHaveBeenCalledTimes(1);
    expect((onRefetch.mock.calls[0][0] as CustomEvent).detail).toEqual({ cardIds: [51] });
    expect(linkBtn).toHaveFocus();
    window.removeEventListener(CARD_PARENT_REFETCH_EVENT, onRefetch);
  });

  it("treats a 404 unlink as already unlinked", async () => {
    vi.mocked(cardsApi.unlinkCardParent).mockRejectedValue({ response: { status: 404 } });
    render(<CardParentSection board={childBoard} card={makeCard({ parent: { hidden: true } })} canEdit />);
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: "Unlink the linked card you can't open" }));
    expect(await screen.findByRole("button", { name: "Link a parent" })).toBeInTheDocument();
  });

  it("keeps the row and says so when unlink fails", async () => {
    vi.mocked(cardsApi.unlinkCardParent).mockRejectedValue({ response: { status: 500 } });
    render(<CardParentSection board={childBoard} card={makeCard({ parent: visibleParent })} canEdit />);
    fireEvent.click(screen.getByRole("button", { name: "Unlink parent Initech: security review" }));
    expect(await screen.findByText("Failed to unlink the parent. Please try again.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Initech: security review" })).toBeInTheDocument();
  });

  it("a store refresh of card.parent replaces the local result", async () => {
    const { rerender } = render(<CardParentSection board={childBoard} card={makeCard({ parent: visibleParent })} canEdit />);
    fireEvent.click(screen.getByRole("button", { name: "Unlink parent Initech: security review" }));
    await screen.findByRole("button", { name: "Link a parent" });
    rerender(<CardParentSection board={childBoard} card={makeCard({ parent: { hidden: true } })} canEdit />);
    expect(screen.getByTestId("card-parent-hidden")).toBeInTheDocument();
  });

  it("links through the picker and shows the new parent at once", async () => {
    const user = userEvent.setup();
    vi.mocked(cardsApi.getParentCandidates).mockResolvedValue([candidate()]);
    const onRefetch = vi.fn();
    window.addEventListener(CARD_PARENT_REFETCH_EVENT, onRefetch);
    render(<CardParentSection board={childBoard} card={makeCard({ parent: null })} canEdit />);
    await user.click(await screen.findByRole("button", { name: "Link a parent" }));
    await user.type(screen.getByRole("combobox", { name: "Card" }), "Ini");
    const opt = await screen.findByRole("option", { name: /Initech: security review/ });
    fireEvent.mouseDown(opt);
    await user.click(screen.getByRole("button", { name: "Link to Initech: security review" }));
    expect(await screen.findByRole("link", { name: "Initech: security review" })).toHaveAttribute("href", "/boards/12?card=41");
    expect(cardsApi.linkCardParent).toHaveBeenCalledWith(7, 51, 41);
    expect(onRefetch).toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
    window.removeEventListener(CARD_PARENT_REFETCH_EVENT, onRefetch);
  });

  it("Cancel closes the picker and returns focus to Link a parent", async () => {
    const user = userEvent.setup();
    render(<CardParentSection board={childBoard} card={makeCard({ parent: null })} canEdit />);
    const trigger = await screen.findByRole("button", { name: "Link a parent" });
    await user.click(trigger);
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("button", { name: "Link a parent" })).toHaveFocus();
  });
});

describe("CardParentSection unread parent and focus fallback (#1104)", () => {
  it("renders nothing for a card whose parent was never read, until the read resolves", async () => {
    let resolveRead!: (p: CardParentVisible | null) => void;
    vi.mocked(cardsApi.getCardParent).mockReturnValue(new Promise((res) => { resolveRead = res; }));
    render(<CardParentSection board={childBoard} card={makeCard()} canEdit />);
    await act(async () => {});
    expect(cardsApi.getCardParent).toHaveBeenCalledWith(7, 51);
    expect(screen.queryByRole("button", { name: "Link a parent" })).toBeNull();
    expect(screen.queryByText("Not linked")).toBeNull();
    await act(async () => { resolveRead(visibleParent); });
    expect(await screen.findByTestId("card-parent-section")).toHaveTextContent("Initech: security review");
    expect(screen.queryByRole("button", { name: "Link a parent" })).toBeNull();
  });

  it("offers Link a parent once the read says there is none", async () => {
    render(<CardParentSection board={childBoard} card={makeCard()} canEdit />);
    expect(await screen.findByRole("button", { name: "Link a parent" })).toBeInTheDocument();
  });

  it("moves focus to the card panel when an unlink unmounts the whole section", async () => {
    vi.mocked(cardsApi.getParentBoards).mockResolvedValue([]);
    render(
      <div role="dialog" aria-label="Card" tabIndex={-1} data-testid="panel">
        <CardParentSection board={childBoard} card={makeCard({ parent: visibleParent })} canEdit />
      </div>,
    );
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: "Unlink parent Initech: security review" }));
    await waitFor(() => expect(screen.queryByTestId("card-parent-section")).toBeNull());
    expect(screen.getByTestId("panel")).toHaveFocus();
  });
});

describe("ParentCardPicker (#1104)", () => {
  function renderPicker(onLinked = vi.fn(), onClose = vi.fn()) {
    render(<ParentCardPicker boardId={7} cardId={51} parentBoards={boards} onLinked={onLinked} onClose={onClose} />);
    return { onLinked, onClose, input: screen.getByRole("combobox", { name: "Card" }) };
  }

  it("sizes the phone sheet from visualViewport and follows its resize, falling back without it", () => {
    const listeners = new Set<() => void>();
    const vv = {
      height: 500,
      addEventListener: vi.fn((_: string, fn: () => void) => { listeners.add(fn); }),
      removeEventListener: vi.fn((_: string, fn: () => void) => { listeners.delete(fn); }),
    };
    Object.defineProperty(window, "visualViewport", { configurable: true, value: vv });
    try {
      const { unmount } = render(<ParentCardPicker boardId={7} cardId={51} parentBoards={boards} onLinked={vi.fn()} onClose={vi.fn()} />);
      const dialog = screen.getByTestId("parent-card-picker");
      expect(dialog).toHaveClass("max-sm:h-[var(--parent-picker-vh,100%)]");
      expect(dialog.style.getPropertyValue("--parent-picker-vh")).toBe("500px");
      act(() => { vv.height = 300; listeners.forEach((fn) => fn()); });
      expect(dialog.style.getPropertyValue("--parent-picker-vh")).toBe("300px");
      unmount();
      expect(listeners.size).toBe(0);
    } finally {
      Object.defineProperty(window, "visualViewport", { configurable: true, value: undefined });
    }
    renderPicker();
    expect(screen.getByTestId("parent-card-picker").style.getPropertyValue("--parent-picker-vh")).toBe("");
  });

  it("is a dialog named by its heading, starts empty and focused, with the helper tied to the field and list", () => {
    const { input } = renderPicker();
    expect(screen.getByRole("dialog", { name: "Link a parent card" })).toBeInTheDocument();
    expect(input).toHaveValue("");
    expect(input).toHaveFocus();
    expect(input).toHaveAccessibleDescription("Cards on boards you can open. Search by title or card number.");
    expect(screen.getByRole("listbox", { name: "Matching cards", hidden: true })).toHaveAccessibleDescription(
      "Cards on boards you can open. Search by title or card number.",
    );
    expect(cardsApi.getParentCandidates).not.toHaveBeenCalled();
  });

  it("does not search one non-digit character, and searches a one-digit card number", async () => {
    const { input } = renderPicker();
    fireEvent.change(input, { target: { value: "a" } });
    await new Promise((r) => setTimeout(r, 300));
    expect(cardsApi.getParentCandidates).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: "7" } });
    await waitFor(() => expect(cardsApi.getParentCandidates).toHaveBeenCalledWith(7, 51, 12, "7", expect.anything()));
  });

  it("gives one answer for no matches, with no hint about what was withheld", async () => {
    const { input } = renderPicker();
    fireEvent.change(input, { target: { value: "secret" } });
    const status = screen.getByTestId("parent-picker-status");
    await waitFor(() => expect(status).toHaveTextContent("No matching cards"));
    expect(status).toHaveTextContent("Check the spelling or try a card number. Only cards you can open are searched.");
    expect(status).toHaveAttribute("role", "status");
  });

  it("says when the search fails", async () => {
    vi.mocked(cardsApi.getParentCandidates).mockRejectedValue(new Error("x"));
    const { input } = renderPicker();
    fireEvent.change(input, { target: { value: "Ini" } });
    await waitFor(() => expect(screen.getByTestId("parent-picker-status")).toHaveTextContent("Search failed. Try again."));
  });

  it("lists disabled options with their reason, and never links one", async () => {
    vi.mocked(cardsApi.getParentCandidates).mockResolvedValue([
      candidate({ id: 1, title: "Split", disabled_reason: "children_on_other_board", children_board_name: "Onboarding" }),
      candidate({ id: 2, title: "Full", disabled_reason: "children_limit" }),
    ]);
    const { input } = renderPicker();
    fireEvent.change(input, { target: { value: "xx" } });
    const split = await screen.findByRole("option", { name: /Split/ });
    expect(split).toHaveAttribute("aria-disabled", "true");
    expect(split).toHaveTextContent("Pipeline › Qualify · Its children are on Onboarding");
    expect(screen.getByRole("option", { name: /Full/ })).toHaveTextContent("Has 100 children (the limit)");
    fireEvent.mouseDown(split);
    expect(split).toHaveAttribute("aria-selected", "false");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(cardsApi.linkCardParent).not.toHaveBeenCalled();
  });

  it("Up and Down move the active option and Enter links it", async () => {
    vi.mocked(cardsApi.getParentCandidates).mockResolvedValue([candidate({ id: 1, title: "One" }), candidate({ id: 2, title: "Two" })]);
    const { input, onLinked } = renderPicker();
    fireEvent.change(input, { target: { value: "xx" } });
    await screen.findByRole("option", { name: /Two/ });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "ArrowUp" });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(input.getAttribute("aria-activedescendant")).toBe(screen.getByRole("option", { name: /Two/ }).id);
    fireEvent.keyDown(input, { key: "Enter", isComposing: true });
    expect(cardsApi.linkCardParent).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(onLinked).toHaveBeenCalledWith(expect.objectContaining({ id: 2, title: "Two", board_id: 12, board_name: "Pipeline", hidden: false })));
    expect(cardsApi.linkCardParent).toHaveBeenCalledWith(7, 51, 2);
  });

  it("keeps the primary inert until a card is chosen, then names the card", async () => {
    vi.mocked(cardsApi.getParentCandidates).mockResolvedValue([candidate()]);
    const { input } = renderPicker();
    const primary = screen.getByRole("button", { name: "Link" });
    expect(primary).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(primary);
    expect(cardsApi.linkCardParent).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: "Ini" } });
    fireEvent.mouseDown(await screen.findByRole("option", { name: /Initech/ }));
    expect(screen.getByRole("option", { name: /Initech/ })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("button", { name: "Link to Initech: security review" })).not.toHaveAttribute("aria-disabled");
  });

  it("shows the refusal and stays open when the server refuses the link", async () => {
    vi.mocked(cardsApi.getParentCandidates).mockResolvedValue([candidate()]);
    vi.mocked(cardsApi.linkCardParent).mockRejectedValue({ response: { status: 400, data: { code: "children_limit" } } });
    const { input, onLinked } = renderPicker();
    fireEvent.change(input, { target: { value: "Ini" } });
    await screen.findByRole("option", { name: /Initech/ });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(screen.getByTestId("parent-picker-error")).toHaveTextContent("That card has 100 children (the limit)."));
    expect(onLinked).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("closes on Escape, Close and Back to card", () => {
    const { onClose } = renderPicker();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    fireEvent.click(screen.getByRole("button", { name: "Back to card" }));
    expect(onClose).toHaveBeenCalledTimes(3);
  });

  it("searches the board chosen in the Board select, and closes from the backdrop", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<ParentCardPicker boardId={7} cardId={51} parentBoards={[...boards, { id: 13, name: "Accounts", parent_name_plural: "" }]} onLinked={vi.fn()} onClose={onClose} />);
    await user.click(screen.getByRole("combobox", { name: /^Board/ }));
    await user.click(await screen.findByRole("option", { name: "Accounts" }));
    fireEvent.change(screen.getByRole("combobox", { name: "Card" }), { target: { value: "Ini" } });
    await waitFor(() => expect(cardsApi.getParentCandidates).toHaveBeenCalledWith(7, 51, 13, "Ini", expect.anything()));
    fireEvent.click(document.querySelector('[aria-hidden="true"].bg-backdrop\\/40')!);
    expect(onClose).toHaveBeenCalled();
  });

  it("pins option rows at 56px and the phone targets at 44px", async () => {
    vi.mocked(cardsApi.getParentCandidates).mockResolvedValue([candidate()]);
    const { input } = renderPicker();
    fireEvent.change(input, { target: { value: "Ini" } });
    expect(await screen.findByRole("option", { name: /Initech/ })).toHaveClass("min-h-14");
    expect(screen.getByRole("button", { name: "Back to card" })).toHaveClass("min-h-11");
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveClass("min-h-11");
    expect(screen.getByRole("dialog")).toHaveClass("max-sm:h-[var(--parent-picker-vh,100%)]");
  });
});

describe("cardParent copy (#1104)", () => {
  it("names the other board only when the server does", () => {
    expect(candidateDisabledReason(candidate({ disabled_reason: "children_on_other_board", children_board_name: null }))).toBe(
      "Its children are on a board you can't open",
    );
    expect(candidateDisabledReason(candidate())).toBeNull();
  });

  it("maps codes, 404, 429 and unknown errors", () => {
    expect(linkErrorCopy({ response: { status: 404 } })).toMatch(/^No matching cards/);
    expect(linkErrorCopy({ response: { status: 429 } })).toMatch(/Too many link changes/);
    expect(linkErrorCopy({ response: { status: 400, data: { code: "already_has_parent" } } })).toBe("This card already has a parent. Unlink it first.");
    expect(linkErrorCopy(new Error("x"))).toBe("Failed to link the parent. Please try again.");
  });
});

describe("Card face parent line (#1104)", () => {
  it("shows the parent title above the title, in link color", () => {
    render(<CardItem card={makeCard({ parent: visibleParent })} />);
    const line = screen.getByTestId("card-parent-line");
    expect(line).toHaveTextContent("Parent: Initech: security review");
    expect(line).toHaveClass("text-info", "truncate");
  });

  it("shows only the shared string with a lock for a hidden parent", () => {
    render(<CardItem card={makeCard({ parent: { hidden: true } })} />);
    const line = screen.getByTestId("card-parent-line");
    expect(line).toHaveTextContent(LINKED_CARD_HIDDEN);
    expect(line.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
  });

  it("shows no line without a parent, without the key (share payload) and in the compact layout", () => {
    const { rerender } = render(<CardItem card={makeCard({ parent: null })} />);
    expect(screen.queryByTestId("card-parent-line")).toBeNull();
    rerender(<CardItem card={makeCard()} readOnly />);
    expect(screen.queryByTestId("card-parent-line")).toBeNull();
    rerender(<CardItem card={makeCard({ parent: visibleParent })} compact />);
    expect(screen.queryByTestId("card-parent-line")).toBeNull();
  });

  it("reserves the controls' width on the parent line at coarse pointers, like the title", () => {
    render(<CardItem card={makeCard({ parent: visibleParent })} onClick={vi.fn()} onOpenMenu={vi.fn()} />);
    const line = screen.getByTestId("card-parent-line");
    expect(line).toHaveClass("[@media(pointer:fine)]:pr-14", "[@media(pointer:coarse)]:group-focus-within:pr-28");
  });

  it("re-renders when only the parent changes", () => {
    const { rerender } = render(<CardItem card={makeCard({ parent: visibleParent })} />);
    rerender(<CardItem card={makeCard({ parent: { hidden: true } })} />);
    expect(screen.getByTestId("card-parent-line")).toHaveTextContent(LINKED_CARD_HIDDEN);
  });
});

describe("carryParent (#1104)", () => {
  it("keeps the last read parent when the incoming copy has no key", () => {
    const prev = makeCard({ parent: visibleParent });
    const next = makeCard({ title: "Renamed" });
    expect(carryParent(next, prev).parent).toBe(visibleParent);
  });

  it("takes the incoming parent, including null, when it has the key", () => {
    const prev = makeCard({ parent: visibleParent });
    expect(carryParent(makeCard({ parent: null }), prev).parent).toBeNull();
    const next = makeCard();
    expect(carryParent(next, makeCard())).toBe(next);
    expect(carryParent(next, undefined)).toBe(next);
  });
});

describe("parent-item naming on the child side (#2212)", () => {
  it("labels a linked, visible parent with its board's singular name", async () => {
    render(<CardParentSection board={childBoard} card={makeCard({ parent: { ...visibleParent, board_parent_name_singular: "Opportunity" } })} canEdit />);
    expect(await screen.findByRole("heading", { name: "Opportunity" })).toBeInTheDocument();
  });

  it("falls back to Parent when the board set no name, or the parent is hidden", async () => {
    const { unmount } = render(<CardParentSection board={childBoard} card={makeCard({ parent: visibleParent })} canEdit />);
    expect(await screen.findByRole("heading", { name: "Parent" })).toBeInTheDocument();
    unmount();
    render(<CardParentSection board={childBoard} card={makeCard({ parent: { hidden: true } })} canEdit />);
    expect(await screen.findByRole("heading", { name: "Parent" })).toBeInTheDocument();
  });

  it("the picker names the chosen board's plural and keeps its title", () => {
    render(<ParentCardPicker boardId={7} cardId={51} parentBoards={[{ id: 12, name: "Pipeline", parent_name_plural: "Opportunities" }]} onLinked={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByText("Pipeline calls these Opportunities")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Link a parent card" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Board: Pipeline" })).toHaveAccessibleDescription("Pipeline calls these Opportunities");
  });

  it("the picker omits the line when the board set no plural", () => {
    render(<ParentCardPicker boardId={7} cardId={51} parentBoards={boards} onLinked={vi.fn()} onClose={vi.fn()} />);
    expect(screen.queryByText(/calls these/)).not.toBeInTheDocument();
  });
});
