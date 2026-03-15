import { useState, useEffect } from "react";
import { useLocation } from "react-router-dom";
import { login as apiLogin, register as apiRegister, getCurrentUser, getAuthProviders, getSiteConfig } from "../../api/auth";
import type { User } from "../../types";

const API = import.meta.env.VITE_API_URL ?? "http://localhost:8000";

interface Props {
  onLogin: (user: User) => void;
}

export default function LoginPage({ onLogin }: Props) {
  const location = useLocation();
  const [mode, setMode] = useState<"login" | "register">(
    (location.state as { authMode?: string } | null)?.authMode === "register" ? "register" : "login"
  );
  const [loginField, setLoginField] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [providers, setProviders] = useState<{ google: boolean; github: boolean; gitlab: boolean } | null>(null);
  const [registrationOpen, setRegistrationOpen] = useState(true);

  useEffect(() => {
    getAuthProviders().then(setProviders).catch(() => setProviders({ google: false, github: false, gitlab: false }));
    getSiteConfig().then((c) => setRegistrationOpen(c.registration_open)).catch(() => setRegistrationOpen(true));
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (mode === "register") {
      if (password !== confirm) { setError("Passwords do not match."); return; } // nosemgrep
      if (password.length < 8) { setError("Password must be at least 8 characters."); return; }
    }

    setSubmitting(true);
    try {
      if (mode === "login") {
        await apiLogin(loginField, password);
      } else {
        await apiRegister(loginField, password, confirm);
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
    <div className="min-h-screen bg-slate-900 flex items-center justify-center">
      <div className="bg-slate-800 rounded-2xl shadow-2xl p-10 w-full max-w-sm">
        <div className="flex flex-col items-center mb-8">
          <img src="/brand/visiban_wordmark_dark.png" alt="Visiban" className="w-40" />
        </div>

        {/* Email/password form */}
        <form onSubmit={handleSubmit} className="flex flex-col gap-3 mb-5">
          <input
            type="text"
            required
            placeholder={mode === "login" ? "Username or email" : "Email address"}
            value={loginField}
            onChange={(e) => setLoginField(e.target.value)}
            className="w-full bg-slate-700 text-white placeholder-slate-400 rounded-lg px-4 py-2.5 text-sm outline-none focus:ring-2 focus:ring-primary"
          />
          <input
            type="password"
            required
            placeholder="Password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="w-full bg-slate-700 text-white placeholder-slate-400 rounded-lg px-4 py-2.5 text-sm outline-none focus:ring-2 focus:ring-primary"
          />
          {mode === "register" && (
            <input
              type="password"
              required
              placeholder="Confirm password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              className="w-full bg-slate-700 text-white placeholder-slate-400 rounded-lg px-4 py-2.5 text-sm outline-none focus:ring-2 focus:ring-primary"
            />
          )}
          {mode === "register" && !registrationOpen && (
            <p className="text-slate-400 text-xs text-center">
              An invite link is required to create an account.
            </p>
          )}
          {error && <p className="text-red-400 text-xs">{error}</p>}
          <button
            type="submit"
            disabled={submitting || (mode === "register" && !registrationOpen)}
            className="w-full bg-primary hover:bg-primary/90 text-white font-medium py-2.5 rounded-lg text-sm transition disabled:opacity-50"
          >
            {submitting ? "Please wait…" : mode === "login" ? "Sign in" : "Create account"}
          </button>
          <p className="text-center text-xs text-slate-400">
            {mode === "login" ? "Don't have an account?" : "Already have an account?"}{" "}
            {mode === "login" && !registrationOpen ? (
              <span className="text-slate-500">Registration is invite-only.</span>
            ) : (
              <button
                type="button"
                onClick={() => { setMode(mode === "login" ? "register" : "login"); setError(null); }}
                className="text-accent hover:text-accent/80 underline"
              >
                {mode === "login" ? "Create one" : "Sign in"}
              </button>
            )}
          </p>
        </form>

        {/* OAuth buttons — only shown when credentials are configured */}
        {providers && (providers.google || providers.github || providers.gitlab) && (
          <>
            <div className="flex items-center gap-3 mb-5">
              <div className="flex-1 h-px bg-slate-600" />
              <span className="text-xs text-slate-500">or continue with</span>
              <div className="flex-1 h-px bg-slate-600" />
            </div>
            <div className="flex flex-col gap-3">
              {providers.google && (
                <a
                  href={`${API}/accounts/google/login/?process=login`}
                  className="flex items-center justify-center gap-3 bg-white text-gray-900 font-medium py-2.5 px-4 rounded-lg hover:bg-gray-100 transition"
                >
                  <GoogleIcon />
                  Continue with Google
                </a>
              )}
              {providers.github && (
                <a
                  href={`${API}/accounts/github/login/?process=login`}
                  className="flex items-center justify-center gap-3 bg-slate-700 text-white font-medium py-2.5 px-4 rounded-lg hover:bg-slate-600 transition"
                >
                  <GitHubIcon />
                  Continue with GitHub
                </a>
              )}
              {providers.gitlab && (
                <a
                  href={`${API}/accounts/gitlab/login/?process=login`}
                  className="flex items-center justify-center gap-3 bg-orange-600 text-white font-medium py-2.5 px-4 rounded-lg hover:bg-orange-500 transition"
                >
                  <GitLabIcon />
                  Continue with GitLab
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
