import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { useEscapeStack } from "./hooks/useEscapeStack";
import { Routes, Route, Navigate, matchPath, useLocation, useNavigate, useParams } from "react-router-dom";
import { useAuth } from "./hooks/useAuth";
import { useInstanceFlagsState } from "./hooks/useInstanceFlagsState";
import { InstanceFlagsContext, useInstanceFlags } from "./contexts/InstanceFlagsContext";
import { BoardProvider, useBoardContext } from "./contexts/BoardContext";
import { ToastProvider } from "./contexts/ToastContext";
import { NavDrawerContext, ShellNavDataContext } from "./contexts/ShellNavContext";
import type { NavDrawerValue } from "./contexts/ShellNavContext";
import { useLoadShellNavData } from "./hooks/useLoadShellNavData";
import { ThemeServerSync } from "./context/ThemeServerSync";
import LoginPage from "./components/Auth/LoginPage";
import ForceChangePasswordModal from "./components/Auth/ForceChangePasswordModal";
import ForceRenameUsernameModal from "./components/Auth/ForceRenameUsernameModal";
import ConnectProviderModal from "./components/Auth/ConnectProviderModal";
import Navbar from "./components/Layout/Navbar";
import NavDrawer from "./components/Layout/NavDrawer";
import BoardSwitcher from "./components/Layout/BoardSwitcher";
import ShortcutsHelpHost from "./components/Layout/ShortcutsHelpHost";
import { MenuIcon, PencilIcon } from "./components/Layout/shellIcons";
import InlineBoardName from "./components/Board/InlineBoardName";
import BoardView from "./components/Board/BoardView";
import MoveBlockedToast from "./components/Board/MoveBlockedToast";
import { BoardSkeleton, BoardLoadError } from "./components/Board/BoardStates";
import ImportSkippedToast from "./components/Board/ImportSkippedToast";
import GlobalCommandPalette from "./components/Common/GlobalCommandPalette";
import HealthStatusControl from "./components/Common/HealthStatusControl";
import MaintenanceBanner from "./components/Common/MaintenanceBanner";
import DemoModeBar from "./components/Common/DemoModeBar";
import DemoWriteBlockedToast from "./components/Board/DemoWriteBlockedToast";
import Dashboard from "./pages/Dashboard";
import GroupDetail from "./pages/GroupDetail";
import { isValidJoinToken } from "./api/joinToken";
import JoinPage from "./pages/JoinPage";
import ShareBoardPage from "./pages/ShareBoardPage";
import ConfirmEmailPage from "./pages/ConfirmEmailPage";
import ForgotPasswordPage from "./pages/ForgotPasswordPage";
import ResetPasswordPage from "./pages/ResetPasswordPage";
import SettingsPage from "./pages/SettingsPage";
import AdminPage from "./pages/AdminPage";
import NotFoundPage from "./pages/NotFoundPage";
import UnavailablePage from "./pages/UnavailablePage";
import type { HealthStatus, ImportSummary, User } from "./types";
import { getBoardHealthHistory, recomputeBoardHealth, setBoardHealthStatus, starBoard, unstarBoard } from "./api/boards";
import { applyHealthRecompute, boardHealthAuto, pickBoardHealth } from "./utils/healthStatus";
import { inviteKindOf, joinInvite } from "./api/inviteKinds";
import { DEMO_STAR_REASON } from "./constants/demoCopy";

