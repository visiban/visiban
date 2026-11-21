import { useState, useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { requestPasswordReset } from "../api/auth";
import { Button, CenteredHeader, CenteredLayout, Field, StatusCard, buttonClasses } from "../components/Page";

export default function ForgotPasswordPage() {
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
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
    <CenteredLayout testId="forgot-password-page">
      {submitted ? (
        // Never says whether an account uses the address (#2479).
        <StatusCard
          title="Check your email"
          tone="success"
          headingRef={confirmHeadingRef}
          actions={<Button variant="primary" size="lg" fullWidth onClick={() => navigate("/")}>Back to sign in</Button>}
        >
          <p>If an account uses that address, a reset link is on its way.</p>
          <p className="mt-2">Check your spam folder if it doesn&apos;t arrive within a few minutes.</p>
        </StatusCard>
      ) : (
        <>
          <CenteredHeader title="Reset your password" subtitle={<p>Enter your account&apos;s email and we&apos;ll send a reset link.</p>} />
          <form onSubmit={handleSubmit} className="flex flex-col gap-3">
            <Field
              id="fp-email"
              label="Email"
              type="email"
              autoComplete="email"
              required
              autoFocus
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
            {error && <p className="text-xs text-danger" role="alert">{error}</p>}
            <button type="submit" disabled={submitting} className={buttonClasses("primary", { size: "lg", fullWidth: true })}>
              {submitting ? "Sending…" : "Send reset link"}
            </button>
            <Button variant="quiet" size="lg" fullWidth onClick={() => navigate("/")}>Back to sign in</Button>
          </form>
        </>
      )}
    </CenteredLayout>
  );
}
