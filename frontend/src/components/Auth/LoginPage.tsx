import { useState, useEffect } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { login as apiLogin, register as apiRegister, getCurrentUser, getAuthProviders, getSiteConfig } from "../../api/auth";
import type { User } from "../../types";
import { formatClockTime } from "../../utils/date";
import { DEMO_RESET_NOTICE_KEY } from "../../utils/demoReset";
import { providerLoginUrl } from "../../utils/oauth";
import { PROVIDER_META, ProviderIcon, isProviderId, providerLabel } from "../Common/ProviderIcons";

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
  const base = providerLoginUrl(provider);
  if (mode === "register" && hasToken) {
    const token = sessionStorage.getItem("invite_token");
    if (token) return `${base}&invite_token=${encodeURIComponent(token)}`;
  }
  return base;
}

interface Props {
  onLogin: (user: User) => void;
}

/**
 * The two OAuth email-collision outcomes (#1314) get a banner above the form
 * instead of the one-line error slot: each changes what the page asks the
 * user to do next. Provider ids are kept (not labels) so the generic OIDC
 * provider can be named with the instance's configured SSO name once
 * /auth/providers/ answers. Every other auth_error code keeps the flat
 * AUTH_ERROR_MESSAGES map and the bottom-of-form slot.
 */
type LoginBanner =
  | { kind: "account_exists"; provider: string }
  | { kind: "account_exists_provider"; via: string; provider: string };