export default function App() {
  const { user, loading: authLoading, sessionUnavailable, logout, updateUser } = useAuth();
  const { flags, loaded: flagsLoaded } = useInstanceFlagsState(user !== null);
  // Hold the shell until site-config settles (#1913) so the first paint already
  // knows about maintenance and demo mode: ThemeServerSync would otherwise fire
  // a demo-fenced PATCH before it learned the instance is a demo.
  const loading = authLoading || (user !== null && !flagsLoaded);
  const navigate = useNavigate();
  const [starVersion, setStarVersion] = useState(0);
  const handleStarToggled = useCallback(() => setStarVersion((v) => v + 1), []);
  // Navigation drawer (#2473): the only navigation surface, opened on demand
  // from the header's menu button or `[`. No persistent sidebar, no rail.
  const [drawerOpen, setDrawerOpen] = useState(false);
  const menuButtonRef = useRef<HTMLButtonElement | null>(null);
  const toggleDrawer = useCallback(() => setDrawerOpen((v) => !v), []);
  // A mounted page header carries the menu button, so the fallback bar below
  // shows only while no header is registered (a route still loading).
  const [headerCount, setHeaderCount] = useState(0);
  const registerHeader = useCallback(() => {
    setHeaderCount((c) => c + 1);
    return () => setHeaderCount((c) => c - 1);
  }, []);
  const navDrawer = useMemo(
    () => ({ open: drawerOpen, setOpen: setDrawerOpen, toggle: toggleDrawer, menuButtonRef, registerHeader }),
    [drawerOpen, toggleDrawer, registerHeader],
  );
  // Prevent double-firing in React StrictMode when consuming pendingJoinToken.
  const oauthJoinFired = useRef(false);

  // OAuth return path: after an OAuth provider redirects back to the frontend root,
  // handleLogin is never called. If the user arrived via a group or board invite link and
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
    // Drop a malformed stored token instead of sending it anywhere (the api
    // functions also enforce the allowlist; #2174).
    if (!isValidJoinToken(pendingToken)) return;
    // The prefix-to-API dispatch lives in api/inviteKinds (#1491), shared with
    // JoinPage. A site invite (vbnl_) only authorizes registration, so there
    // is nothing to redeem. On failure JoinPage shows the right state.
    if (!inviteKindOf(pendingToken).join) return;
    joinInvite(pendingToken)
      .then((outcome) => navigate(outcome.path, { state: outcome.state }))
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
      // navigate() is typed as void | Promise<void> for data-router mode; this
      // app uses the declarative <Routes> router, where it resolves
      // synchronously and any navigation failure is handled by React Router's
      // own error boundary, not by the caller.
      void navigate(safePath);
      return;
    }
    // If the user has a default board set, navigate there directly instead of
    // landing on the board picker. The board access check in BoardView will
    // redirect back to "/" if the board is no longer accessible (deleted or
    // membership revoked), so there is no IDOR risk — we only use the ID to
    // construct the URL, not to bypass any authorization.
    if (loggedInUser.default_board_id) {
      void navigate(`/boards/${loggedInUser.default_board_id}`);
      return;
    }
    // Signing in at an unmatched URL deliberately keeps the URL, so the user
    // sees "Page not found" for it (#1740). /login is the exception: it has its
    // own authenticated route that redirects to the dashboard.
  };

  if (loading) {
    // The server can't check the session right now (#2143): it still exists,
    // so say so and keep retrying (useAuth) instead of showing the sign-in page.
    if (sessionUnavailable) {
      return (
        <div className="min-h-screen bg-sunken flex flex-col items-center justify-center gap-2 px-4 text-center">
          <div role="status" aria-live="polite" aria-atomic="true" className="flex items-center justify-center gap-2">
            <span className="w-5 h-5 border-2 border-primary border-t-transparent rounded-full animate-spin" aria-hidden="true" />
            <span className="text-sm text-fg-secondary">Reconnecting to your session…</span>
          </div>
          <p className="text-xs text-fg-muted">The server can't check your session right now. You're still signed in; this page retries on its own.</p>
        </div>
      );
    }
    return (
      <div className="min-h-screen bg-sunken flex items-center justify-center">
        <span className="text-fg-tertiary">Loading…</span>
      </div>
    );
  }

  // While a forced password/username change is pending the backend answers 403
  // to every endpoint except the forced-flow ones, so the shell (sidebar,
  // navbar bell, Dashboard) must not mount behind the modal: each component
  // fetches once on mount, would latch its error state, and never refetch after
  // the change completes (#1460). Holding the shell back means it mounts fresh,
  // against a session that can read data, the moment the flag clears.
  const forcedChangePending = !!user && (user.must_change_password || user.must_change_username);

  return (
    <InstanceFlagsContext.Provider value={flags}>
    {/* One shared toast region for the whole app (#2060, #1438; frontend/CLAUDE.md § Toasts). */}
    <ToastProvider>
    {user?.must_change_password && (
      <ForceChangePasswordModal user={user} onChanged={updateUser} />
    )}
    {user && !user.must_change_password && user.must_change_username && (
      <ForceRenameUsernameModal user={user} onChanged={updateUser} />
    )}
    {/* One-time "Connect {Provider}?" after an OAuth email collision (#1314).
        Waits for any forced password/username change to be resolved first. */}
    {user && !user.must_change_password && !user.must_change_username && user.pending_connect_provider && (
      <ConnectProviderModal
        provider={user.pending_connect_provider}
        identity={user.pending_connect_identity ?? null}
        onDismissed={() => updateUser({ ...user, pending_connect_provider: null, pending_connect_identity: null })}
      />
    )}
    <Routes>
      {/* Public — accessible regardless of auth */}
      <Route path="/join/:token" element={<JoinPage user={user} onLogin={handleLogin} />} />
      <Route path="/share/:token" element={<ShareBoardPage />} />
      <Route path="/confirm-email/:key" element={<ConfirmEmailPage isAuthenticated={!!user} />} />
      <Route path="/forgot-password" element={<ForgotPasswordPage />} />
      <Route path="/reset-password/:uid/:token" element={<ResetPasswordPage />} />

      {/* Auth-gated routes */}
      {user && forcedChangePending ? (
        <Route path="/*" element={<div className="min-h-screen bg-sunken" />} />
      ) : user ? (
        <>
          <Route path="/*" element={
              <SignedInShell user={user} starVersion={starVersion} navDrawer={navDrawer}>
                <ThemeServerSync user={user} onUserUpdated={updateUser} />
                <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
                  {/* Instance-wide maintenance notice (#783). First child of the
                      content column so it sits above every route and above the
                      mobile nav, outside any scroll container — it must never
                      scroll away. Spans the content column, not the viewport,
                      matching the other full-width banners. */}
                  {flags.maintenance_mode && (
                    <MaintenanceBanner
                      message={flags.maintenance_message}
                      isSiteAdmin={user.is_site_admin}
                    />
                  )}
                  {/* Hosted-demo bar (#1179). Same slot convention as the
                      maintenance notice; the two are mutually exclusive
                      deployment states (one Helm values file), so no guard. */}
                  {flags.demo_mode && flags.demo_next_reset_at && (
                    <DemoModeBar nextResetAt={flags.demo_next_reset_at} />
                  )}
                  {/* Fallback for any demo refusal that still reaches the API
                      (#1179). Mounted at the shell, not beside the board-only
                      MoveBlockedToast, so a refusal on the dashboard or the
                      settings page explains itself too. It raises a toast in
                      the shared region and renders nothing itself. */}
                  {flags.demo_mode && <DemoWriteBlockedToast />}
                  {/* Fallback bar: only while no page header is mounted (a route
                      still loading), so there is always a way into the drawer. */}
                  {headerCount === 0 && (
                    <div data-testid="shell-fallback-bar" className="flex items-center gap-3 px-4 max-sm:px-1 h-14 max-sm:h-12 bg-sunken border-b border-line shrink-0">
                      <button type="button"
                        // Set-only ref: this bar unmounts as a header mounts, and a
                        // plain ref would null the header's button on the way out.
                        ref={(el) => { if (el) menuButtonRef.current = el; }}
                        onClick={toggleDrawer}
                        className="inline-flex items-center justify-center h-9 w-9 max-sm:h-11 max-sm:w-11 rounded-md text-fg-tertiary hover:text-fg hover:bg-surface-hover transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
                        aria-label="Open navigation"
                        aria-expanded={drawerOpen}
                        aria-keyshortcuts="["
                      >
                        <MenuIcon />
                      </button>
                      <span className="text-sm font-semibold text-fg">Visiban</span>
                    </div>
                  )}
                  <main role="main" className="flex-1 flex flex-col min-h-0 overflow-hidden">
                    <AuthenticatedRoutes user={user} onLogout={logout} onUserUpdated={updateUser} onStarToggled={handleStarToggled} />
                  </main>
                </div>
              </SignedInShell>
          } />
        </>
      ) : (
        <Route path="*" element={<LoginPage onLogin={handleLogin} />} />
      )}
    </Routes>
    </ToastProvider>
    </InstanceFlagsContext.Provider>
  );
}

