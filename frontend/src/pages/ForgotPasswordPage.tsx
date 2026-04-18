import { useState, useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { requestPasswordReset } from "../api/auth";

export default function ForgotPasswordPage() {
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [submittedEmail, setSubmittedEmail] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState("");
  const confirmHeadingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    if (submitted) {
      confirmHeadingRef.current?.focus();
    }
  }, [submitted]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setSubmittedEmail(email);
    setSubmitting(true);
    try {
      await requestPasswordReset(email);
      setSubmitted(true);
    } catch {
      setError("Something went wrong. Please try again.");
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

        {submitted ? (
          <>
            <h1
              ref={confirmHeadingRef}
              tabIndex={-1}
              className="text-xl font-semibold text-fg mt-6 mb-2 focus:outline-none"
            >
              Check your email
            </h1>
            <p className="text-sm text-fg-tertiary mb-6">
              If an account exists for{" "}
              <span className="font-medium text-fg-secondary break-all">{submittedEmail}</span>
              , you'll receive a link to reset your password shortly. Check your
              spam folder if it doesn't arrive within a few minutes.
            </p>
            <button
              type="button"
              onClick={() => navigate("/")}
              className="w-full bg-blue-600 hover:bg-blue-700 text-white font-medium py-2.5 rounded text-sm transition focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              Back to sign in
            </button>
          </>
        ) : (
          <>
            <h1 className="text-xl font-semibold text-fg mt-6 mb-2">
              Reset your password
            </h1>
            <p className="text-sm text-fg-tertiary mb-6">
              Enter your email address and we'll send you a link to reset your
              password.
            </p>
            <form onSubmit={handleSubmit} className="flex flex-col gap-3">
              <div>
                <label htmlFor="fp-email" className="block text-fg-tertiary text-xs mb-1">
                  Email address
                </label>
                <input
                  id="fp-email"
                  type="email"
                  required
                  autoFocus
                  placeholder="you@example.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
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
                {submitting ? "Sending…" : "Send reset link"}
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
