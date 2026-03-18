import { useState, useEffect, useCallback } from "react";
import { useEscapeStack } from "./hooks/useEscapeStack";
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
import AdminPage from "./pages/AdminPage";
import type { User } from "./types";
import { starBoard, unstarBoard } from "./api/boards";

export default function App() {
  const { user, loading, logout, updateUser } = useAuth();
  const navigate = useNavigate();
  const [starVersion, setStarVersion] = useState(0);
  const handleStarToggled = useCallback(() => setStarVersion((v) => v + 1), []);

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
              <AppSidebar user={user} starVersion={starVersion} />
              <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
                <AuthenticatedRoutes user={user} onLogout={logout} onUserUpdated={updateUser} onStarToggled={handleStarToggled} />
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

function AuthenticatedRoutes({ user, onLogout, onUserUpdated, onStarToggled }: {
  user: User;
  onLogout: () => void;
  onUserUpdated: (user: User) => void;
  onStarToggled: () => void;
}) {
  return (
    <Routes>
      <Route path="/" element={<Dashboard user={user} onLogout={onLogout} onUserUpdated={onUserUpdated} />} />
      <Route path="/groups/:id" element={<GroupDetail user={user} onLogout={onLogout} onUserUpdated={onUserUpdated} onStarToggled={onStarToggled} />} />
      <Route path="/boards/:id" element={<BoardPage user={user} onLogout={onLogout} onUserUpdated={onUserUpdated} onStarToggled={onStarToggled} />} />
      <Route path="/settings" element={<SettingsPage user={user} onLogout={onLogout} onUserUpdated={onUserUpdated} />} />
      <Route path="/admin" element={<AdminPage user={user} onLogout={onLogout} onUserUpdated={onUserUpdated} />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

function BoardPage({ user, onLogout, onUserUpdated, onStarToggled }: {
  user: User;
  onLogout: () => void;
  onUserUpdated: (user: User) => void;
  onStarToggled: () => void;
}) {
  const navigate = useNavigate();
  const { board, loading, error, moveCard, addCard, removeCard, addColumn, removeColumn,
    addSwimlane, updateCard, updateColumn, addLabel, updateLabel, removeLabel,
    addMember, updateMember, removeMember, applyColumnOrder, applySwimlaneOrder,
    reorderColumns, reorderSwimlanes, updateSwimlane, removeSwimlane,
    updateBoardSettings,
  } = useBoard();

  const [isStarred, setIsStarred] = useState(false);
  const [starLoading, setStarLoading] = useState(false);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- deps are specific fields; including the full board object causes spurious re-runs
  useEffect(() => { if (board) setIsStarred(board.is_starred); }, [board?.id, board?.is_starred]);

  const handleStarToggle = async () => {
    if (starLoading || !board) return;
    const prev = isStarred;
    setIsStarred(!prev);
    setStarLoading(true);
    try {
      if (prev) await unstarBoard(board.id); else await starBoard(board.id);
      onStarToggled();
    } catch { setIsStarred(prev); }
    finally { setStarLoading(false); }
  };

  const handleBack = () => {
    if (board?.group) {
      navigate(`/groups/${board.group}`);
    } else {
      navigate("/");
    }
  };

  useEscapeStack(() => {
    const tag = (document.activeElement as HTMLElement)?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return false;
    // navigate(-1) is referrer-based; fall back to semantic parent if there is
    // no history entry to go back to (e.g. board opened directly via URL).
    if (window.history.length > 1) { navigate(-1); return; }
    handleBack();
  }, 0);

  const starButton = board ? (
    <button
      onClick={handleStarToggle}
      disabled={starLoading}
      className={`text-sm transition ${isStarred ? "text-yellow-400 hover:text-yellow-200" : "text-slate-500 hover:text-yellow-400"}`}
      title={isStarred ? "Unstar board" : "Star board"}
      aria-label={isStarred ? "Unstar board" : "Star board"}
    >
      {isStarred ? "★" : "☆"}
    </button>
  ) : null;

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <Navbar
        user={user}
        onLogout={onLogout}
        onUserUpdated={onUserUpdated}
        breadcrumb={[
          ...(board?.group ? [{ label: board.group_name ?? "Group", href: `/groups/${board.group}` }] : []),
          { label: board?.name ?? "…", suffix: starButton },
        ]}
      />
      <div className="flex-1 flex flex-col overflow-hidden bg-slate-900">
        {loading && <div className="flex items-center justify-center h-full text-slate-400">Loading board…</div>}
        {error && <div className="flex items-center justify-center h-full text-red-400">{error}</div>}
        {board && (
          <BoardView
            board={board}
            onMoveCard={moveCard}
            onCardAdded={addCard}
            onCardDeleted={removeCard}
            onCardUpdated={updateCard}
            onCardArchived={removeCard}
            onCardUnarchived={addCard}
            onColumnAdded={addColumn}
            onColumnUpdated={updateColumn}
            onColumnDeleted={removeColumn}
            onColumnsReordered={reorderColumns}
            onSwimlaneAdded={addSwimlane}
            onSwimlaneUpdated={updateSwimlane}
            onSwimlaneDeleted={removeSwimlane}
            onSwimlanesReordered={reorderSwimlanes}
            onLabelAdded={addLabel}
            onLabelUpdated={updateLabel}
            onLabelDeleted={removeLabel}
            onMemberAdded={addMember}
            onMemberUpdated={updateMember}
            onMemberRemoved={removeMember}
            onColumnOrderApplied={applyColumnOrder}
            onSwimlaneOrderApplied={applySwimlaneOrder}
            onBoardSettingsChanged={updateBoardSettings}
            onBoardDeleted={handleBack}
            userTimezone={user.timezone ?? ""}
            userDateFormat={user.date_format ?? "MM/DD/YYYY"}
            userTimeFormat={user.time_format ?? "12h"}
            closeEditorOnEnter={user.close_editor_on_enter ?? false}
          />
        )}
      </div>
    </div>
  );
}
