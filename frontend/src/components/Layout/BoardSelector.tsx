import { useEffect, useState } from "react";
import { listBoards, createBoard, deleteBoard } from "../../api/boards";
import type { Board, User } from "../../types";
import CreateBoardModal from "../Board/CreateBoardModal";

interface Props {
  user: User;
  onSelect: (board: Board) => void;
}

export default function BoardSelector({ user, onSelect }: Props) {
  const [boards, setBoards] = useState<Board[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null);
  const [deleteConfirmInput, setDeleteConfirmInput] = useState("");

  useEffect(() => {
    listBoards().then(setBoards).finally(() => setLoading(false));
  }, []);

  const handleDelete = async (boardId: number) => {
    setBoards((prev) => prev.filter((b) => b.id !== boardId));
    setConfirmDeleteId(null);
    setDeleteConfirmInput("");
    try {
      await deleteBoard(boardId);
    } catch {
      // rollback
      listBoards().then(setBoards);
    }
  };

  const handleCreate = async (name: string, template: string, swimlaneName: string, _setAsDefault: boolean) => {
    const board = await createBoard({ name, template, swimlane_name: swimlaneName });
    setBoards((prev) => [board, ...prev]);
    setCreating(false);
    onSelect(board);
  };

  return (
    <div className="min-h-screen bg-sunken flex items-center justify-center">
      <div className="w-full max-w-md">
        <h2 className="text-fg text-2xl font-bold mb-6 text-center">Your Boards</h2>

        {loading ? (
          <p className="text-fg-tertiary text-center">Loading…</p>
        ) : (
          <div className="flex flex-col gap-2 mb-4">
            {boards.map((b) => (
              <div key={b.id} className="group relative">
                <button
                  onClick={() => onSelect(b)}
                  className="w-full bg-surface hover:bg-surface-hover text-fg text-left px-4 py-3 rounded transition"
                >
                  <p className="font-medium">{b.name}</p>
                  {b.description && <p className="text-sm text-fg-tertiary mt-0.5">{b.description}</p>}
                </button>
                {b.owner.id === user.id && (
                  <button
                    onClick={(e) => { e.stopPropagation(); setConfirmDeleteId(b.id); setDeleteConfirmInput(""); }}
                    className="absolute right-3 top-1/2 -translate-y-1/2 opacity-0 group-hover:opacity-100 focus:opacity-100 transition text-fg-muted hover:text-danger focus:text-danger p-1 rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
                    title="Delete board"
                  >
                    <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
                      <path fillRule="evenodd" d="M9 2a1 1 0 00-.894.553L7.382 4H4a1 1 0 000 2v10a2 2 0 002 2h8a2 2 0 002-2V6a1 1 0 100-2h-3.382l-.724-1.447A1 1 0 0011 2H9zM7 8a1 1 0 012 0v6a1 1 0 11-2 0V8zm5-1a1 1 0 00-1 1v6a1 1 0 102 0V8a1 1 0 00-1-1z" clipRule="evenodd" />
                    </svg>
                  </button>
                )}
              </div>
            ))}
            {boards.length === 0 && !creating && (
              <p className="text-fg-muted text-center text-sm">No boards yet.</p>
            )}
          </div>
        )}

        <button
          onClick={() => setCreating(true)}
          className="w-full border border-dashed border-line-strong text-fg-tertiary hover:text-fg hover:border-line-emphasis py-3 rounded text-sm transition"
        >
          + New board
        </button>
      </div>

      {creating && (
        <CreateBoardModal
          onConfirm={handleCreate}
          onCancel={() => setCreating(false)}
        />
      )}

      {confirmDeleteId !== null && (() => {
        const board = boards.find((b) => b.id === confirmDeleteId);
        const hasCards = (board?.card_count ?? 0) > 0;
        const nameMatches = deleteConfirmInput === board?.name;
        const canDelete = !hasCards || nameMatches;
        return (
          <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
            <div className="bg-surface rounded-xl p-6 w-full max-w-sm shadow-xl">
              <h3 className="text-fg font-semibold text-lg mb-2">Delete board?</h3>
              <p className="text-fg-tertiary text-sm mb-1">
                <span className="text-fg font-medium">{board?.name}</span> and all its columns, swimlanes, cards, and history will be permanently deleted.
              </p>
              <p className="text-danger text-sm mb-4">This cannot be undone.</p>
              {hasCards && (
                <div className="mb-4">
                  <p className="text-fg-tertiary text-xs mb-2">
                    This board has <span className="text-fg font-medium">{board?.card_count} card{board?.card_count !== 1 ? "s" : ""}</span>. Type the board name to confirm deletion.
                  </p>
                  <input
                    type="text"
                    value={deleteConfirmInput}
                    onChange={(e) => setDeleteConfirmInput(e.target.value)}
                    placeholder={`Type "${board?.name}" to confirm`}
                    className="w-full bg-surface border border-line text-fg-secondary text-sm rounded px-3 py-1.5 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent placeholder-fg-muted"
                    autoFocus
                    onKeyDown={(e) => { if (e.key === "Escape") { setConfirmDeleteId(null); setDeleteConfirmInput(""); } }}
                  />
                </div>
              )}
              <div className="flex gap-3 justify-end">
                <button
                  onClick={() => { setConfirmDeleteId(null); setDeleteConfirmInput(""); }}
                  className="text-fg-tertiary text-sm hover:text-fg px-3 py-1.5"
                >
                  Cancel
                </button>
                <button
                  onClick={() => handleDelete(confirmDeleteId)}
                  disabled={!canDelete}
                  className="bg-red-600 hover:bg-red-700 disabled:opacity-40 disabled:cursor-not-allowed text-fg text-sm px-4 py-1.5 rounded font-medium transition focus:outline-none focus:ring-2 focus:ring-red-500"
                >
                  Delete
                </button>
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
}
