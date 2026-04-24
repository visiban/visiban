import { act, render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { MemoryRouter } from "react-router-dom";
import GlobalCommandPalette from "../components/Common/GlobalCommandPalette";
import { BoardProvider } from "../contexts/BoardContext";
import type { BoardFull } from "../types";

// #869 — the command palette is hoisted to the authenticated-shell level
// so ⌘K fires on every route and sub-tab. These tests exercise the shell
// wrapper specifically; the inner CommandPalette is covered by
// commandPalette.test.tsx.

// Mock listBoards — the palette fetches boards on open regardless of mode.
vi.mock("../api/boards", () => ({
  listBoards: vi.fn(() =>
    Promise.resolve([
      { id: 1, name: "Q2 Roadmap", group_name: "Platform", uid: "b1" },
      { id: 2, name: "Login & Onboarding", group_name: "Auth", uid: "b2" },
    ])
  ),
  getBoardFull: vi.fn(() => Promise.reject(new Error("not used in these tests"))),
}));

// Shared return value for the useBoard mock — mutated per test so board-mode
// and off-board-mode cases can share a single vi.mock factory. In vi.mock's
// factory callback the module is captured eagerly, so using a vi.fn() lets
// us reassign the return value later via `useBoardMock.mockReturnValue(...)`.
import type { BoardContextType } from "../contexts/BoardContext";

function emptyBoardContext(): BoardContextType {
  return {
    board: null,
    loading: false,
    error: null,
    reload: vi.fn(),
    silentReload: vi.fn(),
    moveCard: vi.fn(),
    forceMoveCard: vi.fn(),
    moveError: null,
    clearMoveError: vi.fn(),
    addCard: vi.fn(),
    removeCard: vi.fn(),
    addColumn: vi.fn(),
    removeColumn: vi.fn(),
    addSwimlane: vi.fn(),
    updateCard: vi.fn(),
    updateColumn: vi.fn(),
    addLabel: vi.fn(),
    updateLabel: vi.fn(),
    removeLabel: vi.fn(),
    addMember: vi.fn(),
    updateMember: vi.fn(),
    removeMember: vi.fn(),
    applyColumnOrder: vi.fn(),
    applySwimlaneOrder: vi.fn(),
    reorderColumns: vi.fn(),
    reorderSwimlanes: vi.fn(),
    updateSwimlane: vi.fn(),
    removeSwimlane: vi.fn(),
    updateBoardSettings: vi.fn(),
    evictColumn: vi.fn(),
    evictSwimlane: vi.fn(),
    evictCardByUid: vi.fn(),
    mergeBoardState: vi.fn(),
  };
}

vi.mock("../hooks/useBoard", () => ({
  useBoard: vi.fn(() => emptyBoardContext()),
}));

beforeEach(() => {
  vi.clearAllMocks();
});

// Helper: render the palette at a given route. No BoardProvider ⇒ off-board mode.
function renderOffBoard(initialRoute: string) {
  return render(
    <MemoryRouter initialEntries={[initialRoute]}>
      <GlobalCommandPalette />
    </MemoryRouter>
  );
}

describe("GlobalCommandPalette — shell wiring", () => {
  it("⌘K opens the palette on the Dashboard route", () => {
    renderOffBoard("/");
    expect(screen.queryByLabelText("Command palette search")).not.toBeInTheDocument();
    fireEvent.keyDown(document, { key: "k", metaKey: true });
    expect(screen.getByLabelText("Command palette search")).toBeInTheDocument();
  });

  it("Ctrl+K opens the palette on a Group route", () => {
    renderOffBoard("/groups/42");
    fireEvent.keyDown(document, { key: "k", ctrlKey: true });
    expect(screen.getByLabelText("Command palette search")).toBeInTheDocument();
  });

  it("⌘K opens the palette on the Settings route", () => {
    renderOffBoard("/settings");
    fireEvent.keyDown(document, { key: "K", metaKey: true });
    expect(screen.getByLabelText("Command palette search")).toBeInTheDocument();
  });

  it("⌘K opens the palette on the Admin route", () => {
    renderOffBoard("/admin");
    fireEvent.keyDown(document, { key: "k", metaKey: true });
    expect(screen.getByLabelText("Command palette search")).toBeInTheDocument();
  });

  it("⌘K toggles: pressing twice opens then closes", () => {
    renderOffBoard("/");
    fireEvent.keyDown(document, { key: "k", metaKey: true });
    expect(screen.getByLabelText("Command palette search")).toBeInTheDocument();
    fireEvent.keyDown(document, { key: "k", metaKey: true });
    expect(screen.queryByLabelText("Command palette search")).not.toBeInTheDocument();
  });

  it("⌘K fires even when focus is inside a text input (palette is itself a typing surface)", () => {
    renderOffBoard("/");
    const synthInput = document.createElement("input");
    document.body.appendChild(synthInput);
    synthInput.focus();
    fireEvent.keyDown(synthInput, { key: "k", metaKey: true });
    expect(screen.getByLabelText("Command palette search")).toBeInTheDocument();
    document.body.removeChild(synthInput);
  });

  it("bare `k` (no modifier) does NOT open the palette", () => {
    renderOffBoard("/");
    fireEvent.keyDown(document, { key: "k" });
    expect(screen.queryByLabelText("Command palette search")).not.toBeInTheDocument();
  });

  it("visiban:open-palette window event opens the palette", () => {
    renderOffBoard("/");
    expect(screen.queryByLabelText("Command palette search")).not.toBeInTheDocument();
    act(() => {
      window.dispatchEvent(new CustomEvent("visiban:open-palette"));
    });
    expect(screen.getByLabelText("Command palette search")).toBeInTheDocument();
  });
});

describe("GlobalCommandPalette — off-board mode (no BoardProvider)", () => {
  it("shows the jump-to-board placeholder on the Dashboard", () => {
    renderOffBoard("/");
    fireEvent.keyDown(document, { key: "k", metaKey: true });
    expect(screen.getByPlaceholderText(/jump to board/i)).toBeInTheDocument();
  });

  it("shows the generic jump placeholder on Settings/Admin", () => {
    renderOffBoard("/settings");
    fireEvent.keyDown(document, { key: "k", metaKey: true });
    expect(screen.getByPlaceholderText(/jump to…/i)).toBeInTheDocument();
  });

  it("lists boards (fetched via listBoards) in the results", async () => {
    renderOffBoard("/");
    fireEvent.keyDown(document, { key: "k", metaKey: true });
    await waitFor(() => {
      expect(screen.getByText("Q2 Roadmap")).toBeInTheDocument();
      expect(screen.getByText("Login & Onboarding")).toBeInTheDocument();
    });
  });

  it("does NOT surface board-scoped actions off-board (Filter: assigned to me, Open full history, Open board settings)", async () => {
    renderOffBoard("/");
    fireEvent.keyDown(document, { key: "k", metaKey: true });
    await waitFor(() => {
      expect(screen.getByText("Q2 Roadmap")).toBeInTheDocument();
    });
    expect(screen.queryByText("Filter: assigned to me")).not.toBeInTheDocument();
    expect(screen.queryByText("Open full history")).not.toBeInTheDocument();
    expect(screen.queryByText("Open board settings")).not.toBeInTheDocument();
  });

  it("surfaces the route-agnostic Show keyboard shortcuts action off-board", async () => {
    renderOffBoard("/");
    fireEvent.keyDown(document, { key: "k", metaKey: true });
    await waitFor(() => {
      expect(screen.getByText("Show keyboard shortcuts")).toBeInTheDocument();
    });
  });
});

describe("GlobalCommandPalette — board mode (inside BoardProvider)", () => {
  // A minimal BoardFull stub good enough for the palette to render card
  // results. We stub useBoard above; instead of the hook's default return,
  // this test re-stubs it per-case via the doMock pattern.
  const boardFixture: BoardFull = {
    id: 5,
    uid: "bd-5",
    name: "Test Board",
    group: null,
    group_name: null,
    is_starred: false,
    current_user_role: "admin",
    cards: [
      {
        id: 100,
        uid: "c-100",
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
      },
    ],
    columns: [{ id: 10, uid: "col-10", name: "In Progress" } as never],
    swimlanes: [],
    labels: [],
    memberships: [],
    is_wip_hard_enforced: false,
    // Minimum other fields — cast to any because BoardFull has many fields we
    // don't need to realistically populate for the palette to render.
  } as unknown as BoardFull;

  it("surfaces board-scoped actions and cards when the board context is populated", async () => {
    const { useBoard } = await import("../hooks/useBoard");
    vi.mocked(useBoard).mockReturnValue({ ...emptyBoardContext(), board: boardFixture });

    render(
      <MemoryRouter initialEntries={["/boards/5"]}>
        <BoardProvider>
          <GlobalCommandPalette />
        </BoardProvider>
      </MemoryRouter>
    );
    fireEvent.keyDown(document, { key: "k", metaKey: true });

    // Placeholder reflects the board surface.
    expect(screen.getByPlaceholderText(/search cards/i)).toBeInTheDocument();

    // Board card is listed under Cards section.
    expect(screen.getByText("Fix login redirect loop")).toBeInTheDocument();

    // Board-scoped actions are visible.
    expect(screen.getByText("Filter: assigned to me")).toBeInTheDocument();
    expect(screen.getByText("Open board settings")).toBeInTheDocument();
  });

  it("dispatches visiban:open-card when a card result is activated", async () => {
    const { useBoard } = await import("../hooks/useBoard");
    vi.mocked(useBoard).mockReturnValue({ ...emptyBoardContext(), board: boardFixture });

    const spy = vi.fn();
    window.addEventListener("visiban:open-card", spy as EventListener);

    render(
      <MemoryRouter initialEntries={["/boards/5"]}>
        <BoardProvider>
          <GlobalCommandPalette />
        </BoardProvider>
      </MemoryRouter>
    );
    fireEvent.keyDown(document, { key: "k", metaKey: true });
    fireEvent.click(screen.getByText("Fix login redirect loop"));

    expect(spy).toHaveBeenCalledTimes(1);
    const event = spy.mock.calls[0][0] as CustomEvent<{ cardId: number }>;
    expect(event.detail.cardId).toBe(100);

    window.removeEventListener("visiban:open-card", spy as EventListener);
  });
});
