import { useEffect, useRef, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { verifyEmail } from "../api/auth";

/**
 * `isAuthenticated` only changes the "address already in use" next step
 * (#1293): a signed-in user was most likely changing their address and can
 * fix it in Settings; a signed-out one was most likely signing up, and
 * Settings would be a dead end for them.
 */
export default function ConfirmEmailPage({ isAuthenticated = false }: { isAuthenticated?: boolean }) {
  const { key } = useParams<{ key: string }>();
  const navigate = useNavigate();
  // "in_use" (#1293): the key is valid, but another account has already
  // verified this address, so it can't be confirmed for this one. Shown only to
  // whoever holds the link, i.e. controls the inbox, so it discloses nothing
  // they couldn't already learn (see accounts.views.VerifyEmailView).
  const [status, setStatus] = useState<"loading" | "success" | "error" | "in_use">("loading");
  const [countdown, setCountdown] = useState(3);
  const hasFired = useRef(false);
  const successHeadingRef = useRef<HTMLHeadingElement>(null);
  const errorHeadingRef = useRef<HTMLHeadingElement>(null);
  const inUseHeadingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    if (hasFired.current || !key) return;
    hasFired.current = true;
    verifyEmail(key)
      .then(() => setStatus("success"))
      .catch((err) => {
        const response = (err as { response?: { status?: number; data?: { code?: unknown } } })?.response;
        setStatus(response?.status === 409 && response.data?.code === "email_in_use" ? "in_use" : "error");
      });
  }, [key]);

  useEffect(() => {
    if (status === "success") successHeadingRef.current?.focus();
    if (status === "error") errorHeadingRef.current?.focus();
    if (status === "in_use") inUseHeadingRef.current?.focus();
  }, [status]);

  useEffect(() => {
    if (status !== "success") return;
    const timer = setInterval(() => {
      setCountdown((c) => {
        if (c <= 1) {
          clearInterval(timer);
          // void: navigate() can return a Promise in React Router v7; fire-and-forget,
          // there is nothing to roll back if the navigation itself rejects.
          void navigate("/");
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

        {status === "in_use" && (
          <>
            <h1
              ref={inUseHeadingRef}
              tabIndex={-1}
              className="text-xl font-semibold text-fg mt-2 mb-2 focus:outline-none"
            >
              Email address already in use
            </h1>
            <p className="text-sm text-fg-tertiary mb-6">
              This email address already belongs to another account, so it
              can't be confirmed for this one.{" "}
              {isAuthenticated
                ? "If you were changing your email address, go to Settings → Profile to cancel the change or choose a different address."
                : "If you were signing up, sign up again with a different email address, or sign in to the account that already uses this one."}
            </p>
            <button
              type="button"
              onClick={() => navigate(isAuthenticated ? "/settings" : "/")}
              className="w-full bg-button-primary hover:bg-button-primary-hover text-on-primary font-medium py-2.5 rounded text-sm transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
            >
              {isAuthenticated ? "Go to Settings" : "Go to sign in"}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
