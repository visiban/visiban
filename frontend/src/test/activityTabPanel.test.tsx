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
  kind: "move" | "activity" | "gate";
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

  it("keeps the assigner visible apart from a long override reason (#2594)", async () => {
    const reason = "R".repeat(300);
    mockGetTimeline.mockResolvedValue(
      makeTimelinePage([
        makeEntry({
          id: 7,
          event_type: "override_used",
          data: {
            event_type: "override_used",
            from_value: "assignee",
            to_value: "wip",
            item_text: reason,
            assigned_by: { id: 3, username: "bo", display_name: "Bo Lead", avatar_url: "" },
          },
        }),
      ])
    );
    render(<ActivityTabPanel boardId={1} cardId={1} />);
    const suffix = await screen.findByText(/Assigned by Bo Lead/);
    // The suffix is its own non-truncating span; the reason truncates beside it.
    expect(suffix).toHaveClass("shrink-0");
    expect(suffix).not.toHaveClass("truncate");
    expect(suffix.previousElementSibling).toHaveClass("truncate");
    expect(suffix.previousElementSibling).toHaveTextContent(reason);
    // The tooltip still carries the full text.
    expect(suffix.parentElement).toHaveAttribute("title", expect.stringContaining("Assigned by Bo Lead"));
    expect(suffix.parentElement).toHaveAttribute("title", expect.stringContaining(reason));
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

  describe("sub-column moves (#2365)", () => {
    const gateEntry = (id: number, over: Record<string, unknown> = {}) => makeEntry({
      id,
      kind: "gate",
      event_type: "gate_passed",
      data: {
        id, card_uid: "c", card_title: "C", column: 11, column_name: "Build", column_uid: "b",
        sub_column_name: "Review", sub_column_uid: "r", kind: "pass", from_index: 0, to_index: 1,
        reason: "", cause: "move", movement: null, actor: "jdoe", created_at: new Date().toISOString(),
        imported_from_username: null, ...over,
      },
    });

    it("renders a pass, a reopen and a stage remap, with the actor", async () => {
      mockGetTimeline.mockResolvedValue(makeTimelinePage([
        gateEntry(1),
        gateEntry(2, { kind: "reopen", sub_column_name: "Doing", to_index: 0 }),
        gateEntry(3, { kind: "reopen", sub_column_name: "", to_index: 1, cause: "stage_edited" }),
      ]));
      render(<ActivityTabPanel boardId={1} cardId={1} />);
      await waitFor(() => screen.getByText("Moved to Review in Build"));
      expect(screen.getByText("Moved back to Doing in Build")).toBeInTheDocument();
      expect(screen.getByText("Now in sub-column 2 in Build (stage edited)")).toBeInTheDocument();
      expect(screen.getAllByText(/Jane Doe/)).toHaveLength(3);
      // A sub-column move is not a column move: no time-spent line.
      expect(screen.queryByText(/Spent .* here/)).not.toBeInTheDocument();
    });

    it("a move into a stage shows the gate position it recorded", async () => {
      mockGetTimeline.mockResolvedValue(makeTimelinePage([
        makeMoveEntry({ id: 1, data: { ...makeMoveEntry().data, to_gates_passed: 2, from_gates_open: null } }),
      ]));
      render(<ActivityTabPanel boardId={1} cardId={1} />);
      expect(await screen.findByTestId("history-gate-note")).toHaveTextContent("entered at sub-column 3");
    });

    it("turning Sub-column moves off requests every other group", async () => {
      mockGetTimeline.mockResolvedValue(makeTimelinePage([gateEntry(1)]));
      render(<ActivityTabPanel boardId={1} cardId={1} />);
      await waitFor(() => screen.getByText("Moved to Review in Build"));
      await userEvent.setup().click(within(screen.getByRole("group", { name: "Show" })).getByRole("button", { name: /Sub-column moves/ }));
      await waitFor(() => expect(mockGetTimeline.mock.calls[mockGetTimeline.mock.calls.length - 1][2])
        .toMatchObject({ event_types: "move,comment,field,checklist,attachment,system" }));
    });
  });

  describe("type filter toggles (#967)", () => {
    const COUNTS = { move: 4, gate: 5, comment: 3, field: 2, checklist: 1, attachment: 0, system: 0 };
    const group = () => screen.getByRole("group", { name: "Show" });
    const toggle = (name: RegExp) => within(group()).getByRole("button", { name });
    const lastParams = () => mockGetTimeline.mock.calls[mockGetTimeline.mock.calls.length - 1][2];

    it("shows seven aria-pressed toggles, all on, and fetches unfiltered with counts", async () => {
      mockGetTimeline.mockResolvedValue({ ...makeTimelinePage([makeMoveEntry({ id: 1 })]), counts: COUNTS });
      render(<ActivityTabPanel boardId={1} cardId={1} />);
      await waitFor(() => screen.getByText("To Do → In Progress"));
      const params = mockGetTimeline.mock.calls[0][2];
      expect(params).not.toHaveProperty("event_types");
      expect(params).toMatchObject({ include_counts: true });
      const buttons = within(group()).getAllByRole("button");
      expect(buttons.map((b) => b.textContent)).toEqual([
        "Column moves 4", "Sub-column moves 5", "Comments 3", "Field changes 2", "Checklist 1", "Attachments 0", "System events 0",
      ]);
      buttons.forEach((b) => expect(b).toHaveAttribute("aria-pressed", "true"));
      expect(toggle(/Column moves/)).toHaveAccessibleName("Column moves, 4");
      // A real space between label and count keeps the visible text a whole-word match for the name (#2467).
      expect(toggle(/Column moves/).textContent).toBe("Column moves 4");
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
        expect(lastParams()).toMatchObject({ event_types: "move,gate,field,checklist,attachment,system", include_counts: true }));
      expect(toggle(/Comments/)).toHaveAttribute("aria-pressed", "false");
      expect(toggle(/Comments/).textContent).toBe("Comments 3");
      // Turning it back on restores the unfiltered request, in group order.
      await userEvent.setup().click(toggle(/Comments/));
      await waitFor(() => expect(lastParams()).not.toHaveProperty("event_types"));
    });

    it("keeps the last type on: it is aria-disabled with the reason and ignores clicks", async () => {
      mockGetTimeline.mockResolvedValue({ ...makeTimelinePage([]), counts: COUNTS });
      render(<ActivityTabPanel boardId={1} cardId={1} />);
      await waitFor(() => group());
      const user = userEvent.setup();
      for (const name of [/Sub-column moves/, /Comments/, /Field changes/, /Checklist/, /Attachments/, /System events/]) {
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
    const COUNTS = { move: 1, gate: 0, comment: 1, field: 0, checklist: 0, attachment: 0, system: 0 };
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
    const COUNTS = { move: 1, gate: 0, comment: 0, field: 0, checklist: 0, attachment: 0, system: 0 };

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

describe("ActivityTabPanel checklist assignee and due labels (#445)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders checklist_item_assigned and checklist_item_due_changed rows", async () => {
    (getCardTimeline as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeTimelinePage([
        makeEntry({ id: 1, event_type: "checklist_item_assigned", data: { from_value: "", to_value: "alex", event_type: "checklist_item_assigned" } }),
        makeEntry({ id: 2, event_type: "checklist_item_assigned", data: { from_value: "alex", to_value: "", event_type: "checklist_item_assigned" } }),
        makeEntry({ id: 3, event_type: "checklist_item_due_changed", data: { from_value: "", to_value: "2026-11-18", event_type: "checklist_item_due_changed" } }),
        makeEntry({ id: 4, event_type: "checklist_item_due_changed", data: { from_value: "2026-11-18", to_value: "", event_type: "checklist_item_due_changed" } }),
      ])
    );
    render(<ActivityTabPanel boardId={1} cardId={1} />);
    expect(await screen.findByText(/Checklist item assignee: \(none\) → alex/)).toBeInTheDocument();
    expect(screen.getByText(/Checklist item assignee: alex → \(none\)/)).toBeInTheDocument();
    expect(screen.getByText(/Checklist item due: \(none\) → \S*2026\S*/)).toBeInTheDocument();
    expect(screen.getByText(/Checklist item due: \S*2026\S* → \(none\)/)).toBeInTheDocument();
  });

  it("names the checklist item when the row carries item_text (#2199)", async () => {
    (getCardTimeline as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeTimelinePage([
        makeEntry({ id: 1, event_type: "checklist_item_assigned", data: { from_value: "", to_value: "alex", item_text: "Write tests", event_type: "checklist_item_assigned" } }),
        makeEntry({ id: 2, event_type: "checklist_item_due_changed", data: { from_value: "", to_value: "2026-11-18", item_text: "Ship it", event_type: "checklist_item_due_changed" } }),
        // An old row (pre-1.3) with item_text null keeps the unnamed label.
        makeEntry({ id: 3, event_type: "checklist_item_assigned", data: { from_value: "alex", to_value: "sam", item_text: null, event_type: "checklist_item_assigned" } }),
      ])
    );
    render(<ActivityTabPanel boardId={1} cardId={1} />);
    expect(await screen.findByText('Checklist item "Write tests" assignee: (none) → alex')).toBeInTheDocument();
    expect(screen.getByText(/^Checklist item "Ship it" due: \(none\) → \S*2026\S*$/)).toBeInTheDocument();
    expect(screen.getByText("Checklist item assignee: alex → sam")).toBeInTheDocument();
  });

  it("caps a long item name so the from → to values stay visible (#2199)", async () => {
    const long = "Write the integration tests for the importer and the exporter";
    (getCardTimeline as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeTimelinePage([
        makeEntry({ id: 1, event_type: "checklist_item_assigned", data: { from_value: "", to_value: "alex", item_text: long, event_type: "checklist_item_assigned" } }),
      ])
    );
    render(<ActivityTabPanel boardId={1} cardId={1} />);
    expect(
      await screen.findByText('Checklist item "Write the integration tests for the imp\u2026" assignee: (none) → alex')
    ).toBeInTheDocument();
  });
});

describe("ActivityTabPanel custom field change label (#1921)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("names the field and shows from → to, with (none) for empty values", async () => {
    const long = "A very long custom field name that overflows the row";
    (getCardTimeline as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeTimelinePage([
        makeEntry({ id: 1, event_type: "custom_field_changed", data: { from_value: "Open", to_value: "Done", item_text: "Security", event_type: "custom_field_changed" } }),
        makeEntry({ id: 2, event_type: "custom_field_changed", data: { from_value: "", to_value: "Done", item_text: "Docs", event_type: "custom_field_changed" } }),
        makeEntry({ id: 3, event_type: "custom_field_changed", data: { from_value: "Done", to_value: "", item_text: null, event_type: "custom_field_changed" } }),
        makeEntry({ id: 4, event_type: "custom_field_changed", data: { from_value: "a", to_value: "b", item_text: long, event_type: "custom_field_changed" } }),
      ])
    );
    render(<ActivityTabPanel boardId={1} cardId={1} />);
    expect(await screen.findByText("Security: Open → Done")).toBeInTheDocument();
    expect(screen.getByText("Docs: (none) → Done")).toBeInTheDocument();
    expect(screen.getByText("Custom field: Done → (none)")).toBeInTheDocument();
    expect(screen.getByText("A very long custom field name that over\u2026: a → b")).toBeInTheDocument();
  });

  it("shows the sub-column note on a move row, without the word gate (#2278)", async () => {
    const entry = makeMoveEntry();
    Object.assign(entry.data, { from_gates_open: 2, to_gates_passed: 1 });
    mockGetTimeline.mockResolvedValue(makeTimelinePage([entry]));
    render(<ActivityTabPanel boardId={1} cardId={1} />);
    const note = await screen.findByTestId("history-gate-note");
    expect(note).toHaveTextContent("left 2 sub-columns early, entered at sub-column 2");
    expect(note.textContent).not.toMatch(/gate/i);
  });

  it("shows no sub-column note on a plain move row (#2278)", async () => {
    mockGetTimeline.mockResolvedValue(makeTimelinePage([makeMoveEntry()]));
    render(<ActivityTabPanel boardId={1} cardId={1} />);
    await screen.findByText(/In Progress/);
    expect(screen.queryByTestId("history-gate-note")).toBeNull();
  });
});
