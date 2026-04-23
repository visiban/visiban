import { useEffect, useRef, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { verifyEmail } from "../api/auth";

export default function ConfirmEmailPage() {
  const { key } = useParams<{ key: string }>();
  const navigate = useNavigate();
  const [status, setStatus] = useState<"loading" | "success" | "error">("loading");
  const [countdown, setCountdown] = useState(3);
  const hasFired = useRef(false);
  const successHeadingRef = useRef<HTMLHeadingElement>(null);
  const errorHeadingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    if (hasFired.current || !key) return;
    hasFired.current = true;
    verifyEmail(key)
      .then(() => setStatus("success"))
      .catch(() => setStatus("error"));
  }, [key]);

  useEffect(() => {
    if (status === "success") successHeadingRef.current?.focus();
    if (status === "error") errorHeadingRef.current?.focus();
  }, [status]);

  useEffect(() => {
    if (status !== "success") return;
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
  }, [status, navigate]);

  return (
    <div className="min-h-screen bg-sunken flex items-center justify-center">
      <div className="bg-surface rounded-2xl shadow-2xl p-6 sm:p-10 w-full max-w-sm">
        <div className="flex flex-col items-center mb-8">
          <img src="/brand/visiban_wordmark_dark.png" alt="Visiban" className="w-40" />
        </div>

        {status === "loading" && (
          <div className="flex flex-col items-center gap-3 py-4">
            <div className="w-8 h-8 border-2 border-primary border-t-transparent rounded-full animate-spin" />
            <p className="text-sm text-fg-tertiary">Verifying your email…</p>
          </div>
        )}

        {status === "success" && (
          <>
            <h1
              ref={successHeadingRef}
              tabIndex={-1}
              className="text-xl font-semibold text-fg mt-2 mb-2 focus:outline-none"
            >
              Email verified
            </h1>
            <p className="text-sm text-fg-tertiary mb-6">
              Your email address has been confirmed. You can now sign in.
            </p>
            <button
              type="button"
              onClick={() => navigate("/")}
              className="w-full bg-button-primary hover:bg-button-primary-hover text-on-primary font-medium py-2.5 rounded text-sm transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
            >
              Sign in
            </button>
            <p className="text-xs text-fg-muted mt-3 text-center">
              Redirecting in {countdown}s…
            </p>
          </>
        )}

        {status === "error" && (
          <>
            <h1
              ref={errorHeadingRef}
              tabIndex={-1}
              className="text-xl font-semibold text-fg mt-2 mb-2 focus:outline-none"
            >
              Link expired or invalid
            </h1>
            <p className="text-sm text-fg-tertiary mb-6">
              This confirmation link has expired or has already been used.
              Ask your admin to resend the invitation, or sign in if your
              account is already active.
            </p>
            <button
              type="button"
              onClick={() => navigate("/")}
              className="w-full bg-button-primary hover:bg-button-primary-hover text-on-primary font-medium py-2.5 rounded text-sm transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
            >
              Go to sign in
            </button>
          </>
        )}
      </div>
    </div>
  );
}
