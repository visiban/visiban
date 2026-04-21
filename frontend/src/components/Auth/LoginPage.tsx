import { useState, useEffect } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { login as apiLogin, register as apiRegister, getCurrentUser, getAuthProviders, getSiteConfig } from "../../api/auth";
import type { User } from "../../types";

const API = import.meta.env.VITE_API_URL ?? "http://localhost:8000";

/**
 * User-facing error messages keyed by backend auth_error codes.
 * Returned as ?auth_error=<code> when an OAuth callback fails.
 * Edit this map to change copy — the frontend reads it on mount.
 */
const AUTH_ERROR_FALLBACK = "Something went wrong during authentication. Please try again.";
const AUTH_ERROR_MESSAGES: Record<string, string> = {
  invite_expired: "This invite link has expired. Please ask your administrator for a new one.",
  invite_used: "This invite link has already been used. Please ask your administrator for a new one.",
  invite_revoked: "This invite link has been revoked. Please ask your administrator for a new one.",
  invite_required: "An invite link is required to create an account.",
  invite_invalid: "This invite link is no longer valid. Please ask your administrator for a new one.",
  signup_closed: "Registration is currently closed.",
  oauth_failed: AUTH_ERROR_FALLBACK,
};

/**
 * Build an OAuth redirect URL, optionally appending the invite token.
 * In register mode with a valid invite token, the token is passed as a query
 * param so the backend middleware can stash it in the Django session before
 * redirecting to the IdP.
 */
function oauthUrl(provider: string, mode: "login" | "register", hasToken: boolean): string {
  const base = `${API}/accounts/${provider}/login/?process=login`;
  if (mode === "register" && hasToken) {
    const token = sessionStorage.getItem("invite_token");
    if (token) return `${base}&invite_token=${encodeURIComponent(token)}`;
  }
  return base;
}

interface Props {
  onLogin: (user: User) => void;
}

