import { useEffect, useRef, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { resolveJoinToken, joinGroup } from "../api/groups";
import { resolveBoardJoinToken, joinBoard } from "../api/boards";
import type { BoardInviteRole, BoardJoinResult } from "../api/boards";
import { getAuthProviders } from "../api/auth";
import type { User } from "../types";
import { providerLoginUrl } from "../utils/oauth";
import { ProviderIcon } from "../components/Common/ProviderIcons";

interface Props {
  user: User | null;
  onLogin: (user: User) => void;
}

type BoardGoneCode = "used" | "expired" | "revoked";

// What each board role lets the invitee do (#1444) — shown under the preview.
const BOARD_CAPABILITY: Record<BoardInviteRole, string> = {
  member: "You'll be able to create, edit, and move cards.",
  collaborator: "You'll be able to comment and upload files.",
  viewer: "You'll be able to view the board.",
};

function goneCode(err: unknown): BoardGoneCode | null {
  const res = (err as { response?: { status?: number; data?: { code?: string } } }).response;
  if (res?.status !== 410) return null;
  const code = res.data?.code;
  return code === "used" || code === "expired" ? code : "revoked";
}

/**
 * The /join/<token> landing page for every invite kind. One component, not a
 * fork per kind: the token's prefix picks the API — ``vbnl_`` (site, straight
 * to registration), ``vbnb_`` (board, #1444), anything else a group invite —
 * and the rest of the page renders from the same name/id state.
 */
export default function JoinPage({ user }: Props) {
  const { token } = useParams<{ token: string }>();
  const navigate = useNavigate();
  // Name/id of what the invite joins: a group, or a board for vbnb_ tokens.
  const [groupName, setGroupName] = useState<string | null>(null);
  const [groupId, setGroupId] = useState<number | null>(null);
  const [boardRole, setBoardRole] = useState<BoardInviteRole | null>(null);
  const [boardGone, setBoardGone] = useState<BoardGoneCode>("revoked");
  const titleRef = useRef<HTMLHeadingElement & HTMLParagraphElement>(null);
  const [loading, setLoading] = useState(true);
  const [joining, setJoining] = useState(false);
  const [invalid, setInvalid] = useState(false);
  const [invalidReason, setInvalidReason] = useState<"expired" | "already_used">("expired");
  const [joinError, setJoinError] = useState<string | null>(null);
  const [countdown, setCountdown] = useState(5);
  // From the preview's advisory `can_register` (#1481). Only a literal false
  // switches to the sign-in-only view; undefined (older backend) keeps the
  // original layout.
  const [canRegister, setCanRegister] = useState<boolean | undefined>();
  const [providers, setProviders] = useState<{ google: boolean; github: boolean; gitlab: boolean; oidc: boolean; oidc_name: string | null } | null>(null);
  // Prevent double-firing auto-join in React StrictMode.
  const autoJoinFired = useRef(false);

  // Site-wide invite links (vbnl_ prefix) are for registration, not group joining.
  // Redirect to the login page with the token so the registration form can consume it.
  const isSiteInvite = token?.startsWith("vbnl_") ?? false;
  const isBoardInvite = token?.startsWith("vbnb_") ?? false;

  useEffect(() => {
    if (!token) return;
    if (isSiteInvite) {
      // Store the invite token for the registration form to pick up.
      sessionStorage.setItem("invite_token", token);
      // void: navigate() can return a Promise in React Router v7; fire-and-forget,
      // there is nothing to roll back if the navigation itself rejects.
      void navigate("/", { state: { authMode: "register" }, replace: true });
      return;
    }
    if (isBoardInvite) {
      resolveBoardJoinToken(token)
        .then((data) => {
          setGroupName(data.board_name);
          setGroupId(data.board_id);
          setBoardRole(data.role);
          setCanRegister(data.can_register);
        })
        .catch((err) => {
          // 410 names why; a 404 (unknown token) reads as "no longer valid".
          setBoardGone(goneCode(err) ?? "revoked");
          setInvalid(true);
        })
        .finally(() => setLoading(false));
      return;
    }
    resolveJoinToken(token)
      .then((data) => {
        setGroupName(data.group_name);
        setGroupId(data.group_id);
        setCanRegister(data.can_register);
      })
      .catch((err) => {
        const httpStatus = (err as { response?: { status?: number } }).response?.status;
        setInvalidReason(httpStatus === 410 ? "already_used" : "expired");
        setInvalid(true);
      })
      .finally(() => setLoading(false));
  }, [token, isSiteInvite, isBoardInvite, navigate]);

  // Board invites: move focus to the title when the page switches to the
  // invalid or join-failed view, so a screen reader announces the outcome.
  useEffect(() => {
    if (isBoardInvite && (invalid || joinError)) titleRef.current?.focus();
  }, [isBoardInvite, invalid, joinError]);

  useEffect(() => {
    if (!invalid) return;
    // void: navigate() can return a Promise in React Router v7; fire-and-forget,
    // there is nothing to roll back if the navigation itself rejects.
    if (countdown <= 0) { void navigate("/"); return; }
    const t = setTimeout(() => setCountdown((c) => c - 1), 1000);
    return () => clearTimeout(t);
  }, [invalid, countdown, navigate]);

  useEffect(() => {
    if (!user) {
      getAuthProviders()
        .then(setProviders)
        .catch(() => setProviders({ google: false, github: false, gitlab: false, oidc: false, oidc_name: null }));
    }
  }, [user]);

  // Auto-join: fires when the user is already authenticated and the token has resolved.
  // Replaces the manual "Join" button — authenticated users should land in the group
  // without an extra click.
  const joinBoardAndGo = (raw: string) =>
    joinBoard(raw)
      .then((res: BoardJoinResult) =>
        navigate(`/boards/${res.board_id}`, {
          state: { joinedBoard: res.board_name, joinedRole: res.role, created: res.created },
        }),
      )
      .catch((err) => {
        const code = goneCode(err);
        if (code) {
          // Used, expired or revoked since the preview: say which.
          setBoardGone(code);
          setInvalid(true);
        } else {
          setJoinError(`Couldn't join ${groupName}. The invite may have expired or been used.`);
        }
        setJoining(false);
      });

  useEffect(() => {
    if (!user || !groupId || !token || autoJoinFired.current) return;
    autoJoinFired.current = true;
    setJoining(true);
    if (isBoardInvite) {
      void joinBoardAndGo(token);
      return;
    }
    joinGroup(token)
      .then(() => navigate(`/groups/${groupId}`, { state: { joinedGroup: groupName } }))
      .catch(() => {
        setJoinError("Failed to join group. The invite may have expired.");
        setJoining(false);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- joinBoardAndGo is recreated each render; the guard ref makes this fire once
  }, [user, groupId, token, groupName, navigate, isBoardInvite]);

  const handleRetry = () => {
    autoJoinFired.current = false;
    setJoinError(null);
    setJoining(true);
    if (!token) return;
    if (isBoardInvite) {
      void joinBoardAndGo(token);
      return;
    }
    joinGroup(token)
      .then(() => navigate(`/groups/${groupId}`, { state: { joinedGroup: groupName } }))
      .catch(() => {
        setJoinError("Failed to join group. The invite may have expired.");
        setJoining(false);
      });
  };

  const handleAuthRedirect = (mode: "login" | "register") => {
    sessionStorage.setItem("pendingJoinToken", token!);
    sessionStorage.setItem("returnTo", `/join/${token}`);
    // An emailed group invite also authorizes sign-up on an invite-only site
    // (#1445): hand the token to the registration form, which sends it as
    // invite_token. Open sites ignore it; a shareable link is refused there
    // with a message saying so.
    if (mode === "register") sessionStorage.setItem("invite_token", token!);
    // void: navigate() can return a Promise in React Router v7; fire-and-forget,
    // there is nothing to roll back if the navigation itself rejects.
    void navigate("/", { state: { authMode: mode } });
  };

  const handleOAuthRedirect = (provider: string) => {
    // Store token for both paths: password login consumes returnTo via handleLogin
    // and navigates to JoinPage; OAuth returns to the root where App.tsx consumes
    // pendingJoinToken directly (handleLogin is never called for OAuth).
    sessionStorage.setItem("pendingJoinToken", token!);
    sessionStorage.setItem("returnTo", `/join/${token}`);
    // The backend stashes the token for an OAuth sign-up on an invite-only
    // site (#1445); an existing account signing in never reads it.
    window.location.href = `${providerLoginUrl(provider)}&invite_token=${encodeURIComponent(token!)}`;
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-sunken flex items-center justify-center">
        <span className="text-fg-tertiary">Checking invite…</span>
      </div>
    );
  }

  if (invalid) {
    return (
      <div className="min-h-screen bg-sunken flex items-center justify-center">
        <div className="text-center">
          {isBoardInvite ? (
            boardGone === "used" ? (
              <>
                <p ref={titleRef} tabIndex={-1} className="text-fg-tertiary text-lg font-medium mb-2 focus:outline-none">This invite has already been used</p>
                <p className="text-fg-muted text-sm">Invites are single-use. Ask a board admin to send you a new one.</p>
              </>
            ) : boardGone === "expired" ? (
              <>
                <p ref={titleRef} tabIndex={-1} className="text-danger text-lg font-medium mb-2 focus:outline-none">This invite has expired</p>
                <p className="text-fg-muted text-sm">Ask a board admin for a new invite.</p>
              </>
            ) : (
              <>
                <p ref={titleRef} tabIndex={-1} className="text-danger text-lg font-medium mb-2 focus:outline-none">This invite is no longer valid</p>
                <p className="text-fg-muted text-sm">It may have been revoked. Ask a board admin for a new one.</p>
              </>
            )
          ) : invalidReason === "already_used" ? (
            <>
              <p className="text-fg-tertiary text-lg font-medium mb-2">This link has already been used</p>
              <p className="text-fg-muted text-sm">This was a single-use invite link. Ask a group admin for a new one.</p>
            </>
          ) : (
            <>
              <p className="text-danger text-lg font-medium mb-2">Invalid or expired invite link</p>
              <p className="text-fg-muted text-sm">This link may have been revoked or has expired.</p>
            </>
          )}
          <p className="text-fg-faint text-xs mt-3">
            Redirecting to dashboard in {countdown}s…
          </p>
        </div>
      </div>
    );
  }

  const hasOAuth = providers && (providers.google || providers.github || providers.gitlab || providers.oidc);
  // The link cannot create an account here (CLOSED site, shareable link,
  // non-admin sender, or email invites off — deliberately not said which), so
  // steer the visitor to sign in before they fill in a form that would 400.
  const registerBlocked = canRegister === false;

  return (
    <div className="min-h-screen bg-sunken flex items-center justify-center">
      <div className="bg-surface rounded-2xl shadow-2xl p-10 w-full max-w-sm text-center">
        <div className="flex flex-col items-center mb-6">
          <img src="/brand/visiban_wordmark_dark.png" alt="Visiban" className="w-32 mb-6" />
          <h1 ref={titleRef} tabIndex={-1} className="text-2xl font-bold text-fg mb-2 focus:outline-none">You're invited</h1>
          {isBoardInvite && boardRole ? (
            <>
              <p className="text-fg-tertiary text-sm">
                Join <span className="text-fg font-semibold break-words">{groupName}</span> as a {boardRole}
              </p>
              <p className="text-xs text-fg-muted mt-1">{BOARD_CAPABILITY[boardRole]}</p>
            </>
          ) : (
            <p className="text-fg-tertiary text-sm">
              Join <span className="text-fg font-semibold">{groupName}</span>
            </p>
          )}
        </div>

        {user ? (
          <div className="flex flex-col items-center gap-3 min-h-[4rem] justify-center">
            {joining ? (
              <>
                <div className="w-5 h-5 border-2 border-primary border-t-transparent rounded-full animate-spin" />
                <p className="text-fg-tertiary text-sm truncate max-w-full">Joining {groupName}…</p>
              </>
            ) : joinError ? (
              <>
                <p className="text-danger text-sm">{joinError}</p>
                <button
                  onClick={handleRetry}
                  className="bg-button-primary hover:bg-button-primary-hover text-on-primary px-3 py-1.5 rounded text-sm transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis font-medium"
                >
                  Try again
                </button>
              </>
            ) : null}
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {registerBlocked ? (
              <>
                <p className="text-fg-tertiary text-sm mb-1">
                  This invite link can't be used to create a new account. Sign in with an existing account to join.
                </p>

                <button
                  onClick={() => handleAuthRedirect("login")}
                  aria-label={`Sign in to join ${groupName}`}
                  className="w-full bg-button-primary hover:bg-button-primary-hover text-on-primary font-medium py-2.5 rounded text-sm transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
                >
                  Sign in
                </button>
              </>
            ) : (
              <>
                <p className="text-fg-tertiary text-sm mb-1">
                  To accept this invitation you need a Visiban account.
                </p>

                <button
                  onClick={() => handleAuthRedirect("register")}
                  className="w-full bg-button-primary hover:bg-button-primary-hover text-on-primary font-medium py-2.5 rounded text-sm transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
                >
                  Create an account
                </button>

                <div className="flex items-center gap-3">
                  <div className="flex-1 h-px bg-surface-hover" />
                  <span className="text-xs text-fg-muted">already have an account?</span>
                  <div className="flex-1 h-px bg-surface-hover" />
                </div>

                <button
                  onClick={() => handleAuthRedirect("login")}
                  className="w-full bg-surface-hover hover:bg-surface-active text-fg font-medium py-2.5 rounded text-sm transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
                >
                  Sign in
                </button>
              </>
            )}

            {hasOAuth && (
              <>
                <div className="flex items-center gap-3">
                  <div className="flex-1 h-px bg-surface-hover" />
                  <span className="text-xs text-fg-muted">or continue with</span>
                  <div className="flex-1 h-px bg-surface-hover" />
                </div>
                <div className="flex flex-col gap-2">
                  {providers.google && (
                    <button
                      onClick={() => handleOAuthRedirect("google")}
                      className="flex items-center justify-center gap-3 bg-surface-hover text-fg font-medium py-2.5 px-4 rounded hover:bg-surface-active transition text-sm focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
                    >
                      <ProviderIcon id="google" className="w-5 h-5" />
                      Continue with Google
                    </button>
                  )}
                  {providers.github && (
                    <button
                      onClick={() => handleOAuthRedirect("github")}
                      className="flex items-center justify-center gap-3 bg-surface-hover text-fg font-medium py-2.5 px-4 rounded hover:bg-surface-active transition text-sm focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
                    >
                      <ProviderIcon id="github" className="w-5 h-5" />
                      Continue with GitHub
                    </button>
                  )}
                  {providers.gitlab && (
                    <button
                      onClick={() => handleOAuthRedirect("gitlab")}
                      className="flex items-center justify-center gap-3 bg-warning-bg text-fg font-medium py-2.5 px-4 rounded hover:bg-warning-bg-hover transition text-sm focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
                    >
                      <ProviderIcon id="gitlab" className="w-5 h-5" />
                      Continue with GitLab
                    </button>
                  )}
                  {providers.oidc && (
                    <button
                      onClick={() => handleOAuthRedirect("oidc")}
                      className="flex items-center justify-center gap-3 bg-surface-hover text-fg font-medium py-2.5 px-4 rounded hover:bg-surface-active transition text-sm focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
                    >
                      Continue with {providers.oidc_name ?? "SSO"}
                    </button>
                  )}
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
