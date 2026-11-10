import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { MemoryRouter } from "react-router-dom";
import CommandPalette from "../components/Common/CommandPalette";
import { useEscapeStack } from "../hooks/useEscapeStack";
import type { Card, Column } from "../types";
import { DEMO_CARD_FOOTER_NOTE } from "../constants/demoCopy";

// listBoards is called on every open. Both mock boards are starred so they
// appear in the palette's empty-query default view (starred-first ranking).
vi.mock("../api/boards", () => ({
  listBoards: vi.fn(() =>
    Promise.resolve([
      { id: 1, name: "Q2 Roadmap", group_name: "Platform", uid: "b1", is_starred: true },
      { id: 2, name: "Login & Onboarding", group_name: "Auth", uid: "b2", is_starred: true },
    ])
  ),
}));

const makeCard = (overrides: Partial<Card> = {}): Card => ({
  id: Math.floor(Math.random() * 1000),
  uid: Math.random().toString(),
  column: 10,
  swimlane: 1,
  title: "Fix login redirect loop",
  description: "",
  priority: "high",
  assignee: null,
  labels: [],
  due_date: null,
  weight: 0,
  position: 0,
  created_by: null,
  created_at: "2026-04-17T00:00:00Z",
  updated_at: "2026-04-17T00:00:00Z",
  last_moved_at: null,
  attachment_count: 0,
  checklist_total: 0,
  checklist_done: 0,
  is_stale: false,
  custom_field_values: [],
  blocker_count: 0, external_ref: null, is_blocked: false, blocked_at: null, blocked_reason: '',
  archived_at: null,
  version: 1,
  ...overrides,
});

const makeColumn = (id: number, name: string): Column => ({
  id,
  uid: `col-${id}`,
  name,
  position: id,
  wip_limit: null,
  weight_limit: null,
  color: "#3b82f6",
  allow_card_creation: true,
  is_done: false,
  policy: null,
});

const defaultProps = {
  userId: 1,
  open: true,
  boardCards: [
    makeCard({ id: 1, title: "Fix login redirect loop", priority: "high", column: 10 }),
    makeCard({ id: 2, title: "Add SSO login button", priority: "low", column: 10 }),
    makeCard({ id: 3, title: "Unrelated task", column: 10 }),
  ],
  columns: [makeColumn(10, "In progress")],
  isAdmin: true,
  onClose: vi.fn(),
  onOpenCard: vi.fn(),
  onAction: vi.fn(),
};

function LowerPriorityEscape({ handler }: { handler: () => void }) {
  useEscapeStack(handler, 40);
  return null;
}

function renderPalette(props = {}) {
  return render(
    <MemoryRouter>
      <CommandPalette {...defaultProps} {...props} />
    </MemoryRouter>
  );
}

