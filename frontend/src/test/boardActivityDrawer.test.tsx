import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import BoardActivityDrawer from "../components/Board/BoardActivityDrawer";
import type { ActivityEntry } from "../components/Board/BoardActivityDrawer";

const makeEntry = (overrides: Partial<ActivityEntry> = {}): ActivityEntry => ({
  id: Math.random().toString(),
  timestamp: new Date("2026-04-17T00:00:00Z"),
  kind: "move",
  actor: "@kelly",
  headline: "moved Fix login loop",
  detail: "Backlog → In progress",
  ...overrides,
});

const defaultProps = {
  feed: [],
  onClose: vi.fn(),
  onOpenHistory: vi.fn(),
};

describe("BoardActivityDrawer", () => {
  it("shows empty state when feed is empty", () => {
    render(<BoardActivityDrawer {...defaultProps} />);
    expect(screen.getByText(/no activity yet/i)).toBeInTheDocument();
  });

  it("renders all feed entries in All tab", () => {
    const feed = [
      makeEntry({ actor: "@kelly", headline: "moved Fix login loop" }),
      makeEntry({ kind: "create", actor: "@maya", headline: "created New spike" }),
      makeEntry({ kind: "member", actor: "@alex", headline: "joined the board", detail: "" }),
    ];
    render(<BoardActivityDrawer {...defaultProps} feed={feed} />);
    expect(screen.getByText("@kelly")).toBeInTheDocument();
    expect(screen.getByText("@maya")).toBeInTheDocument();
    expect(screen.getByText("@alex")).toBeInTheDocument();
  });

  it("filters to only move/create entries on Moves tab", () => {
    const feed = [
      makeEntry({ kind: "move", actor: "@kelly", headline: "moved a card" }),
      makeEntry({ kind: "member", actor: "@alex", headline: "joined the board", detail: "" }),
    ];
    render(<BoardActivityDrawer {...defaultProps} feed={feed} />);
    fireEvent.click(screen.getByRole("button", { name: /^moves$/i }));
    expect(screen.getByText("@kelly")).toBeInTheDocument();
    expect(screen.queryByText("@alex")).not.toBeInTheDocument();
  });

  it("filters to only member entries on Members tab", () => {
    const feed = [
      makeEntry({ kind: "move", actor: "@kelly", headline: "moved a card" }),
      makeEntry({ kind: "member", actor: "@alex", headline: "joined the board", detail: "" }),
    ];
    render(<BoardActivityDrawer {...defaultProps} feed={feed} />);
    fireEvent.click(screen.getByRole("button", { name: /^members$/i }));
    expect(screen.queryByText("@kelly")).not.toBeInTheDocument();
    expect(screen.getByText("@alex")).toBeInTheDocument();
  });

  it("calls onClose when close button is clicked", () => {
    const onClose = vi.fn();
    render(<BoardActivityDrawer {...defaultProps} onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: /close activity drawer/i }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("calls onOpenHistory when full history link is clicked", () => {
    const onOpenHistory = vi.fn();
    render(<BoardActivityDrawer {...defaultProps} onOpenHistory={onOpenHistory} />);
    fireEvent.click(screen.getByRole("button", { name: /open full history/i }));
    expect(onOpenHistory).toHaveBeenCalledTimes(1);
  });

  it("shows entry detail text", () => {
    const feed = [makeEntry({ detail: "Backlog → Done" })];
    render(<BoardActivityDrawer {...defaultProps} feed={feed} />);
    expect(screen.getByText("Backlog → Done")).toBeInTheDocument();
  });
});
