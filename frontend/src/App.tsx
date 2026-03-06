import { useState } from "react";
import { useAuth } from "./hooks/useAuth";
import { useBoard } from "./hooks/useBoard";
import LoginPage from "./components/Auth/LoginPage";
import BoardSelector from "./components/Layout/BoardSelector";
import BoardView from "./components/Board/BoardView";
import Navbar from "./components/Layout/Navbar";
import type { Board, User } from "./types";

export default function App() {
  const { user, loading, logout, updateUser } = useAuth();
  const [activeBoard, setActiveBoard] = useState<Board | null>(null);

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-900 flex items-center justify-center">
        <span className="text-gray-400">Loading…</span>
      </div>
    );
  }

  if (!user) return <LoginPage />;
  if (!activeBoard) return <BoardSelector onSelect={setActiveBoard} />;

  return (
    <BoardPage
      boardId={activeBoard.id}
      boardName={activeBoard.name}
      user={user}
      onLogout={logout}
      onBack={() => setActiveBoard(null)}
      onUserUpdated={updateUser}
    />
  );
}

function BoardPage({
  boardId, boardName, user, onLogout, onBack, onUserUpdated,
}: {
  boardId: number;
  boardName: string;
  user: User;
  onLogout: () => void;
  onBack: () => void;
  onUserUpdated: (user: User) => void;
}) {
  const { board, loading, error, moveCard, addCard, removeCard, addColumn, addSwimlane, updateCard, updateColumn, addLabel, reorderColumns, updateSwimlane, removeSwimlane } = useBoard(boardId);

  return (
    <div className="flex flex-col h-screen overflow-hidden">
      <Navbar user={user} boardName={boardName} onLogout={onLogout} onUserUpdated={onUserUpdated} />
      <div className="flex items-center gap-2 px-4 py-2 bg-gray-800 border-b border-gray-700">
        <button onClick={onBack} className="text-gray-400 hover:text-white text-sm transition">
          ← Boards
        </button>
      </div>
      <div className="flex-1 flex flex-col overflow-hidden">
        {loading && (
          <div className="flex items-center justify-center h-full text-gray-400">Loading board…</div>
        )}
        {error && (
          <div className="flex items-center justify-center h-full text-red-400">{error}</div>
        )}
        {board && (
          <BoardView
            board={board}
            onMoveCard={moveCard}
            onCardAdded={addCard}
            onCardDeleted={removeCard}
            onCardUpdated={updateCard}
            onColumnAdded={addColumn}
            onColumnUpdated={updateColumn}
            onColumnsReordered={reorderColumns}
            onSwimlaneAdded={addSwimlane}
            onSwimlaneUpdated={updateSwimlane}
            onSwimlaneDeleted={removeSwimlane}
            onLabelAdded={addLabel}
          />
        )}
      </div>
    </div>
  );
}