export default function LoginPage({ onLogin }: Props) {
  const location = useLocation();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [mode, setMode] = useState<"login" | "register">(
    (location.state as { authMode?: string } | null)?.authMode === "register" ? "register" : "login"
  );
  const [loginField, setLoginField] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [providers, setProviders] = useState<{ google: boolean; github: boolean; gitlab: boolean; oidc: boolean; oidc_name: string | null } | null>(null);
  const [registrationOpen, setRegistrationOpen] = useState(true);
  const [hasInviteToken, setHasInviteToken] = useState(() => !!sessionStorage.getItem("invite_token"));

  useEffect(() => {
    getAuthProviders().then(setProviders).catch(() => setProviders({ google: false, github: false, gitlab: false, oidc: false, oidc_name: null }));
    getSiteConfig().then((c) => setRegistrationOpen(c.registration_open)).catch(() => setRegistrationOpen(true));

    // Handle auth_error from OAuth callback redirect.
    const authError = searchParams.get("auth_error");
    if (authError) {
      setError(AUTH_ERROR_MESSAGES[authError] ?? AUTH_ERROR_FALLBACK);
      // Clear dead invite tokens on token-specific errors.
      if (authError.startsWith("invite_")) {
        sessionStorage.removeItem("invite_token");
        setHasInviteToken(false);
      }
      // Clean the error from the URL so a refresh doesn't re-show it.
      navigate("/", { replace: true });
    }
  }, [navigate, searchParams]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (mode === "register") {
      // eslint-disable-next-line security/detect-possible-timing-attacks -- client-side UI validation only, not a cryptographic comparison
      if (password !== confirm) { setError("Passwords do not match."); return; } // nosemgrep
      if (password.length < 8) { setError("Password must be at least 8 characters."); return; }
    }

    setSubmitting(true);
    try {
      if (mode === "login") {
        await apiLogin(loginField, password);
      } else {
        const inviteToken = sessionStorage.getItem("invite_token") || undefined;
        await apiRegister(loginField, password, confirm, inviteToken);
        sessionStorage.removeItem("invite_token");
        setHasInviteToken(false);
      }
      const user = await getCurrentUser();
      onLogin(user);
    } catch (err: unknown) {
      const data = (err as { response?: { data?: Record<string, unknown> } })?.response?.data;
      if (data) {
        const first = Object.values(data).flat()[0];
        setError(typeof first === "string" ? first : "Something went wrong.");
      } else {
        setError("Something went wrong.");
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen bg-sunken flex items-center justify-center">
      <div className="bg-surface rounded-2xl shadow-2xl p-10 w-full max-w-sm">
        <div className="flex flex-col items-center mb-8">
          <img src="/brand/visiban_wordmark_dark.png" alt="Visiban" className="w-40" />
          {mode === "register" && !registrationOpen && hasInviteToken && (
            <p className="text-sm text-fg-secondary text-center mt-3">Complete your registration</p>
          )}
        </div>

        {/* Email/password form */}
        <form onSubmit={handleSubmit} className="flex flex-col gap-3 mb-5">
          <input
            type="text"
            required
            placeholder={mode === "login" ? "Username or email" : "Email address"}
            value={loginField}
            onChange={(e) => setLoginField(e.target.value)}
            className="w-full bg-surface border border-line text-fg-secondary placeholder-fg-muted rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary-emphasis focus:border-transparent"
          />
          <div>
            <input
              type="password"
              required
              placeholder="Password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full bg-surface border border-line text-fg-secondary placeholder-fg-muted rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary-emphasis focus:border-transparent"
            />
            {mode === "login" && (
              <div className="flex justify-end mt-1">
                <button
                  type="button"
                  onClick={() => navigate("/forgot-password")}
                  className="text-xs text-fg-tertiary hover:text-fg focus:outline-none focus:ring-2 focus:ring-primary-emphasis rounded transition"
                >
                  Forgot password?
                </button>
              </div>
            )}
          </div>
          {mode === "register" && (
            <input
              type="password"
              required
              placeholder="Confirm password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              className="w-full bg-surface border border-line text-fg-secondary placeholder-fg-muted rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary-emphasis focus:border-transparent"
            />
          )}
          {mode === "register" && !registrationOpen && !hasInviteToken && (
            <p className="text-fg-tertiary text-xs text-center">
              An invite link is required to create an account.
            </p>
          )}
          {error && <p className="text-danger text-xs" role="alert">{error}</p>}
          <button
            type="submit"
            disabled={submitting || (mode === "register" && !registrationOpen && !hasInviteToken)}
            className="w-full bg-primary hover:bg-primary-hover text-on-primary font-medium py-2.5 rounded text-sm transition disabled:opacity-40 focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
          >
            {submitting ? "Please wait…" : mode === "login" ? "Sign in" : "Create account"}
          </button>
          <p className="text-center text-xs text-fg-tertiary">
            {mode === "login" ? "Don't have an account?" : "Already have an account?"}{" "}
            {mode === "login" && !registrationOpen ? (
              <span className="text-fg-muted">Registration is invite-only.</span>
            ) : (
              <button
                type="button"
                onClick={() => { setMode(mode === "login" ? "register" : "login"); setError(null); }}
                className="text-info hover:text-info underline focus:outline-none focus:ring-2 focus:ring-primary-emphasis rounded"
              >
                {mode === "login" ? "Create one" : "Sign in"}
              </button>
            )}
          </p>
        </form>

        {/* OAuth buttons — only shown when credentials are configured */}
        {providers && (providers.google || providers.github || providers.gitlab || providers.oidc) && (
          <>
            <div className="flex items-center gap-3 mb-5">
              <div className="flex-1 h-px bg-surface-active" />
              <span className="text-xs text-fg-muted">or continue with</span>
              <div className="flex-1 h-px bg-surface-active" />
            </div>
            <div className="flex flex-col gap-3">
              {providers.google && (
                // Google brand guidelines require a white button with dark text — intentional
                // exception to the site's slate palette. See https://developers.google.com/identity/branding-guidelines
                <a
                  href={oauthUrl("google", mode, hasInviteToken)}
                  className="flex items-center justify-center gap-3 bg-white text-slate-900 hover:bg-slate-100 font-medium py-2.5 px-4 rounded transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
                >
                  <GoogleIcon />
                  Continue with Google
                </a>
              )}
              {providers.github && (
                <a
                  href={oauthUrl("github", mode, hasInviteToken)}
                  className="flex items-center justify-center gap-3 bg-surface-hover text-fg font-medium py-2.5 px-4 rounded hover:bg-surface-active transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
                >
                  <GitHubIcon />
                  Continue with GitHub
                </a>
              )}
              {providers.gitlab && (
                <a
                  href={oauthUrl("gitlab", mode, hasInviteToken)}
                  className="flex items-center justify-center gap-3 bg-warning-bg text-on-warning font-medium py-2.5 px-4 rounded hover:bg-warning-bg-hover transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
                >
                  <GitLabIcon />
                  Continue with GitLab
                </a>
              )}
              {providers.oidc && (
                <a
                  href={oauthUrl("oidc", mode, hasInviteToken)}
                  className="flex items-center justify-center gap-3 bg-surface-hover text-fg font-medium py-2.5 px-4 rounded hover:bg-surface-active transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
                >
                  Continue with {providers.oidc_name ?? "SSO"}
                </a>
              )}
            </div>
          </>
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
      <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
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
