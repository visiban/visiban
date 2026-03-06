import { useEffect, useState } from "react";
import { listBoards, createBoard, deleteBoard } from "../../api/boards";
import type { Board, User } from "../../types";

interface Props {
  user: User;
  onSelect: (board: Board) => void;
}

export default function BoardSelector({ user, onSelect }: Props) {
  const [boards, setBoards] = useState<Board[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null);

  useEffect(() => {
    listBoards().then(setBoards).finally(() => setLoading(false));
  }, []);

  const handleDelete = async (boardId: number) => {
    setBoards((prev) => prev.filter((b) => b.id !== boardId));
    setConfirmDeleteId(null);
    try {
      await deleteBoard(boardId);
    } catch {
      // rollback
      listBoards().then(setBoards);
    }
  };

  const handleCreate = async () => {
    if (!name.trim()) return;
    const board = await createBoard({ name: name.trim() });
    setBoards((prev) => [board, ...prev]);
    setName("");
    setCreating(false);
    onSelect(board);
  };

  return (
    <div className="min-h-screen bg-gray-900 flex items-center justify-center">
      <div className="w-full max-w-md">
        <h2 className="text-white text-2xl font-bold mb-6 text-center">Your Boards</h2>

        {loading ? (
          <p className="text-gray-400 text-center">Loading…</p>
        ) : (
          <div className="flex flex-col gap-2 mb-4">
            {boards.map((b) => (
              <div key={b.id} className="group relative">
                <button
                  onClick={() => onSelect(b)}
                  className="w-full bg-gray-800 hover:bg-gray-700 text-white text-left px-4 py-3 rounded-xl transition"
                >
                  <p className="font-medium">{b.name}</p>
                  {b.description && <p className="text-sm text-gray-400 mt-0.5">{b.description}</p>}
                </button>
                {b.owner.id === user.id && (
                  <button
                    onClick={(e) => { e.stopPropagation(); setConfirmDeleteId(b.id); }}
                    className="absolute right-3 top-1/2 -translate-y-1/2 opacity-0 group-hover:opacity-100 transition text-gray-500 hover:text-red-400 p-1"
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
              <p className="text-gray-500 text-center text-sm">No boards yet.</p>
            )}
          </div>
        )}

        {creating ? (
          <div className="bg-gray-800 rounded-xl p-4">
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") handleCreate(); if (e.key === "Escape") setCreating(false); }}
              placeholder="Board name…"
              className="w-full bg-gray-700 text-white rounded-lg px-3 py-2 outline-none text-sm mb-3"
            />
            <div className="flex gap-2">
              <button onClick={handleCreate} className="bg-blue-600 text-white text-sm px-3 py-1.5 rounded-lg hover:bg-blue-700">
                Create
              </button>
              <button onClick={() => setCreating(false)} className="text-gray-400 text-sm hover:text-white">
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <button
            onClick={() => setCreating(true)}
            className="w-full border border-dashed border-gray-600 text-gray-400 hover:text-white hover:border-gray-400 py-3 rounded-xl text-sm transition"
          >
            + New board
          </button>
        )}
      </div>

      {confirmDeleteId !== null && (() => {
        const board = boards.find((b) => b.id === confirmDeleteId);
        return (
          <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
            <div className="bg-gray-800 rounded-xl p-6 w-full max-w-sm shadow-xl">
              <h3 className="text-white font-semibold text-lg mb-2">Delete board?</h3>
              <p className="text-gray-400 text-sm mb-1">
                <span className="text-white font-medium">{board?.name}</span> and all its columns, swimlanes, cards, and history will be permanently deleted.
              </p>
              <p className="text-red-400 text-sm mb-5">This cannot be undone.</p>
              <div className="flex gap-3 justify-end">
                <button
                  onClick={() => setConfirmDeleteId(null)}
                  className="text-gray-400 text-sm hover:text-white px-3 py-1.5"
                >
                  Cancel
                </button>
                <button
                  onClick={() => handleDelete(confirmDeleteId)}
                  className="bg-red-600 hover:bg-red-700 text-white text-sm px-4 py-1.5 rounded-lg"
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