/**
 * The signed-in shell (#2473): one column under one header, plus the
 * navigation drawer and the keyboard shortcuts help, which every signed-in
 * route shares. Loads the drawer's and board switcher's data once.
 */
function SignedInShell({ user, starVersion, navDrawer, children }: {
  user: User;
  starVersion: number;
  navDrawer: NavDrawerValue;
  children: React.ReactNode;
}) {
  const navData = useLoadShellNavData(user, starVersion);
  return (
    <NavDrawerContext.Provider value={navDrawer}>
      <ShellNavDataContext.Provider value={navData}>
        <div className="flex h-screen overflow-hidden">
          {children}
          <NavDrawer user={user} />
          <ShortcutsHelpHost />
        </div>
      </ShellNavDataContext.Provider>
    </NavDrawerContext.Provider>
  );
}

function AuthenticatedRoutes({ user, onLogout, onUserUpdated, onStarToggled }: {
  user: User;
  onLogout: () => void;
  onUserUpdated: (user: User) => void;
  onStarToggled: () => void;
}) {
  const { pathname } = useLocation();
  // The shell-level palette covers every authenticated route EXCEPT board
  // routes. Board routes mount their own palette inside BoardProvider so
  // that instance can see board cards. Mutually exclusive by pathname so
  // only one ⌘K keydown listener is ever active. (#869)
  const showShellPalette = !matchPath("/boards/:id", pathname);
  return (
    <>
      {showShellPalette && <GlobalCommandPalette userId={user.id} />}
      <Routes>
        <Route path="/" element={<Dashboard user={user} onLogout={onLogout} onUserUpdated={onUserUpdated} />} />
        <Route path="/groups/:id" element={<GroupDetail user={user} onLogout={onLogout} onUserUpdated={onUserUpdated} onStarToggled={onStarToggled} />} />
        <Route path="/boards/:id" element={<BoardProvider><BoardPage user={user} onLogout={onLogout} onUserUpdated={onUserUpdated} onStarToggled={onStarToggled} /></BoardProvider>} />
        <Route path="/settings" element={<SettingsPage user={user} onLogout={onLogout} onUserUpdated={onUserUpdated} />} />
        <Route path="/admin" element={<AdminPage user={user} onLogout={onLogout} onUserUpdated={onUserUpdated} />} />
        {/* /login is a real URL (bookmarks, the demo's Cloudflare challenge);
            an already-signed-in visitor goes to the dashboard, not a 404. */}
        <Route path="/login" element={<Navigate to="/" replace />} />
        <Route path="*" element={<NotFoundPage user={user} onLogout={onLogout} onUserUpdated={onUserUpdated} />} />
      </Routes>
    </>
  );
}

