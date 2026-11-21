import { useState, useEffect, useRef } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { confirmPasswordReset } from "../api/auth";
import { Button, CenteredHeader, CenteredLayout, Field, StatusCard, buttonClasses } from "../components/Page";

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
          // void: navigate() can return a Promise in React Router v7; fire-and-forget,
          // there is nothing to roll back if the navigation itself rejects.
          void navigate("/");
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

    if (password.length < 12) {
      setError("Password must be at least 12 characters.");
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
    <CenteredLayout testId="reset-password-page">
      {success ? (
        <StatusCard
          title="Password updated"
          tone="success"
          headingRef={successHeadingRef}
          actions={<Button variant="primary" size="lg" fullWidth onClick={() => navigate("/")}>Sign in</Button>}
        >
          <p>Your password has been reset. You can now sign in with your new password.</p>
          <p className="mt-2 text-xs text-fg-tertiary">Redirecting in {countdown}s…</p>
        </StatusCard>
      ) : tokenInvalid ? (
        <StatusCard
          title="Link expired or invalid"
          tone="danger"
          headingRef={tokenErrorHeadingRef}
          actions={
            <>
              <Button variant="primary" size="lg" fullWidth onClick={() => navigate("/forgot-password")}>Request a new link</Button>
              <Button variant="quiet" size="lg" fullWidth onClick={() => navigate("/")}>← Back to sign in</Button>
            </>
          }
        >
          <p>This password reset link has expired or has already been used. Reset links are valid for 3 days and can only be used once.</p>
        </StatusCard>
      ) : (
        <>
          <CenteredHeader title="Choose a new password" />
          <form onSubmit={handleSubmit} className="flex flex-col gap-3">
            <Field
              id="rp-password"
              label="New password"
              type="password"
              autoComplete="new-password"
              required
              autoFocus
              hint="Must be at least 12 characters"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
            <Field
              id="rp-confirm"
              label="Confirm new password"
              type="password"
              autoComplete="new-password"
              required
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
            />
            {error && <p className="text-xs text-danger" role="alert">{error}</p>}
            <button type="submit" disabled={submitting} className={buttonClasses("primary", { size: "lg", fullWidth: true })}>
              {submitting ? "Resetting…" : "Set new password"}
            </button>
            <Button variant="quiet" size="lg" fullWidth onClick={() => navigate("/")}>← Back to sign in</Button>
          </form>
        </>
      )}
    </CenteredLayout>
  );
}
