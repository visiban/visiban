import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { MemoryRouter } from "react-router-dom";
import CommandPalette from "../components/Common/CommandPalette";
import type { Card, Column } from "../types";

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
});

const defaultProps = {
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
    localStorage.setItem("user:prefs:recent-boards", JSON.stringify([
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
});
