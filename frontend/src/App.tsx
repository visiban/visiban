import { useState, useEffect, useCallback, useRef } from "react";
import { useEscapeStack } from "./hooks/useEscapeStack";
import { Routes, Route, Navigate, useNavigate } from "react-router-dom";
import { useAuth } from "./hooks/useAuth";
import { BoardProvider, useBoardContext } from "./contexts/BoardContext";
import LoginPage from "./components/Auth/LoginPage";
import ForceChangePasswordModal from "./components/Auth/ForceChangePasswordModal";
import ForceRenameUsernameModal from "./components/Auth/ForceRenameUsernameModal";
import Navbar from "./components/Layout/Navbar";
import AppSidebar from "./components/Layout/AppSidebar";
import BoardView from "./components/Board/BoardView";
import MoveBlockedToast from "./components/Board/MoveBlockedToast";
import Dashboard from "./pages/Dashboard";
import GroupDetail from "./pages/GroupDetail";
import JoinPage from "./pages/JoinPage";
import ShareBoardPage from "./pages/ShareBoardPage";
import ConfirmEmailPage from "./pages/ConfirmEmailPage";
import ForgotPasswordPage from "./pages/ForgotPasswordPage";
import ResetPasswordPage from "./pages/ResetPasswordPage";
import SettingsPage from "./pages/SettingsPage";
import AdminPage from "./pages/AdminPage";
import type { User } from "./types";
import { starBoard, unstarBoard } from "./api/boards";
import { joinGroup } from "./api/groups";

export default function App() {
  const { user, loading, logout, updateUser } = useAuth();
  const navigate = useNavigate();
  const [starVersion, setStarVersion] = useState(0);
  const handleStarToggled = useCallback(() => setStarVersion((v) => v + 1), []);
  // Prevent double-firing in React StrictMode when consuming pendingJoinToken.
  const oauthJoinFired = useRef(false);

  // OAuth return path: after an OAuth provider redirects back to the frontend root,
  // handleLogin is never called. If the user arrived via a group invite link and
  // clicked an OAuth button, JoinPage stored the raw token in pendingJoinToken before
  // the redirect. Consume it here so the user lands in the group instead of the
  // Dashboard. Also clean up any site invite token — it was for registration, which
  // has now completed (or the user already had an account).
  useEffect(() => {
    if (!user || oauthJoinFired.current) return;
    // Clean up site invite token on any successful OAuth login/signup.
    sessionStorage.removeItem("invite_token");
    const pendingToken = sessionStorage.getItem("pendingJoinToken");
    if (!pendingToken) return;
    oauthJoinFired.current = true;
    sessionStorage.removeItem("pendingJoinToken");
    sessionStorage.removeItem("returnTo");
    joinGroup(pendingToken)
      .then((group) => navigate(`/groups/${group.id}`, { state: { joinedGroup: group.name } }))
      .catch(() => navigate(`/join/${pendingToken}`));
  }, [user, navigate]);

  const handleLogin = (loggedInUser: User) => {
    updateUser(loggedInUser);
    const returnTo = sessionStorage.getItem("returnTo");
    if (returnTo) {
      sessionStorage.removeItem("returnTo");
      // JoinPage will handle auto-join when navigated to — clear pendingJoinToken
      // so the OAuth useEffect above does not also fire and double-join.
      if (returnTo.startsWith("/join/")) {
        sessionStorage.removeItem("pendingJoinToken");
      }
      // Guard: only navigate to in-app paths to prevent open-redirect via
      // sessionStorage manipulation (defense-in-depth; React Router v6 does not
      // follow external URLs but this makes the intent explicit).
      const safePath = returnTo.startsWith("/") && !returnTo.startsWith("//")
        ? returnTo
        : "/";
      navigate(safePath);
      return;
    }
    // If the user has a default board set, navigate there directly instead of
    // landing on the board picker. The board access check in BoardView will
    // redirect back to "/" if the board is no longer accessible (deleted or
    // membership revoked), so there is no IDOR risk — we only use the ID to
    // construct the URL, not to bypass any authorization.
    if (loggedInUser.default_board_id) {
      navigate(`/boards/${loggedInUser.default_board_id}`);
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
    {user && !user.must_change_password && user.must_change_username && (
      <ForceRenameUsernameModal user={user} onChanged={updateUser} />
    )}
    <Routes>
      {/* Public — accessible regardless of auth */}
      <Route path="/join/:token" element={<JoinPage user={user} onLogin={handleLogin} />} />
      <Route path="/share/:token" element={<ShareBoardPage />} />
      <Route path="/confirm-email/:key" element={<ConfirmEmailPage />} />
      <Route path="/forgot-password" element={<ForgotPasswordPage />} />
      <Route path="/reset-password/:uid/:token" element={<ResetPasswordPage />} />

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
      <Route path="/boards/:id" element={<BoardProvider><BoardPage user={user} onLogout={onLogout} onUserUpdated={onUserUpdated} onStarToggled={onStarToggled} /></BoardProvider>} />
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
  const { board, loading, error, forceMoveCard, moveError, clearMoveError } = useBoardContext();

  const isAdmin = board?.current_user_role === "admin" || board?.current_user_role === "site_admin";

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
      <div className="flex-1 flex flex-col overflow-hidden bg-slate-900 relative">
        {/* Move blocked toast — shown for WIP or weight limit violations */}
        {moveError && (
          <MoveBlockedToast
            error={moveError}
            isAdmin={isAdmin}
            onForce={forceMoveCard}
            onDismiss={clearMoveError}
          />
        )}
        {loading && <div className="flex items-center justify-center h-full text-slate-400">Loading board…</div>}
        {error && (
          <div className="flex flex-col items-center justify-center h-full gap-3">
            <p className="text-red-400 text-sm">{error}</p>
            <button
              onClick={() => window.location.reload()}
              className="text-sm bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded font-medium transition focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              Retry
            </button>
          </div>
        )}
        {board && (
          <BoardView
            onBoardDeleted={handleBack}
            userTimezone={user.timezone ?? ""}
            userDateFormat={user.date_format ?? "MM/DD/YYYY"}
            userTimeFormat={user.time_format ?? "12h"}
            closeEditorOnEnter={user.close_editor_on_enter ?? true}
            currentUser={user}
            onUserUpdated={onUserUpdated}
          />
        )}
      </div>
    </div>
  );
}
