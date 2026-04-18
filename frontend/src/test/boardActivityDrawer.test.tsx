import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import BoardActivityDrawer from "../components/Board/BoardActivityDrawer";
import type { ActivityEntry } from "../components/Board/BoardActivityDrawer";

// Fixed reference time so tests are deterministic regardless of real clock.
const NOW = new Date("2026-04-18T12:00:00Z").getTime();
const now = () => NOW;

// Helper offsets from NOW.
const minutesAgo = (m: number) => new Date(NOW - m * 60 * 1000);
const hoursAgo = (h: number) => new Date(NOW - h * 60 * 60 * 1000);
const daysAgo = (d: number) => new Date(NOW - d * 24 * 60 * 60 * 1000);

const makeEntry = (overrides: Partial<ActivityEntry> = {}): ActivityEntry => ({
  id: Math.random().toString(),
  timestamp: minutesAgo(30),
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
  now,
};

describe("BoardActivityDrawer", () => {
  it("shows empty state when feed is empty", () => {
    render(<BoardActivityDrawer {...defaultProps} />);
    expect(screen.getByText(/no activity yet/i)).toBeInTheDocument();
  });

  it("renders all feed entries in All tab (within default 24h window)", () => {
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

  describe("time window selector (#765)", () => {
    it("defaults to 24h and hides entries older than 24h", () => {
      const feed = [
        makeEntry({ actor: "@recent", timestamp: hoursAgo(2) }),
        makeEntry({ actor: "@yesterday", timestamp: hoursAgo(30) }),
      ];
      render(<BoardActivityDrawer {...defaultProps} feed={feed} />);
      expect(screen.getByText("@recent")).toBeInTheDocument();
      expect(screen.queryByText("@yesterday")).not.toBeInTheDocument();
    });

    it("renders 1h / 24h / 7d window pills with 24h pressed by default", () => {
      render(<BoardActivityDrawer {...defaultProps} />);
      expect(screen.getByRole("button", { name: "1h" })).toHaveAttribute("aria-pressed", "false");
      expect(screen.getByRole("button", { name: "24h" })).toHaveAttribute("aria-pressed", "true");
      expect(screen.getByRole("button", { name: "7d" })).toHaveAttribute("aria-pressed", "false");
    });

    it("1h window hides entries older than 1 hour", () => {
      const feed = [
        makeEntry({ actor: "@fresh", timestamp: minutesAgo(15) }),
        makeEntry({ actor: "@earlier", timestamp: hoursAgo(3) }),
      ];
      render(<BoardActivityDrawer {...defaultProps} feed={feed} />);
      fireEvent.click(screen.getByRole("button", { name: "1h" }));
      expect(screen.getByText("@fresh")).toBeInTheDocument();
      expect(screen.queryByText("@earlier")).not.toBeInTheDocument();
    });

    it("7d window includes entries from several days ago", () => {
      const feed = [
        makeEntry({ actor: "@fresh", timestamp: hoursAgo(2) }),
        makeEntry({ actor: "@lastweek", timestamp: daysAgo(5) }),
        makeEntry({ actor: "@tooold", timestamp: daysAgo(10) }),
      ];
      render(<BoardActivityDrawer {...defaultProps} feed={feed} />);
      fireEvent.click(screen.getByRole("button", { name: "7d" }));
      expect(screen.getByText("@fresh")).toBeInTheDocument();
      expect(screen.getByText("@lastweek")).toBeInTheDocument();
      expect(screen.queryByText("@tooold")).not.toBeInTheDocument();
    });

    it("window selector updates aria-pressed when a different window is chosen", () => {
      render(<BoardActivityDrawer {...defaultProps} />);
      fireEvent.click(screen.getByRole("button", { name: "7d" }));
      expect(screen.getByRole("button", { name: "7d" })).toHaveAttribute("aria-pressed", "true");
      expect(screen.getByRole("button", { name: "24h" })).toHaveAttribute("aria-pressed", "false");
    });
  });
});