describe("CommandPalette", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders search input when open", () => {
    renderPalette();
    expect(screen.getByPlaceholderText(/jump to anything/i)).toBeInTheDocument();
  });

  it("does not render when closed", () => {
    renderPalette({ open: false });
    expect(screen.queryByPlaceholderText(/jump to anything/i)).not.toBeInTheDocument();
  });

  it("filters cards by title query", async () => {
    renderPalette();
    fireEvent.change(screen.getByPlaceholderText(/jump to anything/i), { target: { value: "login" } });
    expect(screen.getByText("Fix login redirect loop")).toBeInTheDocument();
    expect(screen.getByText("Add SSO login button")).toBeInTheDocument();
    expect(screen.queryByText("Unrelated task")).not.toBeInTheDocument();
  });

  it("shows board results fetched from API", async () => {
    renderPalette();
    await waitFor(() => expect(screen.getByText("Q2 Roadmap")).toBeInTheDocument());
    expect(screen.getByText("Login & Onboarding")).toBeInTheDocument();
  });

  it("filters boards by name query", async () => {
    renderPalette();
    await waitFor(() => expect(screen.getByText("Q2 Roadmap")).toBeInTheDocument());
    fireEvent.change(screen.getByPlaceholderText(/jump to anything/i), { target: { value: "onboarding" } });
    expect(screen.queryByText("Q2 Roadmap")).not.toBeInTheDocument();
    expect(screen.getByText("Login & Onboarding")).toBeInTheDocument();
  });

  it("shows static actions section", async () => {
    renderPalette();
    await waitFor(() => expect(screen.getByText(/filter: assigned to me/i)).toBeInTheDocument());
    expect(screen.getByText(/show keyboard shortcuts/i)).toBeInTheDocument();
  });

  it("hides settings action for non-admins", async () => {
    renderPalette({ isAdmin: false });
    await waitFor(() => expect(screen.getByText(/filter: assigned to me/i)).toBeInTheDocument());
    expect(screen.queryByText(/open board settings/i)).not.toBeInTheDocument();
  });

  it("calls onOpenCard when a card result is clicked", () => {
    renderPalette();
    fireEvent.click(screen.getByText("Fix login redirect loop"));
    expect(defaultProps.onOpenCard).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Fix login redirect loop" })
    );
  });

  it("calls onAction when a static action is clicked", async () => {
    renderPalette();
    await waitFor(() => expect(screen.getByText(/show keyboard shortcuts/i)).toBeInTheDocument());
    fireEvent.click(screen.getByText(/show keyboard shortcuts/i));
    expect(defaultProps.onAction).toHaveBeenCalledWith("shortcuts");
    expect(defaultProps.onClose).toHaveBeenCalled();
  });

  it("calls onClose when clicking the backdrop", () => {
    renderPalette();
    // The backdrop is the fixed inset div — target it via testId fallback or direct DOM
    const backdrop = screen.getByRole("combobox").closest(".fixed");
    if (backdrop) fireEvent.mouseDown(backdrop);
    expect(defaultProps.onClose).toHaveBeenCalled();
  });

  it("navigates results with arrow keys", () => {
    renderPalette();
    const input = screen.getByPlaceholderText(/jump to anything/i);
    fireEvent.keyDown(input, { key: "ArrowDown" });
    // Second item should now be active — verify via aria-selected
    const options = screen.getAllByRole("option");
    expect(options[1]).toHaveAttribute("aria-selected", "true");
  });

  it("renders a ★ glyph next to starred board rows", async () => {
    renderPalette();
    await waitFor(() => expect(screen.getByText("Q2 Roadmap")).toBeInTheDocument());
    // Both mock boards are starred → both rows expose a visually-hidden
    // "Favorite" label paired with an aria-hidden ★ glyph (so screen readers
    // announce "Favorite <board>" without reading the Unicode character name).
    const stars = screen.getAllByText("Favorite");
    expect(stars.length).toBeGreaterThanOrEqual(2);
  });
});