/** First human-readable message from an auth error response, or a generic fallback. */
function loginErrorMessage(err: unknown): string {
  const data = (err as { response?: { data?: Record<string, unknown> } })?.response?.data;
  if (data) {
    const first = Object.values(data).flat()[0];
    return typeof first === "string" ? first : "Something went wrong.";
  }
  return "Something went wrong.";
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
  const [demoLogin, setDemoLogin] = useState<{ username: string; password: string } | null>(null);
  const [demoNextResetAt, setDemoNextResetAt] = useState<string | null>(null);
  const [demoResetSchedule, setDemoResetSchedule] = useState<string | null>(null);
  // Separate from `submitting` so the one-click demo sign-in and the manual
  // form never disable each other (#1179).
  const [submittingDemo, setSubmittingDemo] = useState(false);
  const [demoError, setDemoError] = useState<string | null>(null);
  // One-shot "the demo was reset" notice (#1179), left by utils/demoReset.ts
  // when an auth failure followed the scheduled reset. Read here without
  // clearing — StrictMode double-invokes initializers, and a read-and-clear
  // would hand the second call nothing — and cleared by the effect below.
  const [resetNoticeAt] = useState<string | null>(() => {
    try {
      return sessionStorage.getItem(DEMO_RESET_NOTICE_KEY);
    } catch {
      return null;
    }
  });
  const [hasInviteToken, setHasInviteToken] = useState(() => !!sessionStorage.getItem("invite_token"));
  const [banner, setBanner] = useState<LoginBanner | null>(null);

  useEffect(() => {
    try {
      sessionStorage.removeItem(DEMO_RESET_NOTICE_KEY);
    } catch {
      /* storage unavailable */
    }
  }, []);

  useEffect(() => {
    getAuthProviders().then(setProviders).catch(() => setProviders({ google: false, github: false, gitlab: false, oidc: false, oidc_name: null }));
    getSiteConfig()
      .then((c) => {
        setRegistrationOpen(c.registration_open);
        // Demo banner (#1034): only when the server says demo mode is on AND
        // supplied credentials — a demo without credentials has nothing to show.
        setDemoLogin(c.demo_mode && c.demo_login ? c.demo_login : null);
        setDemoNextResetAt(c.demo_mode ? c.demo_next_reset_at ?? null : null);
        setDemoResetSchedule(c.demo_mode ? c.demo_reset_schedule ?? null : null);
      })
      .catch(() => setRegistrationOpen(true));

    // Handle auth_error from OAuth callback redirect.
    const authError = searchParams.get("auth_error");
    // Only known provider ids may be named in the banner: these params come
    // from the URL, and a crafted link must not put arbitrary text into a
    // security message. An unknown id falls back to the generic message.
    const knownProvider = (key: string) => {
      const v = searchParams.get(key) ?? "";
      return isProviderId(v) ? v : null;
    };
    // navigate() is typed as void | Promise<void> for data-router mode; this
    // app uses the declarative <Routes> router, where it resolves
    // synchronously and any navigation failure is handled by React Router's
    // own error boundary, not by the caller — fire-and-forget by design.
    if (authError === "account_exists" && knownProvider("provider")) {
      // An in-flight invite (sessionStorage) is deliberately kept: the user
      // signs in to their existing account and the join flow carries on.
      setBanner({ kind: "account_exists", provider: knownProvider("provider")! });
      void navigate("/", { replace: true });
    } else if (authError === "account_exists_provider" && knownProvider("via") && knownProvider("provider")) {
      setBanner({
        kind: "account_exists_provider",
        via: knownProvider("via")!,
        provider: knownProvider("provider")!,
      });
      void navigate("/", { replace: true });
    } else if (authError) {
      setError(AUTH_ERROR_MESSAGES[authError] ?? AUTH_ERROR_FALLBACK);
      // Clear dead invite tokens on token-specific errors.
      if (authError.startsWith("invite_")) {
        sessionStorage.removeItem("invite_token");
        setHasInviteToken(false);
      }
      // Clean the error from the URL so a refresh doesn't re-show it.
      void navigate("/", { replace: true });
    }
  }, [navigate, searchParams]);

  const handleForgotPassword = () => navigate("/forgot-password");

  const labelFor = (id: string) => providerLabel(id, providers?.oidc_name);

  const startOAuth = (provider: string) => {
    window.location.href = oauthUrl(provider, "login", false);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (mode === "register") {
      // eslint-disable-next-line security/detect-possible-timing-attacks -- client-side UI validation only, not a cryptographic comparison
      if (password !== confirm) { setError("Passwords do not match."); return; } // nosemgrep
      if (password.length < 12) { setError("Password must be at least 12 characters."); return; }
    }

    setSubmitting(true);
    try {
      if (mode === "login") {
        await performLogin(loginField, password);
      } else {
        const inviteToken = sessionStorage.getItem("invite_token") || undefined;
        await apiRegister(loginField, password, confirm, inviteToken);
        sessionStorage.removeItem("invite_token");
        setHasInviteToken(false);
        onLogin(await getCurrentUser());
      }
    } catch (err: unknown) {
      setError(loginErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  /**
   * Sign in through the one login endpoint and hand the fresh user up. Shared
   * by the manual form and the one-click demo button (#1179) — the demo uses
   * the same path as everyone else, never a separate auth route.
   */
  const performLogin = async (username: string, pw: string) => {
    await apiLogin(username, pw);
    const user = await getCurrentUser();
    onLogin(user);
  };

  const handleExploreDemo = async () => {
    if (!demoLogin || submittingDemo) return;
    setDemoError(null);
    setSubmittingDemo(true);
    try {
      await performLogin(demoLogin.username, demoLogin.password);
    } catch (err: unknown) {
      setDemoError(loginErrorMessage(err));
    } finally {
      setSubmittingDemo(false);
    }
  };

  const nextResetLabel = demoNextResetAt ? formatClockTime(demoNextResetAt) : "";
  // The cadence sentence is derived from the server's cron, never assumed:
  // only the hourly schedule may promise "every hour, on the hour". Any other
  // schedule falls back to a cadence-neutral sentence; the exact next reset
  // time below is always accurate. No `=== null` fallback here (#1180): an
  // absent schedule now means "no reset scheduled" and is handled entirely by
  // the nextResetLabel branch below, not by assuming an hourly cadence.
  const cadenceText =
    demoResetSchedule === "0 * * * *" || demoResetSchedule === "@hourly"
      ? "Resets every hour, on the hour"
      : "Resets on a regular schedule";

  return (
    <div className="min-h-screen bg-sunken flex items-center justify-center">
      <div className="bg-surface rounded-2xl shadow-2xl p-10 w-full max-w-sm">
        <div className="flex flex-col items-center mb-8">
          <img src="/brand/visiban_wordmark_dark.png" alt="Visiban" className="w-40" />
          {mode === "register" && !registrationOpen && hasInviteToken && (
            <p className="text-sm text-fg-secondary text-center mt-3">Complete your registration</p>
          )}
        </div>

        {/* Post-reset notice (#1179) — one-shot, shown once after the scheduled
            reset ended this tab's session. Informational tint, like the callout. */}
        {resetNoticeAt && (
          <div
            role="status"
            aria-live="polite"
            aria-atomic="true"
            data-testid="demo-reset-notice"
            className="mb-3 rounded border border-primary-emphasis/30 bg-primary-emphasis/10 px-3 py-2.5 text-sm text-fg-secondary"
          >
            The demo was reset at <strong className="font-semibold text-fg">{formatClockTime(resetNoticeAt)}</strong> — explore again.
          </div>
        )}

        {/* Hosted-demo callout (#1034, reworked in #1179) — informational, so the
            primary-emphasis tint, not the amber degraded-state treatment. "Explore
            the demo" is the page's primary action; the manual form below keeps its
            classes (it is the only affordance for a real account elsewhere) and is
            demoted by position only. */}
        {demoLogin && (
          <div
            role="note"
            data-testid="demo-banner"
            className="mb-5 rounded border border-primary-emphasis/30 bg-primary-emphasis/10 px-3 py-2.5 text-sm text-fg-secondary"
          >
            {/* No next reset means none is scheduled (#1180: the Helm chart's
                demo.reset.enabled=false renders DEMO_RESET_SCHEDULE empty), so
                the banner must not promise an erase or a sign-out that never
                comes. */}
            <p>
              <strong className="font-semibold text-fg">This is a shared demo.</strong>{" "}
              {nextResetLabel ? (
                <>
                  {cadenceText} — next reset at <strong className="font-semibold text-fg">{nextResetLabel}</strong> (your
                  local time). Everything you change is erased and you will be signed out.
                </>
              ) : (
                <>Other visitors can see and change everything here, and it is never reset.</>
              )}
            </p>
            <button
              type="button"
              onClick={handleExploreDemo}
              disabled={submittingDemo}
              className="mt-3 w-full bg-button-primary hover:bg-button-primary-hover text-on-primary font-medium py-2.5 rounded text-sm transition disabled:opacity-40 focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
            >
              {submittingDemo ? "Please wait…" : "Explore the demo"}
            </button>
            {demoError && <p className="mt-2 text-danger text-xs" role="alert">{demoError}</p>}
            <p className="mt-2 text-xs text-fg-muted">
              or sign in manually with <code className="font-mono text-fg select-all">{demoLogin.username}</code> /{" "}
              <code className="font-mono text-fg select-all">{demoLogin.password}</code> below.
            </p>
          </div>
        )}

        {/* OAuth email-collision banner (#1314) — sits in the same slot as the
            notices above, never in the thin error line under the form. */}
        {banner && (
          <div
            role="alert"
            data-testid="account-exists-banner"
            className="mb-5 rounded border border-danger/30 bg-danger/10 px-3 py-2.5 text-sm text-danger"
          >
            <p className="font-medium">You already have a Visiban account</p>
            <p className="mt-1 text-danger/90">
              {banner.kind === "account_exists"
                ? `This email is already registered. Log in with your password once and we'll connect ${labelFor(banner.provider)} for next time.`
                : `This email signs in with ${labelFor(banner.via)}. Continue with ${labelFor(banner.via)} and we'll connect ${labelFor(banner.provider)} afterwards.`}
            </p>
          </div>
        )}

        {banner?.kind === "account_exists_provider" ? (
          <div className="flex flex-col gap-3 mb-5">
            {/* The via provider's own brand colors: this starts a real
                redirect to that provider and must read as its button. */}
            <button
              type="button"
              onClick={() => startOAuth(banner.via)}
              className={`flex items-center justify-center gap-3 font-medium py-2.5 px-4 rounded transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis ${
                isProviderId(banner.via) ? PROVIDER_META[banner.via].buttonClassName : PROVIDER_META.oidc.buttonClassName
              }`}
            >
              <ProviderIcon id={banner.via} className="w-5 h-5" />
              Continue with {labelFor(banner.via)}
            </button>
            <div className="text-center">
              <button
                type="button"
                onClick={handleForgotPassword}
                className="text-xs text-fg-tertiary hover:text-fg underline focus:outline-none focus:ring-2 focus:ring-primary-emphasis rounded"
              >
                Can't access {labelFor(banner.via)}? Reset your password instead
              </button>
            </div>
          </div>
        ) : (
          <>
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
                    onClick={handleForgotPassword}
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
              className="w-full bg-button-primary hover:bg-button-primary-hover text-on-primary font-medium py-2.5 rounded text-sm transition disabled:opacity-40 focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
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
                    <ProviderIcon id="google" className="w-5 h-5" />
                    Continue with Google
                  </a>
                )}
                {providers.github && (
                  <a
                    href={oauthUrl("github", mode, hasInviteToken)}
                    className="flex items-center justify-center gap-3 bg-surface-hover text-fg font-medium py-2.5 px-4 rounded hover:bg-surface-active transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
                  >
                    <ProviderIcon id="github" className="w-5 h-5" />
                    Continue with GitHub
                  </a>
                )}
                {providers.gitlab && (
                  <a
                    href={oauthUrl("gitlab", mode, hasInviteToken)}
                    className="flex items-center justify-center gap-3 bg-warning-bg text-on-warning font-medium py-2.5 px-4 rounded hover:bg-warning-bg-hover transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
                  >
                    <ProviderIcon id="gitlab" className="w-5 h-5" />
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
          </>
        )}
      </div>
    </div>
  );
}
