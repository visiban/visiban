import { useState, useEffect, useRef } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { confirmPasswordReset } from "../api/auth";

export default function ResetPasswordPage() {
  const { uid, token } = useParams<{ uid: string; token: string }>();
  const navigate = useNavigate();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState(false);
  const [tokenInvalid, setTokenInvalid] = useState(!uid || !token);
  const [countdown, setCountdown] = useState(3);
  const successHeadingRef = useRef<HTMLHeadingElement>(null);
  const tokenErrorHeadingRef = useRef<HTMLHeadingElement>(null);

  // Focus the heading when entering a terminal state so screen readers announce
  // the state change without needing an aria-live region.
  useEffect(() => {
    if (success) successHeadingRef.current?.focus();
  }, [success]);

  useEffect(() => {
    if (tokenInvalid) tokenErrorHeadingRef.current?.focus();
  }, [tokenInvalid]);

  // Auto-redirect countdown after successful reset.
  useEffect(() => {
    if (!success) return;
    const timer = setInterval(() => {
      setCountdown((c) => {
        if (c <= 1) {
          clearInterval(timer);
          navigate("/");
          return 0;
        }
        return c - 1;
      });
    }, 1000);
    return () => clearInterval(timer);
  }, [success, navigate]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");

    if (password.length < 8) {
      setError("Password must be at least 8 characters.");
      return;
    }
    // eslint-disable-next-line security/detect-possible-timing-attacks -- client-side UI validation only, not a cryptographic comparison
    if (password !== confirm) { // nosemgrep
      setError("Passwords do not match.");
      return;
    }

    setSubmitting(true);
    try {
      await confirmPasswordReset(uid!, token!, password, confirm);
      setSuccess(true);
    } catch (err: unknown) {
      const data = (err as { response?: { data?: Record<string, unknown> } })?.response?.data;
      const isTokenError =
        !!(data?.token || data?.uid) ||
        (Array.isArray(data?.non_field_errors) &&
          (data.non_field_errors as string[]).some((m) => /token|invalid|expired/i.test(m)));
      if (isTokenError) {
        setTokenInvalid(true);
      } else {
        setError("Something went wrong. Please try again.");
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen bg-sunken flex items-center justify-center">
      <div className="bg-surface rounded-2xl shadow-2xl p-6 sm:p-10 w-full max-w-sm">
        <div className="flex flex-col items-center mb-8">
          <img src="/brand/visiban_wordmark_dark.png" alt="Visiban" className="w-40" />
        </div>

        {success ? (
          <>
            <h1
              ref={successHeadingRef}
              tabIndex={-1}
              className="text-xl font-semibold text-white mt-6 mb-2 focus:outline-none"
            >
              Password updated
            </h1>
            <p className="text-sm text-fg-tertiary mb-6">
              Your password has been reset. You can now sign in with your new
              password.
            </p>
            <button
              type="button"
              onClick={() => navigate("/")}
              className="w-full bg-blue-600 hover:bg-blue-700 text-white font-medium py-2.5 rounded text-sm transition focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              Sign in
            </button>
            <p className="text-xs text-fg-muted mt-3 text-center">
              Redirecting in {countdown}s…
            </p>
          </>
        ) : tokenInvalid ? (
          <>
            <h1
              ref={tokenErrorHeadingRef}
              tabIndex={-1}
              className="text-xl font-semibold text-white mt-6 mb-2 focus:outline-none"
            >
              Link expired or invalid
            </h1>
            <p className="text-sm text-fg-tertiary mb-6">
              This password reset link has expired or has already been used.
              Reset links are valid for 3 days and can only be used once.
            </p>
            <button
              type="button"
              onClick={() => navigate("/forgot-password")}
              className="w-full bg-blue-600 hover:bg-blue-700 text-white font-medium py-2.5 rounded text-sm transition focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              Request a new link
            </button>
            <p className="text-center text-xs text-fg-tertiary mt-3">
              <button
                type="button"
                onClick={() => navigate("/")}
                className="text-fg-tertiary hover:text-fg focus:outline-none focus:ring-2 focus:ring-blue-500 rounded transition"
              >
                ← Back to sign in
              </button>
            </p>
          </>
        ) : (
          <>
            <h1 className="text-xl font-semibold text-white mt-6 mb-6">
              Set a new password
            </h1>
            <form onSubmit={handleSubmit} className="flex flex-col gap-3">
              <div>
                <label htmlFor="rp-password" className="block text-fg-tertiary text-xs mb-1">
                  New password
                </label>
                <input
                  id="rp-password"
                  type="password"
                  required
                  autoFocus
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="w-full bg-surface border border-line text-fg-secondary placeholder-fg-muted rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                />
                <p className="text-xs text-fg-muted mt-1">Must be at least 8 characters</p>
              </div>
              <div>
                <label htmlFor="rp-confirm" className="block text-fg-tertiary text-xs mb-1">
                  Confirm new password
                </label>
                <input
                  id="rp-confirm"
                  type="password"
                  required
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  className="w-full bg-surface border border-line text-fg-secondary placeholder-fg-muted rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                />
              </div>
              <p className="text-xs h-4">
                {error && <span className="text-danger" role="alert">{error}</span>}
              </p>
              <button
                type="submit"
                disabled={submitting}
                className="w-full bg-blue-600 hover:bg-blue-700 text-white font-medium py-2.5 rounded text-sm transition disabled:opacity-40 disabled:cursor-not-allowed focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                {submitting ? "Resetting…" : "Set new password"}
              </button>
              <p className="text-center text-xs text-fg-tertiary mt-1">
                <button
                  type="button"
                  onClick={() => navigate("/")}
                  className="text-fg-tertiary hover:text-fg focus:outline-none focus:ring-2 focus:ring-blue-500 rounded transition"
                >
                  ← Back to sign in
                </button>
              </p>
            </form>
          </>
        )}
      </div>
    </div>
  );
}
