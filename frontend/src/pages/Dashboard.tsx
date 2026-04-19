import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { listBoards, createBoard, deleteBoard, importBoard } from "../api/boards";
import { updateDefaultBoard } from "../api/auth";
import { listGroups } from "../api/groups";
import Navbar from "../components/Layout/Navbar";
import CreateGroupModal from "../components/Group/CreateGroupModal";
import GroupTree, { buildGroupTree } from "../components/Group/GroupTree";
import MoveBoardModal from "../components/Board/MoveBoardModal";
import CreateBoardModal from "../components/Board/CreateBoardModal";
import ImportBoardModal from "../components/Board/ImportBoardModal";
import OnboardingEmptyState from "../components/Dashboard/OnboardingEmptyState";
import ModalWrapper from "../components/shared/ModalWrapper";
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
  const [deleteConfirmInput, setDeleteConfirmInput] = useState("");
  const [movingBoard, setMovingBoard] = useState<Board | null>(null);
  const [importingBoard, setImportingBoard] = useState(false);
  const [joiningGroup, setJoiningGroup] = useState(false);
  const [joinToken, setJoinToken] = useState("");

  useEffect(() => {
    listBoards()
      .then((all) => setBoards(all.filter((b) => !b.group)))
      .finally(() => setLoadingBoards(false));
    listGroups().then(setGroups).finally(() => setLoadingGroups(false));
  }, []);

  const handleCreateBoard = async (name: string, template: string, swimlaneName: string, setAsDefault: boolean) => {
    const board = await createBoard({ name, template, swimlane_name: swimlaneName });
    setBoards((prev) => [board, ...prev]);
    setCreatingBoard(false);
    if (setAsDefault) {
      // Best-effort: patch the default board preference. Failure is non-fatal.
      updateDefaultBoard(board.id)
        .then((updatedUser) => onUserUpdated(updatedUser))
        .catch(() => undefined);
    }
    navigate(`/boards/${board.id}`);
  };

  const handleDeleteBoard = async (boardId: number) => {
    setBoards((prev) => prev.filter((b) => b.id !== boardId));
    setConfirmDeleteId(null);
    setDeleteConfirmInput("");
    try {
      await deleteBoard(boardId);
    } catch {
      listBoards().then((all) => setBoards(all.filter((b) => !b.group)));
    }
  };

  const handleImportBoard = async (file: File, name?: string) => {
    const board = await importBoard(file, name);
    setImportingBoard(false);
    navigate(`/boards/${board.id}`);
  };

  const personalBoards = boards;
  const isLoaded = !loadingBoards && !loadingGroups;
  const isEmpty = isLoaded && boards.length === 0 && groups.length === 0;

  const handleJoinGroup = () => setJoiningGroup(true);

  const handleJoinSubmit = () => {
    const raw = joinToken.trim();
    // Use split instead of a regex to avoid catastrophic backtracking on
    // adversarial input (ReDoS). Takes whatever follows the last /join/ segment,
    // or the whole string if the user pasted a bare token.
    const token = raw.split("/join/").pop() ?? raw;
    if (token) navigate(`/join/${token}`);
  };

  return (
    <div className="h-full bg-sunken flex flex-col">
      <Navbar user={user} onLogout={onLogout} onUserUpdated={onUserUpdated} />

      <main className="flex-1 overflow-y-auto p-8 max-w-5xl mx-auto w-full">

        {isEmpty && (
          <OnboardingEmptyState
            onCreateBoard={() => setCreatingBoard(true)}
            onJoinGroup={handleJoinGroup}
          />
        )}

        {/* Groups */}
        <section className="mb-10">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-fg text-lg font-semibold">Groups</h2>
            <button
              onClick={() => setShowCreateGroup(true)}
              className="text-sm text-fg-secondary hover:text-fg hover:bg-surface-hover px-3 py-1.5 rounded transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
            >
              + New top-level group
            </button>
          </div>
          {loadingGroups ? (
            <p className="text-fg-muted text-sm">Loading…</p>
          ) : groups.length === 0 ? (
            <p className="text-fg-faint text-sm">No groups yet. Create one to collaborate with others.</p>
          ) : (
            <div className="bg-surface/50 rounded-xl border border-line/50 px-2 py-1">
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
            <h2 className="text-fg text-lg font-semibold">My Boards</h2>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setImportingBoard(true)}
                className="text-sm text-fg-tertiary hover:text-fg hover:bg-surface-hover px-3 py-1.5 rounded transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
              >
                Import
              </button>
              <button
                onClick={() => setCreatingBoard(true)}
                className="text-sm bg-primary hover:bg-primary-hover text-on-primary px-3 py-1.5 rounded transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
              >
                + New board
              </button>
            </div>
          </div>
          {loadingBoards ? (
            <p className="text-fg-muted text-sm">Loading…</p>
          ) : (
            <div className="flex flex-col gap-2">
              {personalBoards.length === 0 && (
                <p className="text-fg-faint text-sm">No personal boards yet.</p>
              )}
              {personalBoards.map((b) => (
                <div key={b.id} className="group relative">
                  <button
                    onClick={() => navigate(`/boards/${b.id}`)}
                    className="w-full bg-surface hover:bg-surface-hover text-fg text-left px-4 py-3 rounded transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
                  >
                    <p className="font-medium">{b.name}</p>
                    {b.description && <p className="text-sm text-fg-tertiary mt-0.5">{b.description}</p>}
                  </button>
                  <div className="absolute right-3 top-1/2 -translate-y-1/2 flex items-center gap-1 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition">
                    <button
                      onClick={(e) => { e.stopPropagation(); setMovingBoard(b); }}
                      className="text-fg-muted hover:text-info p-1 focus:outline-none focus:ring-2 focus:ring-primary-emphasis rounded"
                      title="Move to group"
                    >
                      <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
                        <path d="M8 5a1 1 0 000 2h5.586l-1.293 1.293a1 1 0 001.414 1.414l3-3a1 1 0 000-1.414l-3-3a1 1 0 10-1.414 1.414L13.586 5H8z" />
                        <path d="M12 15a1 1 0 100-2H6.414l1.293-1.293a1 1 0 10-1.414-1.414l-3 3a1 1 0 000 1.414l3 3a1 1 0 001.414-1.414L6.414 15H12z" />
                      </svg>
                    </button>
                    {b.owner.id === user.id && (
                      <button
                        onClick={(e) => { e.stopPropagation(); setConfirmDeleteId(b.id); setDeleteConfirmInput(""); }}
                        className="text-fg-muted hover:text-danger p-1 focus:outline-none focus:ring-2 focus:ring-danger-emphasis rounded"
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
            </div>
          )}
        </section>
      </main>

      {creatingBoard && (
        <CreateBoardModal
          onConfirm={handleCreateBoard}
          onCancel={() => setCreatingBoard(false)}
          user={user}
        />
      )}

      {importingBoard && (
        <ImportBoardModal
          onImport={handleImportBoard}
          onCancel={() => setImportingBoard(false)}
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
          onCreated={(g) => { setGroups((prev) => [g, ...prev]); }}
          onClose={() => setShowCreateGroup(false)}
        />
      )}

      <ModalWrapper
        open={joiningGroup}
        onClose={() => setJoiningGroup(false)}
        title="Join a group"
        maxWidth="max-w-sm"
        labelId="join-group-title"
      >
        <p className="text-fg-tertiary text-sm mb-4">Paste the invite link or token you received.</p>
        <input
          type="text"
          value={joinToken}
          onChange={(e) => setJoinToken(e.target.value)}
          placeholder="https://…/join/abc123 or abc123"
          className="w-full bg-surface border border-line text-fg-secondary text-sm rounded px-3 py-1.5 focus:outline-none focus:ring-2 focus:ring-primary-emphasis focus:border-transparent placeholder-fg-muted mb-4"
          autoFocus
          onKeyDown={(e) => { if (e.key === "Enter") handleJoinSubmit(); }}
        />
        <div className="flex gap-3 justify-end">
          <button onClick={() => setJoiningGroup(false)} className="text-fg-tertiary text-sm hover:text-fg px-3 py-1.5 transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis">Cancel</button>
          <button onClick={handleJoinSubmit} className="bg-primary hover:bg-primary-hover text-fg text-sm font-medium px-4 py-1.5 rounded transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis">Join</button>
        </div>
      </ModalWrapper>

      {confirmDeleteId !== null && (() => {
        const board = boards.find((b) => b.id === confirmDeleteId);
        const hasCards = (board?.card_count ?? 0) > 0;
        const nameMatches = deleteConfirmInput === board?.name;
        const canDelete = !hasCards || nameMatches;
        return (
          <ModalWrapper
            open={true}
            onClose={() => { setConfirmDeleteId(null); setDeleteConfirmInput(""); }}
            title="Delete board?"
            maxWidth="max-w-sm"
            labelId="delete-board-title"
          >
            <p className="text-fg-tertiary text-sm mb-1">
              <span className="text-fg font-medium">{board?.name}</span> and all its data will be permanently deleted.
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
                  className="w-full bg-surface border border-line text-fg-secondary text-sm rounded px-3 py-1.5 focus:outline-none focus:ring-2 focus:ring-primary-emphasis focus:border-transparent placeholder-fg-muted"
                  autoFocus
                />
              </div>
            )}
            <div className="flex gap-3 justify-end">
              <button
                onClick={() => { setConfirmDeleteId(null); setDeleteConfirmInput(""); }}
                className="text-fg-tertiary text-sm hover:text-fg px-3 py-1.5 transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
              >
                Cancel
              </button>
              <button
                onClick={() => handleDeleteBoard(confirmDeleteId)}
                disabled={!canDelete}
                className="bg-danger-bg hover:bg-danger-bg-hover disabled:opacity-40 disabled:cursor-not-allowed text-fg text-sm font-medium px-4 py-1.5 rounded transition focus:outline-none focus:ring-2 focus:ring-danger-emphasis"
              >
                Delete
              </button>
            </div>
          </ModalWrapper>
        );
      })()}
    </div>
  );
}
