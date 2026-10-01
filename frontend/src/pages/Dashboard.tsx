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
import TrelloImportModal from "../components/Board/TrelloImportModal";
import OnboardingEmptyState from "../components/Dashboard/OnboardingEmptyState";
import ModalWrapper from "../components/shared/ModalWrapper";
import type { Board, Group, User } from "../types";
import Spinner from "../components/Common/Spinner";
import { DEMO_IMPORT_REASON, DEMO_NEW_BOARD_REASON } from "../constants/demoCopy";

interface Props {
  user: User;
  onLogout: () => void;
  onUserUpdated: (user: User) => void;
}

export default function Dashboard({ user, onLogout, onUserUpdated }: Props) {
  const demoMode = user.demo_mode === true;
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
  const [trelloImporting, setTrelloImporting] = useState(false);
  const [joiningGroup, setJoiningGroup] = useState(false);
  const [joinToken, setJoinToken] = useState("");
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    listBoards()
      .then(setBoards)
      .catch(() => setLoadError("Failed to load boards. Try refreshing the page."))
      .finally(() => setLoadingBoards(false));
    listGroups()
      .then(setGroups)
      .catch(() => setLoadError("Failed to load groups. Try refreshing the page."))
      .finally(() => setLoadingGroups(false));
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
    // void: navigate() can return a Promise in React Router v7; fire-and-forget,
    // the board was already created and there is nothing to roll back.
    void navigate(`/boards/${board.id}`);
  };

  const handleDeleteBoard = async (boardId: number) => {
    const previousBoards = boards;
    setBoards((prev) => prev.filter((b) => b.id !== boardId));
    setConfirmDeleteId(null);
    setDeleteConfirmInput("");
    try {
      await deleteBoard(boardId);
    } catch {
      // The delete failed after the board was optimistically removed from the
      // list — refetch to reconcile with the server, and if that also fails,
      // fall back to the pre-delete snapshot so the board doesn't appear
      // deleted when it is not.
      try {
        setBoards(await listBoards());
      } catch {
        setBoards(previousBoards);
      }
      setLoadError("Failed to delete the board. Please try again.");
    }
  };

  const handleImportBoard = async (file: File, name?: string) => {
    const board = await importBoard(file, name);
    setImportingBoard(false);
    // void: navigate() can return a Promise in React Router v7; fire-and-forget,
    // the board was already imported and there is nothing to roll back.
    void navigate(`/boards/${board.id}`);
  };

  const personalBoards = boards.filter((b) => !b.group);
  const favoriteBoards = boards
    .filter((b) => b.is_starred)
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name));
  const isLoaded = !loadingBoards && !loadingGroups;
  const isEmpty = isLoaded && boards.length === 0 && groups.length === 0;

  const renderBoardRow = (b: Board) => (
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
          aria-label={`Move ${b.name} to group`}
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
            aria-label={`Delete ${b.name}`}
          >
            <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
              <path fillRule="evenodd" d="M9 2a1 1 0 00-.894.553L7.382 4H4a1 1 0 000 2v10a2 2 0 002 2h8a2 2 0 002-2V6a1 1 0 100-2h-3.382l-.724-1.447A1 1 0 0011 2H9zM7 8a1 1 0 012 0v6a1 1 0 11-2 0V8zm5-1a1 1 0 00-1 1v6a1 1 0 102 0V8a1 1 0 00-1-1z" clipRule="evenodd" />
            </svg>
          </button>
        )}
      </div>
    </div>
  );

  const handleJoinGroup = () => setJoiningGroup(true);

  const handleJoinSubmit = () => {
    const raw = joinToken.trim();
    // Use split instead of a regex to avoid catastrophic backtracking on
    // adversarial input (ReDoS). Takes whatever follows the last /join/ segment,
    // or the whole string if the user pasted a bare token.
    const token = raw.split("/join/").pop() ?? raw;
    // void: navigate() can return a Promise in React Router v7; fire-and-forget,
    // there is nothing to roll back if the navigation itself rejects.
    if (token) void navigate(`/join/${token}`);
  };

  return (
    <div className="h-full bg-sunken flex flex-col">
      <Navbar user={user} onLogout={onLogout} onUserUpdated={onUserUpdated} />

      <main className="flex-1 overflow-y-auto p-8 max-w-5xl mx-auto w-full">

        {loadError && (
          <p className="text-sm text-danger mb-4" data-testid="dashboard-load-error">{loadError}</p>
        )}

        {isEmpty && (
          <OnboardingEmptyState
            onCreateBoard={() => setCreatingBoard(true)}
            onJoinGroup={handleJoinGroup}
          />
        )}

        {/* Groups */}
        <section className="mb-10" aria-labelledby="groups-heading">
          <div className="flex items-center justify-between mb-4">
            <h2 id="groups-heading" className="text-fg text-lg font-semibold">Groups</h2>
            <button
              onClick={() => setShowCreateGroup(true)}
              className="text-sm text-fg-secondary hover:text-fg hover:bg-surface-hover px-3 py-1.5 rounded transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
            >
              + New top-level group
            </button>
          </div>
          {loadingGroups ? (
            <Spinner />
          ) : groups.length === 0 ? (
            <p className="text-fg-faint text-sm">No groups yet. Create one to collaborate with others.</p>
          ) : (
            <div className="bg-surface/50 rounded-lg border border-line/50 px-2 py-1">
              <GroupTree
                nodes={buildGroupTree(groups)}
                onGroupCreated={(g) => setGroups((prev) => [...prev, g])}
              />
            </div>
          )}
        </section>

        {/* Favorite boards */}
        {isLoaded && favoriteBoards.length > 0 && (
          <section className="mb-10" aria-labelledby="dashboard-favorite-boards-heading">
            <div className="flex items-center justify-between mb-4">
              <h2 id="dashboard-favorite-boards-heading" className="text-fg text-lg font-semibold">Favorite Boards</h2>
            </div>
            <div className="flex flex-col gap-2">
              {favoriteBoards.map(renderBoardRow)}
            </div>
          </section>
        )}

        {/* Personal boards */}
        <section aria-labelledby="my-boards-heading">
          <div className="flex items-center justify-between mb-4">
            <h2 id="my-boards-heading" className="text-fg text-lg font-semibold">My Boards</h2>
            <div className="flex items-center gap-2">
              {/* Hosted demo (#1179): both create a whole board, which the server
                  fence refuses — aria-disabled, reason in title + aria-label. */}
              <button
                onClick={() => { if (!demoMode) setImportingBoard(true); }}
                aria-disabled={demoMode ? true : undefined}
                aria-label={demoMode ? `Import. ${DEMO_IMPORT_REASON}` : undefined}
                title={demoMode ? DEMO_IMPORT_REASON : undefined}
                className={`text-sm text-fg-tertiary px-3 py-1.5 rounded transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis ${
                  demoMode ? "opacity-40 cursor-not-allowed" : "hover:text-fg hover:bg-surface-hover"
                }`}
              >
                Import
              </button>
              <button
                onClick={() => { if (!demoMode) setCreatingBoard(true); }}
                aria-disabled={demoMode ? true : undefined}
                aria-label={demoMode ? `New board. ${DEMO_NEW_BOARD_REASON}` : undefined}
                title={demoMode ? DEMO_NEW_BOARD_REASON : undefined}
                className={`text-sm bg-button-primary text-on-primary px-3 py-1.5 rounded transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis font-medium ${
                  demoMode ? "opacity-40 cursor-not-allowed" : "hover:bg-button-primary-hover"
                }`}
              >
                + New board
              </button>
            </div>
          </div>
          {loadingBoards ? (
            <Spinner />
          ) : (
            <div className="flex flex-col gap-2">
              {personalBoards.length === 0 && (
                <p className="text-fg-faint text-sm">No personal boards yet.</p>
              )}
              {personalBoards.map(renderBoardRow)}
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
          onSwitchToTrello={() => {
            setImportingBoard(false);
            setTrelloImporting(true);
          }}
        />
      )}

      {trelloImporting && (
        <TrelloImportModal
          onCancel={() => setTrelloImporting(false)}
          onImported={(b) => {
            setTrelloImporting(false);
            // void: navigate() can return a Promise in React Router v7; fire-and-forget,
            // the board was already imported and there is nothing to roll back.
            void navigate(`/boards/${b.id}`);
          }}
        />
      )}

      {movingBoard && (
        <MoveBoardModal
          board={movingBoard}
          onMoved={(updated) => {
            setBoards((prev) => prev.map((b) => (b.id === updated.id ? updated : b)));
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
          <button onClick={handleJoinSubmit} className="bg-button-primary hover:bg-button-primary-hover text-on-primary text-sm font-medium px-4 py-1.5 rounded transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis">Join</button>
        </div>
      </ModalWrapper>

      {confirmDeleteId !== null && (() => {
        const board = boards.find((b) => b.id === confirmDeleteId);
        // Card.board cascades, so archived cards are deleted with the board
        // even though card_count (#693) leaves them out. Gate typed-name
        // confirmation on both counts so a board holding only archived cards
        // cannot be deleted with a single click (#1289).
        const activeCount = board?.card_count ?? 0;
        const archivedCount = board?.archived_card_count ?? 0;
        const hasCards = activeCount + archivedCount > 0;
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
              <span className="text-fg font-medium">{board?.name}</span> and all its data, including archived cards, will be permanently deleted.
            </p>
            <p className="text-danger text-sm mb-4">This cannot be undone.</p>
            {hasCards && (
              <div className="mb-4">
                <p className="text-fg-tertiary text-xs mb-2">
                  This board has{" "}
                  {activeCount > 0 && (
                    <span className="text-fg font-medium">{activeCount} card{activeCount !== 1 ? "s" : ""}</span>
                  )}
                  {activeCount > 0 && archivedCount > 0 && " and "}
                  {archivedCount > 0 && (
                    <span className="text-fg font-medium">{archivedCount} archived card{archivedCount !== 1 ? "s" : ""}</span>
                  )}
                  . Type the board name to confirm deletion.
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
                className="bg-danger-bg hover:bg-danger-bg-hover disabled:opacity-40 disabled:cursor-not-allowed text-on-danger text-sm font-medium px-4 py-1.5 rounded transition focus:outline-none focus:ring-2 focus:ring-danger-emphasis"
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
