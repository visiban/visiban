/**
 * ⌘K board preset commands (#1146): "Apply preset: …" and "Reset to preset: …",
 * built from the active preset that BoardView publishes, and dispatched as the
 * `visiban:preset-command` window event that BoardView turns into a picker apply.
 */
import { act, render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { MemoryRouter } from "react-router-dom";
import GlobalCommandPalette from "../components/Common/GlobalCommandPalette";
import { BoardProvider } from "../contexts/BoardContext";
import type { BoardContextType } from "../contexts/BoardContext";
import type { BoardFull } from "../types";
import { publishActivePreset } from "../boardPresets/activePresetStore";

vi.mock("../api/boards", () => ({
  listBoards: vi.fn(() => Promise.resolve([])),
  getBoardFull: vi.fn(() => Promise.reject(new Error("not used"))),
}));

function emptyBoardContext(): BoardContextType {
  return {
    board: null,
    loading: false,
    error: null,
    unavailable: false,
    reload: vi.fn(),
    silentReload: vi.fn(),
    moveCard: vi.fn(),
    forceMoveCard: vi.fn(), forceMoveCardTo: vi.fn(),
    moveError: null,
    clearMoveError: vi.fn(),
    addCard: vi.fn(),
    removeCard: vi.fn(),
    archiveCard: vi.fn(),
    archiveCardByUid: vi.fn(),
    unarchiveCard: vi.fn(),
    addColumn: vi.fn(),
    removeColumn: vi.fn(),
    addSwimlane: vi.fn(),
    updateCard: vi.fn(),
    updateColumn: vi.fn(),
    addLabel: vi.fn(),
    updateLabel: vi.fn(),
    removeLabel: vi.fn(),
    applyCustomFieldDefinitions: vi.fn(),
    applySwimlaneFieldDefinitions: vi.fn(),
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

const board = {
  id: 5, uid: "bd-5", name: "Test Board", group: null, group_name: null, is_starred: false,
  current_user_role: "member", cards: [], columns: [], swimlanes: [], labels: [], default_preset: null,
} as unknown as BoardFull;

async function renderOnBoard(route = "/boards/5") {
  const { useBoard } = await import("../hooks/useBoard");
  vi.mocked(useBoard).mockReturnValue({ ...emptyBoardContext(), unavailable: false, board, getLastFullFetchAt: () => null });
  render(
    <MemoryRouter initialEntries={[route]}>
      <BoardProvider>
        <GlobalCommandPalette />
      </BoardProvider>
    </MemoryRouter>,
  );
  fireEvent.keyDown(document, { key: "k", metaKey: true });
}

function actionLabels(): string[] {
  return screen.queryAllByText(/^(Apply preset|Reset to preset): /).map((el) => el.textContent ?? "");
}

describe("GlobalCommandPalette — board preset commands (#1146)", () => {
  const spy = vi.fn();
  beforeEach(() => {
    vi.clearAllMocks();
    window.addEventListener("visiban:preset-command", spy as EventListener);
  });
  afterEach(() => {
    window.removeEventListener("visiban:preset-command", spy as EventListener);
    act(() => publishActivePreset(null));
  });

  it("offers both presets when none is active", async () => {
    act(() => publishActivePreset({ boardId: 5, activePresetId: null, modified: false }));
    await renderOnBoard();
    expect(actionLabels()).toEqual(["Apply preset: Classic", "Apply preset: Default"]);
  });

  it("does not offer the active, unmodified preset", async () => {
    act(() => publishActivePreset({ boardId: 5, activePresetId: "default", modified: false }));
    await renderOnBoard();
    expect(actionLabels()).toEqual(["Apply preset: Classic"]);
  });

  it("offers a reset for a modified preset instead of re-applying it", async () => {
    act(() => publishActivePreset({ boardId: 5, activePresetId: "classic", modified: true }));
    await renderOnBoard();
    expect(actionLabels()).toEqual(["Apply preset: Default", "Reset to preset: Classic"]);
  });

  it("ignores a snapshot published for another board", async () => {
    act(() => publishActivePreset({ boardId: 99, activePresetId: "classic", modified: true }));
    await renderOnBoard();
    expect(actionLabels()).toEqual(["Apply preset: Classic", "Apply preset: Default"]);
  });

  it("dispatches apply and reset commands", async () => {
    act(() => publishActivePreset({ boardId: 5, activePresetId: "classic", modified: true }));
    await renderOnBoard();
    fireEvent.click(screen.getByText("Apply preset: Default"));
    expect((spy.mock.calls[0][0] as CustomEvent).detail).toEqual({ kind: "apply", presetId: "default" });
    fireEvent.keyDown(document, { key: "k", metaKey: true });
    fireEvent.click(screen.getByText("Reset to preset: Classic"));
    expect((spy.mock.calls[1][0] as CustomEvent).detail).toEqual({ kind: "reset" });
  });

  it("filters the commands by the typed query", async () => {
    await renderOnBoard();
    fireEvent.change(screen.getByPlaceholderText(/search cards/i), { target: { value: "apply preset: cla" } });
    expect(actionLabels()).toEqual(["Apply preset: Classic"]);
  });

  it("hides preset commands while a card target is active (#2059)", async () => {
    act(() => publishActivePreset({ boardId: 5, activePresetId: null, modified: false }));
    const face = document.createElement("div");
    face.setAttribute("data-card-id", "100");
    face.tabIndex = 0;
    document.body.appendChild(face);
    face.focus();
    const onQuery = (ev: Event) => {
      const detail = (ev as CustomEvent).detail;
      detail.response = {
        cardIds: [100], source: "focused", summary: "A card",
        actions: [{ id: "archive", label: "Archive card", enabled: true }],
      };
    };
    window.addEventListener("visiban:card-target-query", onQuery);
    try {
      const { useBoard } = await import("../hooks/useBoard");
      vi.mocked(useBoard).mockReturnValue({ ...emptyBoardContext(), unavailable: false, board, getLastFullFetchAt: () => null });
      render(
        <MemoryRouter initialEntries={["/boards/5"]}>
          <BoardProvider>
            <GlobalCommandPalette />
          </BoardProvider>
        </MemoryRouter>,
      );
      fireEvent.keyDown(face, { key: "k", metaKey: true });
      expect(screen.getByRole("option", { name: /^Archive card/ })).toBeInTheDocument();
      expect(actionLabels()).toEqual([]);
    } finally {
      window.removeEventListener("visiban:card-target-query", onQuery);
      face.remove();
    }
  });

  it("offers no preset commands off-board", async () => {
    render(
      <MemoryRouter initialEntries={["/"]}>
        <GlobalCommandPalette />
      </MemoryRouter>,
    );
    fireEvent.keyDown(document, { key: "k", metaKey: true });
    expect(actionLabels()).toEqual([]);
  });
});