describe("CommandPalette — starred-first ranking", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  it("pins starred boards above non-starred on empty query, alphabetically", async () => {
    const { listBoards } = await import("../api/boards");
    (listBoards as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      { id: 1, name: "Zeta Plans", group_name: null, uid: "b1", is_starred: true },
      { id: 2, name: "Alpha Roadmap", group_name: null, uid: "b2", is_starred: true },
      { id: 3, name: "Bravo Ideas", group_name: null, uid: "b3", is_starred: false },
    ]);
    render(
      <MemoryRouter>
        <CommandPalette {...defaultProps} />
      </MemoryRouter>
    );
    await waitFor(() => expect(screen.getByText("Alpha Roadmap")).toBeInTheDocument());
    const boardLabels = screen.getAllByRole("option")
      .filter((el) => el.id.startsWith("palette-item-board-"))
      .map((el) => el.textContent ?? "");
    // Starred first (alpha), then non-starred.
    expect(boardLabels[0]).toContain("Alpha Roadmap");
    expect(boardLabels[1]).toContain("Zeta Plans");
    // Non-starred "Bravo Ideas" is NOT in the empty-query default view (no recents).
    expect(boardLabels.some((l) => l.includes("Bravo Ideas"))).toBe(false);
  });

  it("ranks starred boards first under a non-empty query that matches multiple", async () => {
    const { listBoards } = await import("../api/boards");
    (listBoards as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      { id: 1, name: "Roadmap Alpha", group_name: null, uid: "b1", is_starred: false },
      { id: 2, name: "Roadmap Beta", group_name: null, uid: "b2", is_starred: true },
      { id: 3, name: "Roadmap Gamma", group_name: null, uid: "b3", is_starred: false },
    ]);
    render(
      <MemoryRouter>
        <CommandPalette {...defaultProps} />
      </MemoryRouter>
    );
    // Wait for the fetch to resolve — "Roadmap Beta" is starred so it appears
    // in the empty-query default view.
    await waitFor(() => expect(screen.getByText("Roadmap Beta")).toBeInTheDocument());
    fireEvent.change(screen.getByPlaceholderText(/jump to anything/i), { target: { value: "roadmap" } });
    await waitFor(() => expect(screen.getByText("Roadmap Alpha")).toBeInTheDocument());
    const boardLabels = screen.getAllByRole("option")
      .filter((el) => el.id.startsWith("palette-item-board-"))
      .map((el) => el.textContent ?? "");
    // Starred "Roadmap Beta" floats to the top despite being last in server order;
    // non-starred matches follow in alphabetical order.
    expect(boardLabels[0]).toContain("Roadmap Beta");
    expect(boardLabels[1]).toContain("Roadmap Alpha");
    expect(boardLabels[2]).toContain("Roadmap Gamma");
  });

  it("surfaces recent boards on empty query after starred, excluding stale ids not in listBoards()", async () => {
    // Pre-populate recents with one valid and one stale id (revoked access).
    localStorage.setItem("user:prefs:recent-boards:1", JSON.stringify([
      { id: 3, name: "Bravo Ideas" },
      { id: 99, name: "Revoked Board" },
    ]));
    const { listBoards } = await import("../api/boards");
    (listBoards as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      { id: 1, name: "Alpha Roadmap", group_name: null, uid: "b1", is_starred: true },
      { id: 3, name: "Bravo Ideas", group_name: null, uid: "b3", is_starred: false },
    ]);
    render(
      <MemoryRouter>
        <CommandPalette {...defaultProps} />
      </MemoryRouter>
    );
    await waitFor(() => expect(screen.getByText("Alpha Roadmap")).toBeInTheDocument());
    const boardLabels = screen.getAllByRole("option")
      .filter((el) => el.id.startsWith("palette-item-board-"))
      .map((el) => el.textContent ?? "");
    // Starred first, recent second.
    expect(boardLabels[0]).toContain("Alpha Roadmap");
    expect(boardLabels[1]).toContain("Bravo Ideas");
    // Stale recent with id=99 must NOT leak through (IDOR-safe).
    expect(boardLabels.some((l) => l.includes("Revoked Board"))).toBe(false);
  });

  it("does not show another user's or the legacy unscoped recents (#1955)", async () => {
    localStorage.setItem("user:prefs:recent-boards:2", JSON.stringify([{ id: 3, name: "Bravo Ideas" }]));
    localStorage.setItem("user:prefs:recent-boards", JSON.stringify([{ id: 3, name: "Bravo Ideas" }]));
    const { listBoards } = await import("../api/boards");
    (listBoards as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      { id: 1, name: "Alpha Roadmap", group_name: null, uid: "b1", is_starred: true },
      { id: 3, name: "Bravo Ideas", group_name: null, uid: "b3", is_starred: false },
    ]);
    render(
      <MemoryRouter>
        <CommandPalette {...defaultProps} />
      </MemoryRouter>
    );
    await waitFor(() => expect(screen.getByText("Alpha Roadmap")).toBeInTheDocument());
    // Only the starred board; user 1 has no recents of their own.
    expect(screen.queryByText("Bravo Ideas")).not.toBeInTheDocument();
  });
});

