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
  imported_from_username: string | null;
}> = {}) {
  return {
    id: 1,
    kind: "activity" as const,
    ts: new Date(Date.now() - 3 * 60_000).toISOString(), // 3 min ago
    actor: { id: 1, username: "jdoe", display_name: "Jane Doe", avatar_url: "" },
    event_type: "priority_change",
    data: { from_value: "low", to_value: "high", event_type: "priority_change" },
    imported_from_username: null as string | null,
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

  it("defaults to Column moves filter — initial fetch includes event_types=move", async () => {
    mockGetTimeline.mockResolvedValue(makeTimelinePage([makeMoveEntry({ id: 1 })]));
    render(<ActivityTabPanel boardId={1} cardId={1} />);
    await waitFor(() => {
      const firstCall = mockGetTimeline.mock.calls[0];
      expect(firstCall[2]).toMatchObject({ event_types: "move" });
    });
    // Filter trigger label reflects the default selection
    expect(screen.getByRole("button", { name: /filter: column moves/i })).toBeInTheDocument();
  });

  it("shows filter-active empty state when default filter yields no results", async () => {
    // Card has no move events at all — default ["move"] filter returns empty
    mockGetTimeline.mockResolvedValue(makeTimelinePage([]));
    render(<ActivityTabPanel boardId={1} cardId={1} />);
    await waitFor(() => {
      expect(screen.getByText("No events match the current filter")).toBeInTheDocument();
    });
    expect(screen.getByText("Clear filter")).toBeInTheDocument();
  });

  it('"Clear filter" button empties the selection and re-fetches without event_types', async () => {
    mockGetTimeline.mockResolvedValue(makeTimelinePage([]));
    render(<ActivityTabPanel boardId={1} cardId={1} />);
    await waitFor(() => screen.getByText("Clear filter"));

    await userEvent.setup().click(screen.getByText("Clear filter"));
    await waitFor(() => {
      const lastCall = mockGetTimeline.mock.calls[mockGetTimeline.mock.calls.length - 1];
      expect(lastCall[2]).not.toHaveProperty("event_types");
    });
    // With selection now empty and no results, the generic empty-state message shows.
    expect(screen.getByText("No activity yet")).toBeInTheDocument();
  });

  it("unchecking Column moves from the default selection triggers an unfiltered re-fetch", async () => {
    mockGetTimeline.mockResolvedValue(makeTimelinePage([makeMoveEntry({ id: 1 })]));
    render(<ActivityTabPanel boardId={1} cardId={1} />);
    await waitFor(() => screen.getByText("To Do → In Progress"));

    // Initial call includes event_types=move
    expect(mockGetTimeline.mock.calls[0][2]).toMatchObject({ event_types: "move" });

    // Open dropdown; Column moves is pre-checked. Click to uncheck it.
    await userEvent.setup().click(screen.getByRole("button", { name: /filter/i }));
    const moveCheckbox = screen.getByLabelText("Column moves");
    expect(moveCheckbox).toBeChecked();
    await userEvent.setup().click(moveCheckbox);

    await waitFor(() => {
      const lastCall = mockGetTimeline.mock.calls[mockGetTimeline.mock.calls.length - 1];
      expect(lastCall[2]).not.toHaveProperty("event_types");
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

  describe("imported entries (#1675)", () => {
    const checklist = (id: number, text: string, imported: string | null) =>
      makeEntry({
        id,
        event_type: "checklist_item_added",
        data: { event_type: "checklist_item_added", from_value: "", to_value: text },
        imported_from_username: imported,
      });

    it("shows the source name next to the importer on moves and activities", async () => {
      mockGetTimeline.mockResolvedValue(
        makeTimelinePage([
          makeMoveEntry({ id: 1, imported_from_username: "carol" }),
          makeEntry({ id: 2, imported_from_username: "" }),
        ])
      );
      render(<ActivityTabPanel boardId={1} cardId={1} />);
      await waitFor(() => {
        expect(screen.getByText("by Jane Doe · imported, originally carol")).toBeInTheDocument();
      });
      expect(screen.getByText("by Jane Doe · imported")).toBeInTheDocument();
    });

    it("shows the note without a by-line when the importer is gone", async () => {
      mockGetTimeline.mockResolvedValue(
        makeTimelinePage([makeEntry({ id: 1, actor: null, imported_from_username: "carol" })])
      );
      render(<ActivityTabPanel boardId={1} cardId={1} />);
      await waitFor(() => {
        expect(screen.getByText("imported, originally carol")).toBeInTheDocument();
      });
    });

    it("keeps imported checklist entries out of a group of recorded ones", async () => {
      mockGetTimeline.mockResolvedValue(
        makeTimelinePage([
          checklist(1, "a", "carol"),
          checklist(2, "b", "carol"),
          checklist(3, "c", null),
        ])
      );
      render(<ActivityTabPanel boardId={1} cardId={1} />);
      await waitFor(() => {
        expect(screen.getByText('Added checklist items: "a", "b"')).toBeInTheDocument();
      });
      expect(screen.getByText('Added checklist item: "c"')).toBeInTheDocument();
      expect(screen.getByText("by Jane Doe · imported, originally carol")).toBeInTheDocument();
      expect(screen.getByText("by Jane Doe")).toBeInTheDocument();
    });
  });
});

// #1149
describe("ActivityTabPanel — manual block entries", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("labels blocked and unblocked activity with reason and resolution", async () => {
    mockGetTimeline.mockResolvedValue(
      makeTimelinePage([
        makeEntry({ id: 1, event_type: "blocked", data: { event_type: "blocked", from_value: "", to_value: "Waiting on legal" } }),
        makeEntry({ id: 2, event_type: "unblocked", data: { event_type: "unblocked", from_value: "Waiting on legal", to_value: "Signed", block_duration_seconds: 3 * 86400 + 5 * 3600 } }),
        makeEntry({ id: 3, event_type: "unblocked", data: { event_type: "unblocked", from_value: "Vendor", to_value: "" } }),
        makeEntry({ id: 4, event_type: "unblocked", data: { event_type: "unblocked", from_value: "", to_value: "" } }),
        makeEntry({ id: 5, event_type: "blocked", data: { event_type: "blocked", from_value: "", to_value: "" } }),
      ])
    );
    render(<ActivityTabPanel boardId={1} cardId={1} />);
    expect(await screen.findByText("Blocked: Waiting on legal")).toBeInTheDocument();
    expect(screen.getByText("Unblocked after 3d 5h: Signed")).toBeInTheDocument();
    expect(screen.getByText("Unblocked (was: Vendor)")).toBeInTheDocument();
    expect(screen.getByText("Unblocked")).toBeInTheDocument();
    expect(screen.getByText("Blocked")).toBeInTheDocument();
  });
});