function BoardPage({ user, onLogout, onUserUpdated, onStarToggled }: {
  user: User;
  onLogout: () => void;
  onUserUpdated: (user: User) => void;
  onStarToggled: () => void;
}) {
  const navigate = useNavigate();
  const location = useLocation();
  const { id: routeBoardId } = useParams<{ id: string }>();
  const { board, loading, error, unavailable, forceMoveCard, moveError, clearMoveError, updateBoardSettings, mergeBoardState, reload, updateSwimlane } = useBoardContext();

  // Skipped-counts notice after a selective import (#119), handed over in the
  // navigation state by the import modal's caller. Captured once on mount and
  // then cleared from history, so a reload or Back does not show it again.
  const [importSummary, setImportSummary] = useState<ImportSummary | null>(
    () => (location.state as { importSummary?: ImportSummary } | null)?.importSummary ?? null,
  );
  useEffect(() => {
    if ((location.state as { importSummary?: ImportSummary } | null)?.importSummary) {
      void navigate(`${location.pathname}${location.search}${location.hash}`, { replace: true, state: null });
    }
  }, [location, navigate]);
  const dismissImportSummary = useCallback(() => setImportSummary(null), []);

  const isAdmin = board?.current_user_role === "admin" || board?.current_user_role === "site_admin";
  // Hosted demo (#1193): board star/unstar is not on DEMO_ALLOWED_WRITES, so
  // the fallback toast was the visitor's only explanation. Refuse up front
  // like the other card/board controls in frontend/CLAUDE.md § Hosted demo
  // surfaces, rather than letting the click round-trip to a 403.
  const demoMode = useInstanceFlags().demo_mode;

  const [renaming, setRenaming] = useState(false);
  const [isStarred, setIsStarred] = useState(false);
  const [starLoading, setStarLoading] = useState(false);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- deps are specific fields; including the full board object causes spurious re-runs
  useEffect(() => { if (board) setIsStarred(board.is_starred); }, [board?.id, board?.is_starred]);

  const handleStarToggle = async () => {
    if (starLoading || !board || demoMode) return;
    const prev = isStarred;
    setIsStarred(!prev);
    setStarLoading(true);
    try {
      if (prev) await unstarBoard(board.id); else await starBoard(board.id);
      onStarToggled();
    } catch { setIsStarred(prev); }
    finally { setStarLoading(false); }
  };

  // Health status (#1133). Not updateBoardSettings: that one is optimistic and
  // swallows failures, while the popover must show a failed save, and only the
  // server can resolve the new effective value and its source. Save and
  // Confirm both use the explicit POST health-status/ action (#2242): the only
  // write that records a note or a reconfirm.
  const boardId = board?.id;
  const handleHealthSave = useCallback(async (next: HealthStatus | null, note?: string | null) => {
    if (boardId === undefined) throw new Error("Board not loaded");
    const updated = await setBoardHealthStatus(boardId, { status: next, note: note ?? null });
    // Every health field by name (BOARD_HEALTH_FIELDS), incl. #2245's auto
    // fields: a hand-copied list here is the trap that dropped new fields.
    mergeBoardState(pickBoardHealth(updated));
    return updated;
  }, [boardId, mergeBoardState]);
  // Recompute now (#2245): the board's health and each lane's, by id.
  const handleHealthRecompute = useCallback(async () => {
    if (boardId === undefined) throw new Error("Board not loaded");
    applyHealthRecompute(await recomputeBoardHealth(boardId), mergeBoardState, updateSwimlane);
  }, [boardId, mergeBoardState, updateSwimlane]);
  const fetchBoardHealthHistory = useCallback(() => {
    if (boardId === undefined) return Promise.reject(new Error("Board not loaded"));
    return getBoardHealthHistory(boardId);
  }, [boardId]);

  const handleBack = () => {
    if (board?.group) {
      // See the navigate() comment in handleLogin above — fire-and-forget by design.
      void navigate(`/groups/${board.group}`);
    } else {
      void navigate("/");
    }
  };

  useEscapeStack(() => {
    const tag = (document.activeElement as HTMLElement)?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return false;
    // navigate(-1) is referrer-based; fall back to semantic parent if there is
    // no history entry to go back to (e.g. board opened directly via URL).
    if (window.history.length > 1) { void navigate(-1); return; }
    handleBack();
  }, 0);

  const starButton = board ? (
    <button
      onClick={handleStarToggle}
      disabled={!demoMode && starLoading}
      aria-disabled={demoMode ? true : undefined}
      className={`text-sm max-sm:inline-flex max-sm:items-center max-sm:justify-center max-sm:min-h-11 max-sm:min-w-11 transition rounded focus:outline-none focus:ring-2 focus:ring-primary-emphasis ${
        demoMode
          ? "text-fg-muted opacity-40 cursor-not-allowed"
          : isStarred ? "text-warning hover:text-warning" : "text-fg-muted hover:text-warning"
      }`}
      title={demoMode ? `${isStarred ? "Unstar board" : "Star board"}. ${DEMO_STAR_REASON}` : (isStarred ? "Unstar board" : "Star board")}
      aria-label={demoMode ? `${isStarred ? "Unstar board" : "Star board"}. ${DEMO_STAR_REASON}` : (isStarred ? "Unstar board" : "Star board")}
    >
      {isStarred ? "★" : "☆"}
    </button>
  ) : null;

  // Deleted or access lost (#2041), at first load or mid-session: one page for
  // 404 and 403 alike. Declared after every hook above.
  if (unavailable) {
    // The shell palette is off on board routes (see showShellPalette), so this
    // early return must mount the board-route palette itself or "Search boards"
    // has no listener.
    return (
      <>
        <GlobalCommandPalette userId={user.id} />
        <UnavailablePage kind="board" user={user} onLogout={onLogout} onUserUpdated={onUserUpdated} />
      </>
    );
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Board-scoped palette instance — mounts inside BoardProvider so it
          sees board cards/columns. Sits ABOVE BoardView so the palette is
          available on every sub-tab (Board/Summary/History/Analytics)
          without regressing to the #869 ghost-dialog bug. */}
      <GlobalCommandPalette userId={user.id} />
      <Navbar
        user={user}
        onLogout={onLogout}
        onUserUpdated={onUserUpdated}
        breadcrumb={[
          ...(board?.group ? [{ label: board.group_name ?? "Group", href: `/groups/${board.group}` }] : []),
          {
            label: board?.name ?? "…",
            // The star stays as it is; the health control follows it (#1133).
            suffix: board ? (
              <>
                {isAdmin && !renaming && (
                  <button
                    type="button"
                    onClick={() => setRenaming(true)}
                    aria-label="Rename board"
                    title="Rename board"
                    className="inline-flex items-center justify-center w-7 h-7 max-sm:hidden rounded text-fg-muted hover:text-fg hover:bg-surface-hover transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
                  >
                    <PencilIcon className="w-3.5 h-3.5" />
                  </button>
                )}
                {starButton}
                <HealthStatusControl
                  className="ml-2 max-sm:ml-0 max-sm:!min-h-11 max-sm:!min-w-11 max-sm:justify-center"
                  collapseLabel
                  entityKind="board"
                  entityName={board.name}
                  parentName={board.group_name}
                  canEdit={isAdmin}
                  health_status={board.health_status}
                  effective_health_status={board.effective_health_status}
                  health_status_source={board.health_status_source}
                  health_status_changed_at={board.health_status_changed_at}
                  health_status_changed_by={board.health_status_changed_by}
                  health_status_note={board.health_status_note}
                  health_review_due_at={board.health_review_due_at}
                  health_status_origin={board.health_status_origin}
                  auto={boardHealthAuto(board)}
                  onRecompute={handleHealthRecompute}
                  onSave={handleHealthSave}
                  onConfirm={handleHealthSave}
                  fetchHistory={fetchBoardHealthHistory}
                  datePrefs={user}
                />
              </>
            ) : null,
            // The h1 holds the board switcher (#2473). Admins rename through
            // the Rename button beside it, which swaps in the inline editor.
            render: board ? (renaming && isAdmin ? (
              <InlineBoardName
                name={board.name}
                canEdit
                initialEditing
                onDone={() => setRenaming(false)}
                onSave={async (name) => { await updateBoardSettings({ name }); }}
              />
            ) : <BoardSwitcher board={board} />) : undefined,
          },
        ]}
      />
      <div className="flex-1 flex flex-col overflow-hidden bg-sunken relative">
        {/* Move refusals and the post-import notice raise toasts in the
            shared region, which stacks them by priority (#1438): the
            refusal sits nearest the anchor, the notice above it. */}
        {moveError && (
          <MoveBlockedToast
            error={moveError}
            isAdmin={isAdmin}
            onForce={forceMoveCard}
            onDismiss={clearMoveError}
          />
        )}
        {importSummary && board && (
          <ImportSkippedToast summary={importSummary} onDismiss={dismissImportSummary} />
        )}
        {/* Only before the first board arrives: move-rollback and retry reloads
            set `loading` too, and must not cover or announce over a live board. */}
        {/* Also when the route id changed: the hook keeps the previous board until
            the new one lands, and that stale board must not mask the loading state. */}
        {loading && (!board || board.id !== Number(routeBoardId)) && <BoardSkeleton />}
        {error && <BoardLoadError onRetry={reload} />}
        {board && (
          // Keyed by board id (#1146): the /boards/:id route keeps this page
          // mounted when the id changes, so without the key every per-board
          // piece of BoardView state (the board-scoped localStorage hooks, the
          // active preset and its Undo notice, filters, scroll) would carry
          // over to the next board.
          <BoardView
            key={board.id}
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
