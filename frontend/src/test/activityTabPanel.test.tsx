import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import ActivityTabPanel from "../components/Card/ActivityTabPanel";

vi.mock("../api/cards", () => ({
  getCardTimeline: vi.fn(),
}));

import { getCardTimeline } from "../api/cards";
const mockGetTimeline = getCardTimeline as ReturnType<typeof vi.fn>;

function makeTimelinePage(
  results: ReturnType<typeof makeEntry>[],
  extra: Partial<{ count: number; next: string | null; previous: string | null }> = {}
) {
  return {
    count: results.length,
    next: null,
    previous: null,
    ...extra,
    results,
  };
}

function makeEntry(overrides: Partial<{
  id: number;
  kind: "move" | "activity";
  ts: string;
  actor: { id: number; username: string; display_name: string; avatar_url: string } | null;
  event_type: string;
  data: Record<string, unknown>;
}> = {}) {
  return {
    id: 1,
    kind: "activity" as const,
    ts: new Date(Date.now() - 3 * 60_000).toISOString(), // 3 min ago
    actor: { id: 1, username: "jdoe", display_name: "Jane Doe", avatar_url: "" },
    event_type: "priority_change",
    data: { from_value: "low", to_value: "high", event_type: "priority_change" },
    ...overrides,
  };
}

function makeMoveEntry(overrides: Partial<ReturnType<typeof makeEntry>> = {}) {
  return makeEntry({
    kind: "move",
    event_type: "move",
    data: {
      id: 1,
      from_column: 10,
      from_column_name: "To Do",
      to_column: 11,
      to_column_name: "In Progress",
      from_swimlane: 20,
      from_swimlane_name: "General",
      to_swimlane: 20,
      to_swimlane_name: "General",
      moved_at: new Date(Date.now() - 3 * 60_000).toISOString(),
      movement_type: "move",
    },
    ...overrides,
  });
}

describe("ActivityTabPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders loading state on initial load", () => {
    // Never resolves — keeps component in loading state
    mockGetTimeline.mockReturnValue(new Promise(() => {}));
    render(<ActivityTabPanel boardId={1} cardId={1} />);
    // The spinner wrapper is in the main content area; "Loading…" appears in both
    // the filter row count and the spinner. Check the spinner via its container.
    const spinners = screen.getAllByText("Loading…");
    expect(spinners.length).toBeGreaterThanOrEqual(1);
  });

  it("renders timeline entries after load", async () => {
    mockGetTimeline.mockResolvedValue(
      makeTimelinePage([makeEntry({ id: 1, event_type: "priority_change" })])
    );
    render(<ActivityTabPanel boardId={1} cardId={1} />);
    await waitFor(() => {
      expect(screen.getByText(/Priority: low → high/)).toBeInTheDocument();
    });
  });

  it('shows "Load more" button when hasMore is true', async () => {
    mockGetTimeline.mockResolvedValue(
      makeTimelinePage(
        [makeEntry({ id: 1 })],
        { count: 2, next: "/api/v1/boards/1/cards/1/timeline/?limit=50&offset=50" }
      )
    );
    render(<ActivityTabPanel boardId={1} cardId={1} />);
    await waitFor(() => {
      expect(screen.getByText("Load more")).toBeInTheDocument();
    });
  });

  it('"Load more" button disappears when all entries are loaded', async () => {
    mockGetTimeline.mockResolvedValue(
      makeTimelinePage([makeEntry({ id: 1 })], { count: 1, next: null })
    );
    render(<ActivityTabPanel boardId={1} cardId={1} />);
    await waitFor(() => {
      expect(screen.queryByText("Load more")).not.toBeInTheDocument();
    });
  });

  it("clicking Load more loads next page", async () => {
    const page1 = makeTimelinePage(
      [makeEntry({ id: 1 })],
      { count: 2, next: "/timeline/?limit=50&offset=50" }
    );
    const page2 = makeTimelinePage(
      [makeEntry({ id: 2, event_type: "weight_change", data: { from_value: "1", to_value: "3", event_type: "weight_change" } })],
      { count: 2, next: null }
    );
    mockGetTimeline.mockResolvedValueOnce(page1).mockResolvedValueOnce(page2);

    render(<ActivityTabPanel boardId={1} cardId={1} />);
    await waitFor(() => screen.getByText("Load more"));

    await userEvent.setup().click(screen.getByText("Load more"));
    await waitFor(() => {
      expect(screen.getByText(/Weight: 1 → 3/)).toBeInTheDocument();
      expect(screen.queryByText("Load more")).not.toBeInTheDocument();
    });
  });

  it("shows empty state when no entries and no filter active", async () => {
    mockGetTimeline.mockResolvedValue(makeTimelinePage([]));
    render(<ActivityTabPanel boardId={1} cardId={1} />);
    await waitFor(() => {
      expect(screen.getByText("No activity yet")).toBeInTheDocument();
    });
  });

  it("shows filter empty state when filter is active and no results", async () => {
    // First call (no filter) returns empty
    mockGetTimeline.mockResolvedValue(makeTimelinePage([]));
    render(<ActivityTabPanel boardId={1} cardId={1} />);
    await waitFor(() => {
      // With no filter and no entries — "No activity yet"
      expect(screen.getByText("No activity yet")).toBeInTheDocument();
    });

    // Open the filter dropdown and select "move"
    const filterBtn = screen.getByText("Filter");
    await userEvent.setup().click(filterBtn);
    const moveCheckbox = screen.getByLabelText("Column moves");
    await userEvent.setup().click(moveCheckbox);

    // Now component re-fetches with the filter
    await waitFor(() => {
      expect(screen.getByText("No events match the current filter")).toBeInTheDocument();
    });

    // "Clear filter" link should be visible
    expect(screen.getByText("Clear filter")).toBeInTheDocument();
  });

  it("filter dropdown changes event_types param", async () => {
    mockGetTimeline.mockResolvedValue(makeTimelinePage([makeMoveEntry({ id: 1 })]));
    render(<ActivityTabPanel boardId={1} cardId={1} />);
    await waitFor(() => screen.getByText("Filter"));

    // Verify initial call has no event_types filter
    expect(mockGetTimeline).toHaveBeenCalledWith(1, 1, expect.not.objectContaining({ event_types: expect.anything() }));

    // Select "move" filter
    await userEvent.setup().click(screen.getByText("Filter"));
    const moveCheckbox = screen.getByLabelText("Column moves");
    await userEvent.setup().click(moveCheckbox);

    await waitFor(() => {
      const lastCall = mockGetTimeline.mock.calls[mockGetTimeline.mock.calls.length - 1];
      expect(lastCall[2]).toMatchObject({ event_types: "move" });
    });
  });

  it("renders move entries with column transition text", async () => {
    mockGetTimeline.mockResolvedValue(
      makeTimelinePage([makeMoveEntry({ id: 1 })])
    );
    render(<ActivityTabPanel boardId={1} cardId={1} />);
    await waitFor(() => {
      expect(screen.getByText("To Do → In Progress")).toBeInTheDocument();
    });
  });
});
