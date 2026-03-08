import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { listBoards, createBoard, deleteBoard } from "../api/boards";
import { listGroups } from "../api/groups";
import Navbar from "../components/Layout/Navbar";
import CreateGroupModal from "../components/Group/CreateGroupModal";
import GroupTree, { buildGroupTree } from "../components/Group/GroupTree";
import MoveBoardModal from "../components/Board/MoveBoardModal";
import CreateBoardModal from "../components/Board/CreateBoardModal";
import type { Board, Group, User } from "../types";

interface Props {
  user: User;
  onLogout: () => void;
  onUserUpdated: (user: User) => void;
}

export default function Dashboard({ user, onLogout, onUserUpdated }: Props) {
  const navigate = useNavigate();
  const [boards, setBoards] = useState<Board[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);
  const [loadingBoards, setLoadingBoards] = useState(true);
  const [loadingGroups, setLoadingGroups] = useState(true);
  const [creatingBoard, setCreatingBoard] = useState(false);
  const [showCreateGroup, setShowCreateGroup] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null);
  const [movingBoard, setMovingBoard] = useState<Board | null>(null);

  useEffect(() => {
    listBoards()
      .then((all) => setBoards(all.filter((b) => !b.group)))
      .finally(() => setLoadingBoards(false));
    listGroups().then(setGroups).finally(() => setLoadingGroups(false));
  }, []);

  const handleCreateBoard = async (name: string, template: string) => {
    const board = await createBoard({ name, template });
    setBoards((prev) => [board, ...prev]);
    setCreatingBoard(false);
    navigate(`/boards/${board.id}`);
  };

  const handleDeleteBoard = async (boardId: number) => {
    setBoards((prev) => prev.filter((b) => b.id !== boardId));
    setConfirmDeleteId(null);
    try {
      await deleteBoard(boardId);
    } catch {
      listBoards().then((all) => setBoards(all.filter((b) => !b.group)));
    }
  };

  const personalBoards = boards;

  return (
    <div className="min-h-screen bg-gray-900 flex flex-col">
      <Navbar user={user} onLogout={onLogout} onUserUpdated={onUserUpdated} />

      <main className="flex-1 p-8 max-w-5xl mx-auto w-full">

        {/* Groups */}
        <section className="mb-10">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-white text-lg font-semibold">Groups</h2>
            <button
              onClick={() => setShowCreateGroup(true)}
              className="text-sm text-blue-400 hover:text-blue-300 transition"
            >
              + New top-level group
            </button>
          </div>
          {loadingGroups ? (
            <p className="text-gray-500 text-sm">Loading…</p>
          ) : groups.length === 0 ? (
            <p className="text-gray-600 text-sm">No groups yet. Create one to collaborate with others.</p>
          ) : (
            <div className="bg-gray-800/50 rounded-xl border border-gray-700/50 px-2 py-1">
              <GroupTree
                nodes={buildGroupTree(groups)}
                onGroupCreated={(g) => setGroups((prev) => [...prev, g])}
              />
            </div>
          )}
        </section>

        {/* Personal boards */}
        <section>
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-white text-lg font-semibold">My Boards</h2>
          </div>
          {loadingBoards ? (
            <p className="text-gray-500 text-sm">Loading…</p>
          ) : (
            <div className="flex flex-col gap-2">
              {personalBoards.map((b) => (
                <div key={b.id} className="group relative">
                  <button
                    onClick={() => navigate(`/boards/${b.id}`)}
                    className="w-full bg-gray-800 hover:bg-gray-700 text-white text-left px-4 py-3 rounded-xl transition"
                  >
                    <p className="font-medium">{b.name}</p>
                    {b.description && <p className="text-sm text-gray-400 mt-0.5">{b.description}</p>}
                  </button>
                  <div className="absolute right-3 top-1/2 -translate-y-1/2 flex items-center gap-1 opacity-0 group-hover:opacity-100 transition">
                    <button
                      onClick={(e) => { e.stopPropagation(); setMovingBoard(b); }}
                      className="text-gray-500 hover:text-blue-400 p-1"
                      title="Move to group"
                    >
                      <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
                        <path d="M8 5a1 1 0 000 2h5.586l-1.293 1.293a1 1 0 001.414 1.414l3-3a1 1 0 000-1.414l-3-3a1 1 0 10-1.414 1.414L13.586 5H8z" />
                        <path d="M12 15a1 1 0 100-2H6.414l1.293-1.293a1 1 0 10-1.414-1.414l-3 3a1 1 0 000 1.414l3 3a1 1 0 001.414-1.414L6.414 15H12z" />
                      </svg>
                    </button>
                    {b.owner.id === user.id && (
                      <button
                        onClick={(e) => { e.stopPropagation(); setConfirmDeleteId(b.id); }}
                        className="text-gray-500 hover:text-red-400 p-1"
                        title="Delete board"
                      >
                        <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
                          <path fillRule="evenodd" d="M9 2a1 1 0 00-.894.553L7.382 4H4a1 1 0 000 2v10a2 2 0 002 2h8a2 2 0 002-2V6a1 1 0 100-2h-3.382l-.724-1.447A1 1 0 0011 2H9zM7 8a1 1 0 012 0v6a1 1 0 11-2 0V8zm5-1a1 1 0 00-1 1v6a1 1 0 102 0V8a1 1 0 00-1-1z" clipRule="evenodd" />
                        </svg>
                      </button>
                    )}
                  </div>
                </div>
              ))}
              {personalBoards.length === 0 && !creatingBoard && (
                <p className="text-gray-600 text-sm">No personal boards yet.</p>
              )}
              <button
                onClick={() => setCreatingBoard(true)}
                className="w-full border border-dashed border-gray-600 text-gray-400 hover:text-white hover:border-gray-400 py-3 rounded-xl text-sm transition"
              >
                + New board
              </button>
            </div>
          )}
        </section>
      </main>

      {creatingBoard && (
        <CreateBoardModal
          onConfirm={handleCreateBoard}
          onCancel={() => setCreatingBoard(false)}
        />
      )}

      {movingBoard && (
        <MoveBoardModal
          board={movingBoard}
          onMoved={(updated) => {
            // If moved to a group, remove from personal list
            if (updated.group !== null) {
              setBoards((prev) => prev.filter((b) => b.id !== updated.id));
            }
            setMovingBoard(null);
          }}
          onClose={() => setMovingBoard(null)}
        />
      )}

      {showCreateGroup && (
        <CreateGroupModal
          onCreated={(g) => { setGroups((prev) => [g, ...prev]); navigate(`/groups/${g.id}`); }}
          onClose={() => setShowCreateGroup(false)}
        />
      )}

      {confirmDeleteId !== null && (() => {
        const board = boards.find((b) => b.id === confirmDeleteId);
        return (
          <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
            <div className="bg-gray-800 rounded-xl p-6 w-full max-w-sm shadow-xl">
              <h3 className="text-white font-semibold text-lg mb-2">Delete board?</h3>
              <p className="text-gray-400 text-sm mb-1">
                <span className="text-white font-medium">{board?.name}</span> and all its data will be permanently deleted.
              </p>
              <p className="text-red-400 text-sm mb-5">This cannot be undone.</p>
              <div className="flex gap-3 justify-end">
                <button onClick={() => setConfirmDeleteId(null)} className="text-gray-400 text-sm hover:text-white px-3 py-1.5">Cancel</button>
                <button onClick={() => handleDeleteBoard(confirmDeleteId)} className="bg-red-600 hover:bg-red-700 text-white text-sm px-4 py-1.5 rounded-lg">Delete</button>
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
}
