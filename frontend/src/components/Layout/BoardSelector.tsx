import { useEffect, useState } from "react";
import { listBoards, createBoard } from "../../api/boards";
import type { Board } from "../../types";

interface Props {
  onSelect: (board: Board) => void;
}

export default function BoardSelector({ onSelect }: Props) {
  const [boards, setBoards] = useState<Board[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");

  useEffect(() => {
    listBoards().then(setBoards).finally(() => setLoading(false));
  }, []);

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
              <button
                key={b.id}
                onClick={() => onSelect(b)}
                className="bg-gray-800 hover:bg-gray-700 text-white text-left px-4 py-3 rounded-xl transition"
              >
                <p className="font-medium">{b.name}</p>
                {b.description && <p className="text-sm text-gray-400 mt-0.5">{b.description}</p>}
              </button>
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
    </div>
  );
}
