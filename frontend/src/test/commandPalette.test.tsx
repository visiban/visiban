import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { MemoryRouter } from "react-router-dom";
import CommandPalette from "../components/Common/CommandPalette";
import type { Card, Column } from "../types";

// listBoards is called on every open
vi.mock("../api/boards", () => ({
  listBoards: vi.fn(() =>
    Promise.resolve([
      { id: 1, name: "Q2 Roadmap", group_name: "Platform", uid: "b1" },
      { id: 2, name: "Login & Onboarding", group_name: "Auth", uid: "b2" },
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
  board: 99,
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
});
