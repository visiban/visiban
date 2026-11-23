import { useEffect, useRef, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { verifyEmail } from "../api/auth";
import { BrandTile, Button, CenteredLayout, RedirectCountdown, StatusCard } from "../components/Page";

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

  return (
    <CenteredLayout testId="confirm-email-page">
      {status === "loading" && (
        <div role="status" className="flex flex-col items-center gap-3 py-4">
          <h1 className="sr-only">Verifying your email</h1>
          <BrandTile />
          <span aria-hidden="true" className="w-8 h-8 border-2 border-primary border-t-transparent rounded-full animate-spin" />
          <p className="text-sm text-fg-secondary">Verifying your email…</p>
        </div>
      )}

      {status === "success" && (
        <StatusCard
          title="Email verified"
          tone="success"
          headingRef={successHeadingRef}
          actions={<Button variant="primary" size="lg" fullWidth onClick={() => navigate("/")}>Sign in</Button>}
        >
          <p>Your email address has been confirmed. You can now sign in.</p>
          {/* void: navigate() can return a Promise in React Router v7; nothing to roll back. */}
          <RedirectCountdown seconds={3} onDone={() => { void navigate("/"); }} />
        </StatusCard>
      )}

      {status === "error" && (
        <StatusCard
          title="Link expired or invalid"
          tone="danger"
          headingRef={errorHeadingRef}
          actions={<Button variant="primary" size="lg" fullWidth onClick={() => navigate("/")}>Go to sign in</Button>}
        >
          <p>
            This confirmation link has expired or has already been used.
            Ask your admin to resend the invitation, or sign in if your
            account is already active.
          </p>
        </StatusCard>
      )}

      {status === "in_use" && (
        <StatusCard
          title="Email address already in use"
          tone="danger"
          headingRef={inUseHeadingRef}
          actions={
            <Button variant="primary" size="lg" fullWidth onClick={() => navigate(isAuthenticated ? "/settings" : "/")}>
              {isAuthenticated ? "Go to Settings" : "Go to sign in"}
            </Button>
          }
        >
          <p>
            This email address already belongs to another account, so it
            can&apos;t be confirmed for this one.{" "}
            {isAuthenticated
              ? "If you were changing your email address, go to Settings → Profile to cancel the change or choose a different address."
              : "If you were signing up, sign up again with a different email address, or sign in to the account that already uses this one."}
          </p>
        </StatusCard>
      )}
    </CenteredLayout>
  );
}
