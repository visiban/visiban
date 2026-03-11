import { Routes, Route, Navigate, useNavigate } from "react-router-dom";
import { useAuth } from "./hooks/useAuth";
import { useBoard } from "./hooks/useBoard";
import LoginPage from "./components/Auth/LoginPage";
import ForceChangePasswordModal from "./components/Auth/ForceChangePasswordModal";
import Navbar from "./components/Layout/Navbar";
import AppSidebar from "./components/Layout/AppSidebar";
import BoardView from "./components/Board/BoardView";
import Dashboard from "./pages/Dashboard";
import GroupDetail from "./pages/GroupDetail";
import JoinPage from "./pages/JoinPage";
import SettingsPage from "./pages/SettingsPage";
import type { User } from "./types";

export default function App() {
  const { user, loading, logout, updateUser } = useAuth();
  const navigate = useNavigate();

  const handleLogin = (loggedInUser: User) => {
    updateUser(loggedInUser);
    const returnTo = sessionStorage.getItem("returnTo");
    if (returnTo) {
      sessionStorage.removeItem("returnTo");
      navigate(returnTo);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-slate-900 flex items-center justify-center">
        <span className="text-slate-400">Loading…</span>
      </div>
    );
  }

  return (
    <>
    {user?.must_change_password && (
      <ForceChangePasswordModal user={user} onChanged={updateUser} />
    )}
    <Routes>
      {/* Public — accessible regardless of auth */}
      <Route path="/join/:token" element={<JoinPage user={user} onLogin={handleLogin} />} />

      {/* Auth-gated routes */}
      {user ? (
        <>
          <Route path="/*" element={
            <div className="flex h-screen overflow-hidden">
              <AppSidebar user={user} />
              <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
                <AuthenticatedRoutes user={user} onLogout={logout} onUserUpdated={updateUser} />
              </div>
            </div>
          } />
        </>
      ) : (
        <Route path="*" element={<LoginPage onLogin={handleLogin} />} />
      )}
    </Routes>
    </>
  );
}

function AuthenticatedRoutes({ user, onLogout, onUserUpdated }: {
  user: User;
  onLogout: () => void;
  onUserUpdated: (user: User) => void;
}) {
  return (
    <Routes>
      <Route path="/" element={<Dashboard user={user} onLogout={onLogout} onUserUpdated={onUserUpdated} />} />
      <Route path="/groups/:id" element={<GroupDetail user={user} onLogout={onLogout} onUserUpdated={onUserUpdated} />} />
      <Route path="/boards/:id" element={<BoardPage user={user} onLogout={onLogout} onUserUpdated={onUserUpdated} />} />
      <Route path="/settings" element={<SettingsPage user={user} onLogout={onLogout} onUserUpdated={onUserUpdated} />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

function BoardPage({ user, onLogout, onUserUpdated }: {
  user: User;
  onLogout: () => void;
  onUserUpdated: (user: User) => void;
}) {
  const navigate = useNavigate();
  const { board, loading, error, moveCard, addCard, removeCard, addColumn, removeColumn,
    addSwimlane, updateCard, updateColumn, addLabel, reorderColumns, updateSwimlane, removeSwimlane
  } = useBoard();

  const handleBack = () => {
    if (board?.group) {
      navigate(`/groups/${board.group}`);
    } else {
      navigate("/");
    }
  };

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <Navbar
        user={user}
        onLogout={onLogout}
        onUserUpdated={onUserUpdated}
        breadcrumb={[
          ...(board?.group ? [{ label: board.group_name ?? "Group", href: `/groups/${board.group}` }] : []),
          { label: board?.name ?? "…" },
        ]}
      />
      <div className="flex items-center gap-2 px-4 py-2 bg-slate-800 border-b border-slate-700">
        <button onClick={handleBack} className="text-slate-400 hover:text-white text-sm transition">
          ← {board?.group ? (board.group_name ?? "Group") : "Dashboard"}
        </button>
      </div>
      <div className="flex-1 flex flex-col overflow-hidden">
        {loading && <div className="flex items-center justify-center h-full text-slate-400">Loading board…</div>}
        {error && <div className="flex items-center justify-center h-full text-red-400">{error}</div>}
        {board && (
          <BoardView
            board={board}
            onMoveCard={moveCard}
            onCardAdded={addCard}
            onCardDeleted={removeCard}
            onCardUpdated={updateCard}
            onColumnAdded={addColumn}
            onColumnUpdated={updateColumn}
            onColumnDeleted={removeColumn}
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