describe("CommandPalette dialog semantics and focus (#1732)", () => {
  it("is a labelled modal dialog and keeps Tab inside it", async () => {
    renderPalette();
    const dialog = await screen.findByRole("dialog", { name: "Command palette" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    await screen.findByRole("combobox");
    const input = screen.getByRole("combobox");
    input.focus();
    const tabbables = dialog.querySelectorAll<HTMLElement>("input, button");
    const last = tabbables[tabbables.length - 1];
    last.focus();
    fireEvent.keyDown(document, { key: "Tab" });
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).toBe(tabbables[0]);
    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(last);
  });

  it("restores focus to the element that opened it", async () => {
    const trigger = document.createElement("button");
    document.body.appendChild(trigger);
    trigger.focus();
    const { rerender } = renderPalette();
    await screen.findByRole("dialog");
    rerender(
      <MemoryRouter>
        <CommandPalette {...defaultProps} open={false} />
      </MemoryRouter>
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
    trigger.remove();
  });
});

// #2059 — card-scoped commands: listed only when a target resolves, state-aware,
// no Delete, `→` drills into a card result's actions, `…` commands open a
// second list, and Escape / ← / Backspace back out one level at a time.
describe("CommandPalette — card actions (#2059)", () => {
  const entries = (over: Partial<Record<string, { enabled: boolean; reason?: string }>> = {}) => [
    { id: "unblock", label: "Unblock card", enabled: true },
    { id: "move", label: "Move to…", enabled: true },
    { id: "assign", label: "Assign to…", enabled: true },
    { id: "priority", label: "Set priority", enabled: true },
    { id: "copy-link", label: "Copy link to card", enabled: true },
    { id: "archive", label: "Archive card", enabled: true },
    { id: "delete", label: "Delete card…", enabled: true },
    { id: "open", label: "Open card", enabled: true },
  ].map((e) => ({ ...e, ...(over[e.id] ?? {}) })) as never
  const target = (over = {}) => ({ cardIds: [1], source: "open" as const, summary: "Fix login redirect loop · Blocked 3d", actions: entries(over) })
  const members = [
    { id: 1, user: { id: 7, username: "alex", display_name: "Alex Reed", avatar_url: "" }, role: "member" },
    { id: 2, user: { id: 8, username: "vic", display_name: "Vic Viewer", avatar_url: "" }, role: "viewer" },
  ] as never
  const input = () => screen.getByLabelText("Command palette search");
  // Card-command rows end with their target's summary (secondary text); strip it to compare labels.
  const options = () => screen.getAllByRole("option").map((o) => (o.textContent ?? "").replace(/(Fix login redirect loop · Blocked 3d|Add SSO login button)$/, ""));

  it("lists the target's commands first, state-aware, with no Delete and no Open", async () => {
    renderPalette({ cardTarget: target() });
    expect(screen.getByTestId("palette-card-target")).toHaveTextContent("Acting on Fix login redirect loop · Blocked 3d");
    // The search box is described by the target header, and the target is announced on open.
    expect(input()).toHaveAccessibleDescription("Acting on Fix login redirect loop · Blocked 3d");
    await waitFor(() => expect(screen.getAllByRole("status").some((s) => s.textContent === "Acting on Fix login redirect loop · Blocked 3d")).toBe(true));
    // Each command names its target.
    const unblock = screen.getByRole("option", { name: /Unblock card/ });
    expect(unblock).toHaveTextContent("Fix login redirect loop · Blocked 3d");
    expect(options().slice(0, 6)).toEqual(["Unblock card", "Move card to…", "Assign card to…", "Set priority…", "Copy link to card", "Archive card"]);
    expect(screen.queryByText("Delete card…")).not.toBeInTheDocument();
    expect(screen.queryByText("Open card")).not.toBeInTheDocument();
  });

  it("shows no card commands without a target, and explains how to get one when the query names one", () => {
    renderPalette();
    expect(screen.queryByTestId("palette-card-target")).not.toBeInTheDocument();
    fireEvent.change(input(), { target: { value: "block" } });
    expect(screen.queryByRole("option", { name: /Block card/ })).not.toBeInTheDocument();
    const hint = screen.getByTestId("palette-no-card-target");
    expect(hint).toHaveTextContent("Select, focus or open a card to act on it.");
    expect(hint).toHaveTextContent("Or search for a card and press →.");
  });

  it("lists Archive disabled with the demo reason when the hosted demo withholds it, and Enter does nothing (#2105)", () => {
    const onCardAction = vi.fn();
    renderPalette({ cardTarget: target({ archive: { enabled: false, reason: DEMO_CARD_FOOTER_NOTE } }), onCardAction });
    fireEvent.change(input(), { target: { value: "archive" } });
    const row = screen.getByRole("option", { name: /Archive card/ });
    expect(row).toHaveAttribute("aria-disabled", "true");
    expect(row).toHaveAccessibleDescription(DEMO_CARD_FOOTER_NOTE);
    fireEvent.keyDown(input(), { key: "Enter" });
    expect(onCardAction).not.toHaveBeenCalled();
  });

  it("hides a disabled command on an empty query, lists it with its reason when typed, and Enter only re-announces", () => {
    const onCardAction = vi.fn();
    renderPalette({ cardTarget: target({ unblock: { enabled: false, reason: "Viewers can't unblock cards" } }), onCardAction });
    expect(screen.queryByRole("option", { name: /Unblock card/ })).not.toBeInTheDocument();
    fireEvent.change(input(), { target: { value: "unbl" } });
    const row = screen.getByRole("option", { name: /Unblock card/ });
    expect(row).toHaveAttribute("aria-disabled", "true");
    expect(row).toHaveAccessibleDescription("Viewers can't unblock cards");
    fireEvent.keyDown(input(), { key: "Enter" });
    expect(onCardAction).not.toHaveBeenCalled();
    expect(screen.getAllByRole("status").some((s) => s.textContent?.includes("Viewers can't unblock cards"))).toBe(true);
    fireEvent.keyDown(input(), { key: "Enter" });
    expect(onCardAction).not.toHaveBeenCalled();
  });

  it("Unblock closes the palette and dispatches the action for the target", () => {
    const onCardAction = vi.fn();
    const onClose = vi.fn();
    renderPalette({ cardTarget: target(), onCardAction, onClose });
    fireEvent.change(input(), { target: { value: "bl" } });
    fireEvent.keyDown(input(), { key: "Enter" });
    expect(onClose).toHaveBeenCalled();
    expect(onCardAction).toHaveBeenCalledWith({ cardIds: [1], action: "unblock" });
  });

  it("a … command drills into its choices; a choice dispatches with its value", () => {
    const onCardAction = vi.fn();
    renderPalette({ cardTarget: target(), onCardAction, members });
    fireEvent.click(screen.getByRole("option", { name: /^Assign card to…/ }));
    expect(input()).toHaveAttribute("placeholder", "Choose a person…");
    // The level change is announced, not only shown in the header.
    expect(screen.getAllByRole("status").some((s) => s.textContent === "Choose a person")).toBe(true);
    expect(options()).toEqual(["Unassign", "Alex Reed"]);
    fireEvent.click(screen.getByRole("option", { name: "Alex Reed" }));
    expect(onCardAction).toHaveBeenCalledWith({ cardIds: [1], action: "assign", value: 7 });
  });

  it("move lists columns and priority lists the four priorities", () => {
    const onCardAction = vi.fn();
    renderPalette({ cardTarget: target(), onCardAction });
    fireEvent.click(screen.getByRole("option", { name: /^Move card to…/ }));
    expect(input()).toHaveAttribute("placeholder", "Choose a column…");
    expect(options()).toEqual(["In progress"]);
    fireEvent.keyDown(input(), { key: "Enter" });
    expect(onCardAction).toHaveBeenCalledWith({ cardIds: [1], action: "move", value: 10 });
  });

  it("Escape, ← and Backspace on an empty query back out one level; Escape then closes", () => {
    const onClose = vi.fn();
    renderPalette({ cardTarget: target(), onClose });
    fireEvent.click(screen.getByRole("option", { name: /^Set priority…/ }));
    expect(input()).toHaveAttribute("placeholder", "Choose a priority…");
    expect(options()).toEqual(["Low", "Medium", "High", "Urgent"]);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("option", { name: /^Set priority…/ })).toBeInTheDocument();
    expect(screen.getAllByRole("status").some((s) => s.textContent === "Card actions for Fix login redirect loop · Blocked 3d")).toBe(true);
    fireEvent.click(screen.getByRole("option", { name: /^Set priority…/ }));
    fireEvent.keyDown(input(), { key: "ArrowLeft" });
    expect(screen.getByRole("option", { name: /^Set priority…/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("option", { name: /^Set priority…/ }));
    fireEvent.keyDown(input(), { key: "Backspace" });
    expect(screen.getByRole("option", { name: /^Set priority…/ })).toBeInTheDocument();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });

  it("Escape at priority 60 is consumed before a lower-priority (40) handler (#1989)", () => {
    const onClose = vi.fn();
    const lower = vi.fn();
    render(
      <MemoryRouter>
        <LowerPriorityEscape handler={lower} />
        <CommandPalette {...defaultProps} onClose={onClose} />
      </MemoryRouter>
    );
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(lower).not.toHaveBeenCalled();
  });

  it("→ on a card search result drills into that card's actions; ← returns", () => {
    const resolveCardActions = vi.fn((ids: number[]) => ({ cardIds: ids, source: "result" as const, summary: "Add SSO login button", actions: entries() }));
    const onCardAction = vi.fn();
    renderPalette({ resolveCardActions, onCardAction });
    expect(screen.getByText("→ card actions")).toBeInTheDocument();
    fireEvent.change(input(), { target: { value: "SSO" } });
    // → with the caret not at the end only moves the caret.
    (input() as HTMLInputElement).setSelectionRange(0, 0);
    fireEvent.keyDown(input(), { key: "ArrowRight" });
    expect(resolveCardActions).not.toHaveBeenCalled();
    (input() as HTMLInputElement).setSelectionRange(3, 3);
    fireEvent.keyDown(input(), { key: "ArrowRight" });
    expect(resolveCardActions).toHaveBeenCalledWith([2]);
    expect(screen.getByTestId("palette-card-target")).toHaveTextContent("Acting on Add SSO login button");
    expect(screen.getAllByRole("status").some((s) => s.textContent === "Card actions for Add SSO login button")).toBe(true);
    expect(input()).toHaveValue("");
    expect(options()).toEqual(["Unblock card", "Move card to…", "Assign card to…", "Set priority…", "Copy link to card", "Archive card"]);
    expect(screen.getByText("← back")).toBeInTheDocument();
    fireEvent.change(input(), { target: { value: "zzz" } });
    expect(screen.getByText("No matching card actions")).toBeInTheDocument();
    fireEvent.change(input(), { target: { value: "" } });
    fireEvent.keyDown(input(), { key: "ArrowLeft" });
    expect(screen.queryByTestId("palette-card-target")).not.toBeInTheDocument();
    expect(screen.getAllByRole("status").some((s) => s.textContent === "All results")).toBe(true);
  });

  it("→ on a non-card row does nothing", () => {
    const resolveCardActions = vi.fn();
    renderPalette({ resolveCardActions });
    fireEvent.change(input(), { target: { value: "shortcuts" } });
    fireEvent.keyDown(input(), { key: "ArrowRight" });
    expect(resolveCardActions).not.toHaveBeenCalled();
  });
});
