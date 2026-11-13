import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, render, screen, waitFor, within } from "@testing-library/react";
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

  describe("type filter toggles (#967)", () => {
    const COUNTS = { move: 4, comment: 3, field: 2, checklist: 1, attachment: 0, system: 0 };
    const group = () => screen.getByRole("group", { name: "Show" });
    const toggle = (name: RegExp) => within(group()).getByRole("button", { name });
    const lastParams = () => mockGetTimeline.mock.calls[mockGetTimeline.mock.calls.length - 1][2];

    it("shows six aria-pressed toggles, all on, and fetches unfiltered with counts", async () => {
      mockGetTimeline.mockResolvedValue({ ...makeTimelinePage([makeMoveEntry({ id: 1 })]), counts: COUNTS });
      render(<ActivityTabPanel boardId={1} cardId={1} />);
      await waitFor(() => screen.getByText("To Do → In Progress"));
      const params = mockGetTimeline.mock.calls[0][2];
      expect(params).not.toHaveProperty("event_types");
      expect(params).toMatchObject({ include_counts: true });
      const buttons = within(group()).getAllByRole("button");
      expect(buttons.map((b) => b.textContent)).toEqual([
        "Column moves4", "Comments3", "Field changes2", "Checklist1", "Attachments0", "System events0",
      ]);
      buttons.forEach((b) => expect(b).toHaveAttribute("aria-pressed", "true"));
      expect(toggle(/Column moves/)).toHaveAccessibleName("Column moves, 4");
      expect(screen.getByRole("status")).toHaveTextContent("1 event");
      // The dropdown is gone.
      expect(screen.queryByRole("button", { name: /^filter/i })).not.toBeInTheDocument();
    });

    it("shows no count while counts are unknown, never 0", async () => {
      mockGetTimeline.mockResolvedValue(makeTimelinePage([makeMoveEntry({ id: 1 })]));
      render(<ActivityTabPanel boardId={1} cardId={1} />);
      await waitFor(() => screen.getByText("To Do → In Progress"));
      expect(toggle(/Comments/).textContent).toBe("Comments");
    });

    it("turning a type off re-fetches with the remaining groups, keeping each count", async () => {
      mockGetTimeline.mockResolvedValue({ ...makeTimelinePage([makeMoveEntry({ id: 1 })]), counts: COUNTS });
      render(<ActivityTabPanel boardId={1} cardId={1} />);
      await waitFor(() => screen.getByText("To Do → In Progress"));
      await userEvent.setup().click(toggle(/Comments/));
      await waitFor(() =>
        expect(lastParams()).toMatchObject({ event_types: "move,field,checklist,attachment,system", include_counts: true }));
      expect(toggle(/Comments/)).toHaveAttribute("aria-pressed", "false");
      expect(toggle(/Comments/).textContent).toBe("Comments3");
      // Turning it back on restores the unfiltered request, in group order.
      await userEvent.setup().click(toggle(/Comments/));
      await waitFor(() => expect(lastParams()).not.toHaveProperty("event_types"));
    });

    it("keeps the last type on: it is aria-disabled with the reason and ignores clicks", async () => {
      mockGetTimeline.mockResolvedValue({ ...makeTimelinePage([]), counts: COUNTS });
      render(<ActivityTabPanel boardId={1} cardId={1} />);
      await waitFor(() => group());
      const user = userEvent.setup();
      for (const name of [/Comments/, /Field changes/, /Checklist/, /Attachments/, /System events/]) {
        await user.click(toggle(name));
      }
      await waitFor(() => expect(lastParams()).toMatchObject({ event_types: "move" }));
      const moves = toggle(/Column moves/);
      expect(moves).toHaveAttribute("aria-pressed", "true");
      expect(moves).toHaveAttribute("aria-disabled", "true");
      expect(moves).toHaveAttribute("title", "At least one type stays shown");
      expect(moves).toHaveAccessibleDescription("At least one type stays shown");
      const calls = mockGetTimeline.mock.calls.length;
      await user.click(moves);
      expect(moves).toHaveAttribute("aria-pressed", "true");
      expect(mockGetTimeline.mock.calls.length).toBe(calls);
      // Another type on again: Column moves is no longer the last one.
      await user.click(toggle(/Comments/));
      expect(toggle(/Column moves/)).not.toHaveAttribute("aria-disabled");
    });

    it("a filtered empty result offers Show all types, which turns every type back on", async () => {
      mockGetTimeline.mockResolvedValue(makeTimelinePage([]));
      render(<ActivityTabPanel boardId={1} cardId={1} />);
      await waitFor(() => screen.getByText("No activity yet"));
      await userEvent.setup().click(toggle(/Column moves/));
      await waitFor(() => screen.getByText("No events match the current filter"));
      await userEvent.setup().click(screen.getByRole("button", { name: "Show all types" }));
      await waitFor(() => expect(lastParams()).not.toHaveProperty("event_types"));
      expect(toggle(/Column moves/)).toHaveAttribute("aria-pressed", "true");
    });
  });

  describe("stale responses are dropped (#967)", () => {
    const COUNTS = { move: 1, comment: 1, field: 0, checklist: 0, attachment: 0, system: 0 };
    const deferred = <T,>() => {
      let resolve!: (v: T) => void;
      const promise = new Promise<T>((r) => { resolve = r; });
      return { promise, resolve };
    };

    it("a late filtered response cannot overwrite the unfiltered list after toggling off then on", async () => {
      const page = {
        ...makeTimelinePage([makeMoveEntry({ id: 1 }), makeEntry({ id: 2 })], { count: 2 }),
        counts: COUNTS,
      };
      const filtered = deferred<typeof page>();
      mockGetTimeline.mockReturnValue(filtered.promise);
      render(<ActivityTabPanel boardId={1} cardId={1} initialPage={page} />);
      const user = userEvent.setup();
      const comments = () => within(screen.getByRole("group", { name: "Show" })).getByRole("button", { name: /Comments/ });
      await user.click(comments());
      await user.click(comments());
      expect(mockGetTimeline).toHaveBeenCalledTimes(1);
      filtered.resolve({ ...makeTimelinePage([makeEntry({ id: 2 })], { count: 1 }), counts: COUNTS });
      await act(async () => { await filtered.promise; });
      expect(screen.getByRole("status")).toHaveTextContent("2 events");
      expect(screen.getByText("To Do → In Progress")).toBeInTheDocument();
      expect(screen.getByText("Priority: low → high")).toBeInTheDocument();
      within(screen.getByRole("group", { name: "Show" })).getAllByRole("button")
        .forEach((b) => expect(b).toHaveAttribute("aria-pressed", "true"));
    });

    it("a late load-more response is dropped after the filter changes", async () => {
      const page1 = makeTimelinePage([makeMoveEntry({ id: 1 })], { count: 2, next: "/timeline/?offset=50" });
      const more = deferred<typeof page1>();
      mockGetTimeline
        .mockResolvedValueOnce({ ...page1, counts: COUNTS })
        .mockReturnValueOnce(more.promise)
        .mockResolvedValueOnce({ ...makeTimelinePage([makeMoveEntry({ id: 1 })], { count: 1 }), counts: COUNTS });
      render(<ActivityTabPanel boardId={1} cardId={1} />);
      await waitFor(() => screen.getByText("Load more"));
      const user = userEvent.setup();
      await user.click(screen.getByText("Load more"));
      await user.click(within(screen.getByRole("group", { name: "Show" })).getByRole("button", { name: /Comments/ }));
      await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("1 event"));
      more.resolve({ ...makeTimelinePage([makeEntry({ id: 2 })], { count: 2 }) });
      await act(async () => { await more.promise; });
      expect(screen.queryByText("Priority: low → high")).not.toBeInTheDocument();
      expect(screen.getByRole("status")).toHaveTextContent("1 event");
    });
  });

  describe("first page from CardDetail (#967)", () => {
    const COUNTS = { move: 1, comment: 0, field: 0, checklist: 0, attachment: 0, system: 0 };

    it("uses initialPage instead of fetching, and adopts a refetched one", async () => {
      const page = { ...makeTimelinePage([makeMoveEntry({ id: 1 })]), counts: COUNTS };
      const { rerender } = render(<ActivityTabPanel boardId={1} cardId={1} initialPage={page} />);
      expect(screen.getByText("To Do → In Progress")).toBeInTheDocument();
      expect(mockGetTimeline).not.toHaveBeenCalled();
      const next = { ...makeTimelinePage([makeEntry({ id: 9 })]), counts: { ...COUNTS, field: 1 } };
      rerender(<ActivityTabPanel boardId={1} cardId={1} initialPage={next} />);
      await waitFor(() => screen.getByText("Priority: low → high"));
      expect(mockGetTimeline).not.toHaveBeenCalled();
    });

    it("a filtered view re-fetches on refreshSignal and reports its first page", async () => {
      const page = { ...makeTimelinePage([makeMoveEntry({ id: 1 })]), counts: COUNTS };
      mockGetTimeline.mockResolvedValue(page);
      const onFirstPage = vi.fn();
      const { rerender } = render(<ActivityTabPanel boardId={1} cardId={1} initialPage={page} onFirstPage={onFirstPage} />);
      await userEvent.setup().click(screen.getByRole("button", { name: /Comments/ }));
      await waitFor(() => expect(mockGetTimeline).toHaveBeenCalledTimes(1));
      await waitFor(() => expect(onFirstPage).toHaveBeenCalledWith(page));
      rerender(<ActivityTabPanel boardId={1} cardId={1} initialPage={page} onFirstPage={onFirstPage} refreshSignal={1} />);
      await waitFor(() => expect(mockGetTimeline).toHaveBeenCalledTimes(2));
    });

    it("focuses the newest entry when asked, once", async () => {
      const page = { ...makeTimelinePage([makeMoveEntry({ id: 1 }), makeEntry({ id: 2 })]), counts: COUNTS };
      const onFocused = vi.fn();
      render(<ActivityTabPanel boardId={1} cardId={1} initialPage={page} focusFirstEntry onFirstEntryFocused={onFocused} />);
      await waitFor(() => expect(onFocused).toHaveBeenCalledTimes(1));
      expect(document.activeElement).toBe(screen.getAllByRole("listitem")[0]);
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
