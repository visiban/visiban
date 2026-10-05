import { useEffect, useRef, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { resolveJoinToken, joinGroup } from "../api/groups";
import { getAuthProviders } from "../api/auth";
import type { User } from "../types";
import { providerLoginUrl } from "../utils/oauth";
import { ProviderIcon } from "../components/Common/ProviderIcons";

interface Props {
  user: User | null;
  onLogin: (user: User) => void;
}

export default function JoinPage({ user }: Props) {
  const { token } = useParams<{ token: string }>();
  const navigate = useNavigate();
  const [groupName, setGroupName] = useState<string | null>(null);
  const [groupId, setGroupId] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [joining, setJoining] = useState(false);
  const [invalid, setInvalid] = useState(false);
  const [invalidReason, setInvalidReason] = useState<"expired" | "already_used">("expired");
  const [joinError, setJoinError] = useState<string | null>(null);
  const [countdown, setCountdown] = useState(5);
  const [providers, setProviders] = useState<{ google: boolean; github: boolean; gitlab: boolean; oidc: boolean; oidc_name: string | null } | null>(null);
  // Prevent double-firing auto-join in React StrictMode.
  const autoJoinFired = useRef(false);

  // Site-wide invite links (vbnl_ prefix) are for registration, not group joining.
  // Redirect to the login page with the token so the registration form can consume it.
  const isSiteInvite = token?.startsWith("vbnl_") ?? false;

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
    resolveJoinToken(token)
      .then((data) => { setGroupName(data.group_name); setGroupId(data.group_id); })
      .catch((err) => {
        const httpStatus = (err as { response?: { status?: number } }).response?.status;
        setInvalidReason(httpStatus === 410 ? "already_used" : "expired");
        setInvalid(true);
      })
      .finally(() => setLoading(false));
  }, [token, isSiteInvite, navigate]);

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
  useEffect(() => {
    if (!user || !groupId || !token || autoJoinFired.current) return;
    autoJoinFired.current = true;
    setJoining(true);
    joinGroup(token)
      .then(() => navigate(`/groups/${groupId}`, { state: { joinedGroup: groupName } }))
      .catch(() => {
        setJoinError("Failed to join group. The invite may have expired.");
        setJoining(false);
      });
  }, [user, groupId, token, groupName, navigate]);

  const handleRetry = () => {
    autoJoinFired.current = false;
    setJoinError(null);
    setJoining(true);
    if (!token) return;
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
          {invalidReason === "already_used" ? (
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

  return (
    <div className="min-h-screen bg-sunken flex items-center justify-center">
      <div className="bg-surface rounded-2xl shadow-2xl p-10 w-full max-w-sm text-center">
        <div className="flex flex-col items-center mb-6">
          <img src="/brand/visiban_wordmark_dark.png" alt="Visiban" className="w-32 mb-6" />
          <h1 className="text-2xl font-bold text-fg mb-2">You're invited</h1>
          <p className="text-fg-tertiary text-sm">
            Join <span className="text-fg font-semibold">{groupName}</span>
          </p>
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
