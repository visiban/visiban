import { useEffect, useRef, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { resolveJoinToken, joinGroup } from "../api/groups";
import { getAuthProviders } from "../api/auth";
import type { User } from "../types";

const API = import.meta.env.VITE_API_URL ?? "http://localhost:8000";

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
      navigate("/", { state: { authMode: "register" }, replace: true });
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
    if (countdown <= 0) { navigate("/"); return; }
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
    navigate("/", { state: { authMode: mode } });
  };

  const handleOAuthRedirect = (provider: string) => {
    // Store token for both paths: password login consumes returnTo via handleLogin
    // and navigates to JoinPage; OAuth returns to the root where App.tsx consumes
    // pendingJoinToken directly (handleLogin is never called for OAuth).
    sessionStorage.setItem("pendingJoinToken", token!);
    sessionStorage.setItem("returnTo", `/join/${token}`);
    window.location.href = `${API}/accounts/${provider}/login/?process=login`;
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
          <h1 className="text-2xl font-bold text-white mb-2">You're invited</h1>
          <p className="text-fg-tertiary text-sm">
            Join <span className="text-white font-semibold">{groupName}</span>
          </p>
        </div>

        {user ? (
          <div className="flex flex-col items-center gap-3 min-h-[4rem] justify-center">
            {joining ? (
              <>
                <div className="w-5 h-5 border-2 border-blue-600 border-t-transparent rounded-full animate-spin" />
                <p className="text-fg-tertiary text-sm truncate max-w-full">Joining {groupName}…</p>
              </>
            ) : joinError ? (
              <>
                <p className="text-danger text-sm">{joinError}</p>
                <button
                  onClick={handleRetry}
                  className="bg-blue-600 hover:bg-blue-700 text-white px-3 py-1.5 rounded text-sm transition focus:outline-none focus:ring-2 focus:ring-blue-500"
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
              className="w-full bg-blue-600 hover:bg-blue-500 text-white font-medium py-2.5 rounded text-sm transition focus:outline-none focus:ring-2 focus:ring-blue-500"
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
              className="w-full bg-surface-hover hover:bg-surface-active text-white font-medium py-2.5 rounded text-sm transition focus:outline-none focus:ring-2 focus:ring-blue-500"
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
                      className="flex items-center justify-center gap-3 bg-surface-hover text-white font-medium py-2.5 px-4 rounded hover:bg-surface-active transition text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                    >
                      <GoogleIcon />
                      Continue with Google
                    </button>
                  )}
                  {providers.github && (
                    <button
                      onClick={() => handleOAuthRedirect("github")}
                      className="flex items-center justify-center gap-3 bg-surface-hover text-white font-medium py-2.5 px-4 rounded hover:bg-surface-active transition text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                    >
                      <GitHubIcon />
                      Continue with GitHub
                    </button>
                  )}
                  {providers.gitlab && (
                    <button
                      onClick={() => handleOAuthRedirect("gitlab")}
                      className="flex items-center justify-center gap-3 bg-orange-600 text-white font-medium py-2.5 px-4 rounded hover:bg-orange-500 transition text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                    >
                      <GitLabIcon />
                      Continue with GitLab
                    </button>
                  )}
                  {providers.oidc && (
                    <button
                      onClick={() => handleOAuthRedirect("oidc")}
                      className="flex items-center justify-center gap-3 bg-surface-hover text-white font-medium py-2.5 px-4 rounded hover:bg-surface-active transition text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
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

function GoogleIcon() {
  return (
    <svg className="w-5 h-5" viewBox="0 0 24 24">
      <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
      <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
      <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
      <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
    </svg>
  );
}

function GitHubIcon() {
  return (
    <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
      <path d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z"/>
    </svg>
  );
}

function GitLabIcon() {
  return (
    <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
      <path d="M22.65 14.39L12 22.13 1.35 14.39a.84.84 0 01-.3-.94l1.22-3.78 2.44-7.51A.42.42 0 014.82 2a.43.43 0 01.58 0 .42.42 0 01.11.18l2.44 7.49h8.1l2.44-7.51A.42.42 0 0118.6 2a.43.43 0 01.58 0 .42.42 0 01.11.18l2.44 7.51L23 13.45a.84.84 0 01-.35.94z"/>
    </svg>
  );
}
