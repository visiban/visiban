import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import BoardActivityDrawer from "../components/Board/BoardActivityDrawer";
import type { ActivityEntry } from "../components/Board/BoardActivityDrawer";
import { useIsLargeViewport } from "../hooks/useIsLargeViewport";

vi.mock("../hooks/useIsLargeViewport", () => ({ useIsLargeViewport: vi.fn(() => true) }));

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

const openFilters = () => fireEvent.click(screen.getByRole("button", { name: /^filter activity/i }));
// The Filter button's name once a non-default window is active ("Filter, 1 active").
const openActiveFilters = () => fireEvent.click(screen.getByRole("button", { name: /^filter, 1 active/i }));

describe("BoardActivityDrawer", () => {
  it("heading is bold 17px like the reference (#2390)", () => {
    render(<BoardActivityDrawer {...defaultProps} />);
    expect(screen.getByText("Activity", { selector: "div" })).toHaveClass("text-[17px]", "font-semibold", "text-fg");
  });

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
    expect(screen.getByText("kelly")).toBeInTheDocument();
    expect(screen.getByText("maya")).toBeInTheDocument();
    expect(screen.getByText("alex")).toBeInTheDocument();
  });

  it("filters to only move/create entries on Moves tab", () => {
    const feed = [
      makeEntry({ kind: "move", actor: "@kelly", headline: "moved a card" }),
      makeEntry({ kind: "member", actor: "@alex", headline: "joined the board", detail: "" }),
    ];
    render(<BoardActivityDrawer {...defaultProps} feed={feed} />);
    openFilters();
    fireEvent.click(screen.getByRole("button", { name: /^moves$/i }));
    expect(screen.getByText("kelly")).toBeInTheDocument();
    expect(screen.queryByText("alex")).not.toBeInTheDocument();
  });

  it("filters to only member entries on Members tab", () => {
    const feed = [
      makeEntry({ kind: "move", actor: "@kelly", headline: "moved a card" }),
      makeEntry({ kind: "member", actor: "@alex", headline: "joined the board", detail: "" }),
    ];
    render(<BoardActivityDrawer {...defaultProps} feed={feed} />);
    openFilters();
    fireEvent.click(screen.getByRole("button", { name: /^members$/i }));
    expect(screen.queryByText("kelly")).not.toBeInTheDocument();
    expect(screen.getByText("alex")).toBeInTheDocument();
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
    fireEvent.click(screen.getByRole("button", { name: /open the full history view/i }));
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
      expect(screen.getByText("recent")).toBeInTheDocument();
      expect(screen.queryByText("yesterday")).not.toBeInTheDocument();
    });

    it("renders 1h / 24h / 7d window pills with 24h pressed by default", () => {
      render(<BoardActivityDrawer {...defaultProps} />);
      openFilters();
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
      openFilters();
      fireEvent.click(screen.getByRole("button", { name: "1h" }));
      expect(screen.getByText("fresh")).toBeInTheDocument();
      expect(screen.queryByText("earlier")).not.toBeInTheDocument();
    });

    it("7d window includes entries from several days ago", () => {
      const feed = [
        makeEntry({ actor: "@fresh", timestamp: hoursAgo(2) }),
        makeEntry({ actor: "@lastweek", timestamp: daysAgo(5) }),
        makeEntry({ actor: "@tooold", timestamp: daysAgo(10) }),
      ];
      render(<BoardActivityDrawer {...defaultProps} feed={feed} />);
      openFilters();
      fireEvent.click(screen.getByRole("button", { name: "7d" }));
      expect(screen.getByText("fresh")).toBeInTheDocument();
      expect(screen.getByText("lastweek")).toBeInTheDocument();
      expect(screen.queryByText("tooold")).not.toBeInTheDocument();
    });

    it("window selector updates aria-pressed when a different window is chosen", () => {
      render(<BoardActivityDrawer {...defaultProps} />);
      openFilters();
      fireEvent.click(screen.getByRole("button", { name: "7d" }));
      expect(screen.getByRole("button", { name: "7d" })).toHaveAttribute("aria-pressed", "true");
      expect(screen.getByRole("button", { name: "24h" })).toHaveAttribute("aria-pressed", "false");
    });
  });

  it("marks the active kind tab and time window with a check as well as the tint (#2185)", () => {
    render(<BoardActivityDrawer {...defaultProps} />);
    openFilters();
    const all = screen.getByRole("button", { name: /^all$/i });
    const moves = screen.getByRole("button", { name: /^moves$/i });
    expect(all).toHaveAttribute("aria-pressed", "true");
    expect(all.querySelector('[data-testid="active-mark"]')).not.toBeNull();
    expect(moves.querySelector('[data-testid="active-mark"]')).toBeNull();
    fireEvent.click(moves);
    expect(moves.querySelector('[data-testid="active-mark"]')).not.toBeNull();
    expect(all.querySelector('[data-testid="active-mark"]')).toBeNull();
    const windowGroup = screen.getByRole("group", { name: "Activity time window" });
    expect(windowGroup.querySelectorAll('[data-testid="active-mark"]')).toHaveLength(1);
    expect(windowGroup.querySelector('[aria-pressed="true"] [data-testid="active-mark"]')).not.toBeNull();
  });

  describe("rows and filter popover (#2316)", () => {
    it("renders the card title, the move in words, an avatar and a time per row, with no stale chrome", () => {
      const feed = [makeEntry({ subject: "Zurich Insurance", detail: "Negotiation → Closed Won", timestamp: minutesAgo(12) })];
      render(<BoardActivityDrawer {...defaultProps} feed={feed} />);
      expect(screen.getByText("Zurich Insurance")).toBeInTheDocument();
      expect(screen.getByText("Negotiation to Closed Won")).toBeInTheDocument();
      expect(screen.getByText("by @kelly")).toHaveClass("sr-only");
      expect(screen.getByRole("listitem").querySelector("time")).not.toBeNull();
      expect(screen.getByRole("listitem")).toHaveTextContent(/^K/);
      expect(screen.queryByText(/live · board events/i)).not.toBeInTheDocument();
      expect(screen.queryByRole("group", { name: "Activity time window" })).not.toBeInTheDocument();
    });

    it("shows Created for a create row and the headline under the name for a member row", () => {
      const feed = [
        makeEntry({ kind: "create", subject: "New spike", detail: "" }),
        makeEntry({ kind: "member", actor: "Alex", headline: "joined the board", detail: "" }),
      ];
      render(<BoardActivityDrawer {...defaultProps} feed={feed} />);
      expect(screen.getByText("Created")).toBeInTheDocument();
      expect(screen.getByText("Alex")).toBeInTheDocument();
      expect(screen.getByText("joined the board")).toBeInTheDocument();
    });

    it("keeps the popover closed by default and flags a non-default filter on the button", () => {
      render(<BoardActivityDrawer {...defaultProps} />);
      expect(screen.queryByRole("dialog", { name: "Activity filters" })).not.toBeInTheDocument();
      expect(screen.queryByTestId("activity-filter-count")).toBeNull();
      openFilters();
      expect(screen.getByRole("button", { name: /^filter activity/i })).toHaveAttribute("aria-expanded", "true");
      fireEvent.click(screen.getByRole("button", { name: /^moves$/i }));
      fireEvent.click(screen.getByRole("button", { name: "7d" }));
      // The name opens with the visible words in order, and a real space keeps "Filter" and
      // the count separate words: axe would otherwise read "Filter2" (WCAG 2.5.3, #2467).
      const active = screen.getByRole("button", { name: "Filter, 2 active" });
      expect(active.textContent).toBe("Filter 2");
      expect(screen.getByTestId("activity-filter-count")).toHaveTextContent("2");
    });

    it("Escape closes only the popover and returns focus to the button; click outside closes it too", () => {
      const onClose = vi.fn();
      render(<BoardActivityDrawer {...defaultProps} onClose={onClose} />);
      const btn = screen.getByRole("button", { name: "Filter activity" });
      openFilters();
      fireEvent.keyDown(document, { key: "Escape" });
      expect(screen.queryByRole("dialog", { name: "Activity filters" })).not.toBeInTheDocument();
      expect(btn).toHaveFocus();
      expect(onClose).not.toHaveBeenCalled();
      fireEvent.keyDown(document, { key: "Escape" });
      expect(onClose).toHaveBeenCalledTimes(1);
      openFilters();
      fireEvent.pointerDown(document.body);
      expect(screen.queryByRole("dialog", { name: "Activity filters" })).not.toBeInTheDocument();
    });

    it("moves focus to the selected option on open", () => {
      render(<BoardActivityDrawer {...defaultProps} />);
      openFilters();
      expect(screen.getByRole("button", { name: /^all$/i })).toHaveFocus();
    });

    it("option buttons carry min-h-6 touch targets", () => {
      render(<BoardActivityDrawer {...defaultProps} />);
      openFilters();
      expect(screen.getByRole("button", { name: /^moves$/i })).toHaveClass("min-h-6");
      expect(screen.getByRole("button", { name: "7d" })).toHaveClass("min-h-6");
    });

    it("closes on focus leaving the popover and trigger without stealing focus back", () => {
      render(
        <div>
          <button type="button">elsewhere</button>
          <BoardActivityDrawer {...defaultProps} />
        </div>,
      );
      openFilters();
      const inside = screen.getByRole("button", { name: /^all$/i });
      // Focus moving between the popover and its trigger keeps it open.
      fireEvent.blur(inside, { relatedTarget: screen.getByRole("button", { name: /^filter activity/i }) });
      expect(screen.getByRole("dialog", { name: "Activity filters" })).toBeInTheDocument();
      const elsewhere = screen.getByRole("button", { name: "elsewhere" });
      elsewhere.focus();
      fireEvent.blur(inside, { relatedTarget: elsewhere });
      expect(screen.queryByRole("dialog", { name: "Activity filters" })).not.toBeInTheDocument();
      expect(elsewhere).toHaveFocus();
    });

    it("keeps the popover open when blur has no related target (Safari click, window blur)", () => {
      render(<BoardActivityDrawer {...defaultProps} />);
      openFilters();
      const inside = screen.getByRole("button", { name: /^all$/i });
      fireEvent.blur(inside, { relatedTarget: null });
      expect(screen.getByRole("dialog", { name: "Activity filters" })).toBeInTheDocument();
    });

    it("shows the filter-specific empty copy when a filter hides everything", () => {
      render(<BoardActivityDrawer {...defaultProps} feed={[makeEntry()]} />);
      openFilters();
      fireEvent.click(screen.getByRole("button", { name: /^members$/i }));
      expect(screen.getByText("No activity matches the filter")).toBeInTheDocument();
      expect(screen.queryByText("No activity yet")).not.toBeInTheDocument();
    });

    it("closes the popover when switching to the Archived tab and does not reopen on return", () => {
      const { rerender } = render(<BoardActivityDrawer {...defaultProps} tab="recent" />);
      openFilters();
      expect(screen.getByRole("dialog", { name: "Activity filters" })).toBeInTheDocument();
      rerender(<BoardActivityDrawer {...defaultProps} tab="archived" archivedContent={<div>archived body</div>} />);
      expect(screen.queryByRole("dialog", { name: "Activity filters" })).not.toBeInTheDocument();
      rerender(<BoardActivityDrawer {...defaultProps} tab="recent" />);
      expect(screen.queryByRole("dialog", { name: "Activity filters" })).not.toBeInTheDocument();
    });

    it("falls back to headline plus detail for a move with no card title", () => {
      render(<BoardActivityDrawer {...defaultProps} feed={[makeEntry({ headline: "moved a card", detail: "Todo → Done" })]} />);
      expect(screen.getByText("kelly")).toBeInTheDocument();
      expect(screen.getByText("moved a card")).toBeInTheDocument();
      expect(screen.getByText("Todo → Done")).toBeInTheDocument();
    });
  });

  describe("Recent | Archived tabs (#2274)", () => {
    it("shows Recent selected by default and lists both tabs", () => {
      render(<BoardActivityDrawer {...defaultProps} />);
      expect(screen.getByRole("tab", { name: "Recent" })).toHaveAttribute("aria-selected", "true");
      expect(screen.getByRole("tab", { name: "Archived" })).toHaveAttribute("aria-selected", "false");
      expect(screen.getByTestId("drawer-tab-underline")).toHaveClass("bg-primary-emphasis");
      expect(screen.getByRole("button", { name: /open the full history view/i })).toHaveClass("text-fg-secondary");
      expect(screen.getByRole("tab", { name: "Recent" })).toHaveFocus();
      expect(screen.getByRole("button", { name: "Filter activity" })).toBeInTheDocument();
    });

    it("asks the host to switch tabs on click and with arrow keys", () => {
      const onTabChange = vi.fn();
      render(<BoardActivityDrawer {...defaultProps} onTabChange={onTabChange} />);
      fireEvent.click(screen.getByRole("tab", { name: "Archived" }));
      expect(onTabChange).toHaveBeenLastCalledWith("archived");
      fireEvent.keyDown(screen.getByRole("tab", { name: "Recent" }), { key: "ArrowRight" });
      expect(onTabChange).toHaveBeenLastCalledWith("archived");
      fireEvent.keyDown(screen.getByRole("tab", { name: "Recent" }), { key: "End" });
      expect(onTabChange).toHaveBeenLastCalledWith("archived");
      fireEvent.keyDown(screen.getByRole("tab", { name: "Recent" }), { key: "Home" });
      expect(onTabChange).toHaveBeenLastCalledWith("recent");
      fireEvent.keyDown(screen.getByRole("tab", { name: "Recent" }), { key: "a" });
      expect(onTabChange).toHaveBeenCalledTimes(4);
    });

    it("renders the archived content instead of the feed on the Archived tab", () => {
      render(
        <BoardActivityDrawer
          {...defaultProps}
          feed={[makeEntry({ actor: "@kelly" })]}
          tab="archived"
          archivedContent={<div>archived body</div>}
        />,
      );
      expect(screen.getByText("archived body")).toBeInTheDocument();
      expect(screen.queryByText("kelly")).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /^filter activity/i })).not.toBeInTheDocument();
      expect(screen.getByRole("tab", { name: "Archived" })).toHaveAttribute("aria-selected", "true");
    });
  });

  describe("placement (#2274)", () => {
    it("floats top right over the board on a large viewport", () => {
      vi.mocked(useIsLargeViewport).mockReturnValue(true);
      render(<BoardActivityDrawer {...defaultProps} />);
      const aside = screen.getByTestId("activity-drawer");
      expect(aside).toHaveClass("absolute", "top-2", "right-3", "rounded-lg", "shadow-xl");
      expect(aside).not.toHaveClass("fixed");
    });

    it("becomes a full-height right edge panel below the large breakpoint", () => {
      vi.mocked(useIsLargeViewport).mockReturnValue(false);
      render(<BoardActivityDrawer {...defaultProps} />);
      const aside = screen.getByTestId("activity-drawer");
      expect(aside).toHaveClass("fixed", "inset-y-0", "right-0", "max-w-full");
      expect(aside).not.toHaveClass("absolute");
      vi.mocked(useIsLargeViewport).mockReturnValue(true);
    });
  });

  // #2596: the Recent tab is built on fetched saved history, so it tells
  // loading, empty and failed apart, and opens on a window that has rows.
  describe("saved history states (#2596)", () => {
    it("shows a loading line, aria-busy, and never the empty state while history loads", () => {
      render(<BoardActivityDrawer {...defaultProps} historyStatus="loading" />);
      expect(screen.getByText("Loading activity…")).toBeInTheDocument();
      expect(screen.queryByText("No activity yet")).not.toBeInTheDocument();
      expect(screen.getByRole("region", { name: "Recent activity" })).toHaveAttribute("aria-busy", "true");
    });

    it("keeps live rows on screen while history loads, with a loading note under them", () => {
      render(<BoardActivityDrawer {...defaultProps} historyStatus="loading" feed={[makeEntry({ actor: "@live" })]} />);
      expect(screen.getByText("live")).toBeInTheDocument();
      expect(screen.getByText("Loading earlier activity…")).toBeInTheDocument();
    });

    it("says No activity yet only when history is ready and the board has none", () => {
      render(<BoardActivityDrawer {...defaultProps} historyStatus="ready" />);
      expect(screen.getByText("No activity yet")).toBeInTheDocument();
      expect(screen.getByRole("region", { name: "Recent activity" })).toHaveAttribute("aria-busy", "false");
    });

    it("a failed load shows an inline error with Retry above the live rows, not the empty state", () => {
      const onRetryHistory = vi.fn();
      const { rerender } = render(
        <BoardActivityDrawer {...defaultProps} historyStatus="error" onRetryHistory={onRetryHistory} feed={[makeEntry({ actor: "@live" })]} />,
      );
      expect(screen.getByText("Couldn't load earlier activity")).toBeInTheDocument();
      expect(screen.getByText("live")).toBeInTheDocument();
      expect(screen.queryByText("No activity yet")).not.toBeInTheDocument();
      const retry = screen.getByRole("button", { name: "Retry" });
      expect(retry).toHaveClass("rounded", "text-xs", "focus:outline-none", "focus:ring-2", "focus:ring-primary-emphasis");
      retry.focus();
      fireEvent.click(retry);
      expect(onRetryHistory).toHaveBeenCalledTimes(1);
      // The same button stays mounted and busy while the retry runs, so focus is kept.
      rerender(<BoardActivityDrawer {...defaultProps} historyStatus="loading" onRetryHistory={onRetryHistory} feed={[makeEntry({ actor: "@live" })]} />);
      const busy = screen.getByRole("button", { name: "Loading…" });
      expect(busy).toHaveAttribute("aria-disabled", "true");
      expect(busy).toHaveFocus();
      fireEvent.click(busy);
      expect(onRetryHistory).toHaveBeenCalledTimes(1);
      // Recovery unmounts the row and hands focus to the feed, never <body>.
      rerender(<BoardActivityDrawer {...defaultProps} historyStatus="ready" onRetryHistory={onRetryHistory} feed={[makeEntry({ actor: "@live" })]} />);
      expect(screen.queryByTestId("activity-history-error")).not.toBeInTheDocument();
      expect(screen.getByRole("region", { name: "Recent activity" })).toHaveFocus();
    });

    it("a retry that fails again returns the row to Retry", () => {
      const onRetryHistory = vi.fn();
      const { rerender } = render(<BoardActivityDrawer {...defaultProps} historyStatus="error" onRetryHistory={onRetryHistory} />);
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
      rerender(<BoardActivityDrawer {...defaultProps} historyStatus="loading" onRetryHistory={onRetryHistory} />);
      expect(screen.queryByText("Loading activity…")).not.toBeInTheDocument();
      rerender(<BoardActivityDrawer {...defaultProps} historyStatus="error" onRetryHistory={onRetryHistory} />);
      expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
    });

    it("words the empty state for the window when the window, not the kind filter, empties it", () => {
      render(<BoardActivityDrawer {...defaultProps} feed={[makeEntry({ actor: "@old", timestamp: daysAgo(10) })]} />);
      expect(screen.getByText("No activity in the last 24 hours")).toBeInTheDocument();
      expect(screen.queryByText("No activity matches the filter")).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "Show the last 7 days" }));
      expect(screen.getByText("No activity in the last 7 days")).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Show the last 7 days" })).not.toBeInTheDocument();
    });

    it("says Loaded N recent activities once, in a polite status, when history loads", () => {
      const feed = [makeEntry(), makeEntry()];
      const { rerender } = render(<BoardActivityDrawer {...defaultProps} historyStatus="loading" />);
      const status = screen.getByText("", { selector: '[role="status"].sr-only' });
      expect(status).toHaveTextContent("");
      rerender(<BoardActivityDrawer {...defaultProps} historyStatus="ready" feed={feed} />);
      expect(status).toHaveTextContent("Loaded 2 recent activities");
      rerender(<BoardActivityDrawer {...defaultProps} historyStatus="ready" feed={[...feed, makeEntry()]} />);
      expect(status).toHaveTextContent("Loaded 2 recent activities");
      expect(screen.getByRole("region", { name: "Recent activity" })).not.toHaveAttribute("aria-live");
    });

    it("says when the feed cap cut the active window short, and not when the window is whole", () => {
      const feed = [makeEntry({ timestamp: hoursAgo(1) }), makeEntry({ timestamp: hoursAgo(3) })];
      const { rerender } = render(<BoardActivityDrawer {...defaultProps} feed={feed} truncated />);
      expect(screen.getByTestId("activity-feed-truncated")).toHaveTextContent("Showing the 100 most recent activities");
      openFilters();
      fireEvent.click(screen.getByRole("button", { name: "1h" }));
      expect(screen.queryByTestId("activity-feed-truncated")).not.toBeInTheDocument();
      rerender(<BoardActivityDrawer {...defaultProps} feed={feed} truncated={false} />);
      fireEvent.click(screen.getByRole("button", { name: "24h" }));
      expect(screen.queryByTestId("activity-feed-truncated")).not.toBeInTheDocument();
    });
  });

  // #2596 BLOCKER: the hosted demo's boards have no moves in the last day, so
  // a 24h default opened on an empty list with a week of history behind it.
  describe("auto-widen to 7 days (#2596)", () => {
    const weekOnly = [makeEntry({ actor: "@lastweek", timestamp: daysAgo(3) })];

    it("opens on 7d once history is in, when the last 24 hours are empty but the week is not", () => {
      const { rerender } = render(<BoardActivityDrawer {...defaultProps} historyStatus="loading" />);
      rerender(<BoardActivityDrawer {...defaultProps} historyStatus="ready" feed={weekOnly} />);
      expect(screen.getByText("lastweek")).toBeInTheDocument();
      expect(screen.getByTestId("activity-window-widened")).toHaveTextContent("Nothing in the last 24 hours. Showing the last 7 days.");
      // The widened window counts as an active filter, so the badge says so.
      openActiveFilters();
      expect(screen.getByRole("button", { name: "7d" })).toHaveAttribute("aria-pressed", "true");
    });

    it("stays on 24h when the last day has rows", () => {
      render(<BoardActivityDrawer {...defaultProps} feed={[makeEntry({ timestamp: hoursAgo(2) }), ...weekOnly]} />);
      expect(screen.queryByText("lastweek")).not.toBeInTheDocument();
      openFilters();
      expect(screen.getByRole("button", { name: "24h" })).toHaveAttribute("aria-pressed", "true");
    });

    it("never overrides a window the user chose, even an explicit 24h", () => {
      const { rerender } = render(<BoardActivityDrawer {...defaultProps} historyStatus="loading" />);
      openFilters();
      fireEvent.click(screen.getByRole("button", { name: "24h" }));
      rerender(<BoardActivityDrawer {...defaultProps} historyStatus="ready" feed={weekOnly} />);
      expect(screen.getByRole("button", { name: "24h" })).toHaveAttribute("aria-pressed", "true");
      expect(screen.getByText("No activity in the last 24 hours")).toBeInTheDocument();
      expect(screen.queryByTestId("activity-window-widened")).not.toBeInTheDocument();
    });

    it("widens once: going back to 24h is kept, and later rows do not flip it again", () => {
      const { rerender } = render(<BoardActivityDrawer {...defaultProps} feed={weekOnly} />);
      openActiveFilters();
      expect(screen.getByRole("button", { name: "7d" })).toHaveAttribute("aria-pressed", "true");
      fireEvent.click(screen.getByRole("button", { name: "24h" }));
      rerender(<BoardActivityDrawer {...defaultProps} feed={[...weekOnly, makeEntry({ actor: "@older", timestamp: daysAgo(4) })]} />);
      expect(screen.getByRole("button", { name: "24h" })).toHaveAttribute("aria-pressed", "true");
    });

    it("does not widen while history is still loading or after it failed", () => {
      const { rerender } = render(<BoardActivityDrawer {...defaultProps} historyStatus="loading" feed={weekOnly} />);
      openFilters();
      expect(screen.getByRole("button", { name: "24h" })).toHaveAttribute("aria-pressed", "true");
      rerender(<BoardActivityDrawer {...defaultProps} historyStatus="error" feed={weekOnly} />);
      expect(screen.getByRole("button", { name: "24h" })).toHaveAttribute("aria-pressed", "true");
    });
  });
});
