import { useEffect, useRef, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import type { BoardInviteRole } from "../api/boards";
import { BOARD_INVITE, GROUP_INVITE, inviteKindOf, joinInvite } from "../api/inviteKinds";
import { getAuthProviders, logout } from "../api/auth";
import type { User } from "../types";
import { providerLoginUrl } from "../utils/oauth";
import ProviderButtons from "../components/Auth/ProviderButtons";
import { enabledProviders, type AuthProviders } from "../components/Auth/providers";
import { Button, CenteredHeader, CenteredLayout, OrDivider, RedirectCountdown, StatusCard, buttonClasses } from "../components/Page";

interface Props {
  user: User | null;
  onLogin: (user: User) => void;
}

type BoardGoneCode = "used" | "expired" | "revoked";

// What each board role lets the invitee do (#1444) — shown under the preview.
const BOARD_CAPABILITY: Record<BoardInviteRole, string> = {
  member: "You'll be able to create, edit, and move cards.",
  collaborator: "You'll be able to comment and upload files.",
  viewer: "You'll be able to view the board.",
};

function goneCode(err: unknown): BoardGoneCode | null {
  const res = (err as { response?: { status?: number; data?: { code?: string } } }).response;
  if (res?.status !== 410) return null;
  const code = res.data?.code;
  return code === "used" || code === "expired" ? code : "revoked";
}

/**
 * The server's message when an emailed invite was sent to a different address
 * than the signed-in account's (#1678): 403 with code
 * ``invite_recipient_mismatch``. The detail never names the invited address,
 * so it is shown as-is. Null for any other failure.
 */
function recipientMismatchDetail(err: unknown): string | null {
  const res = (err as { response?: { status?: number; data?: { code?: string; detail?: string } } }).response;
  if (res?.status !== 403 || res.data?.code !== "invite_recipient_mismatch") return null;
  return res.data.detail ?? "This invite was sent to a different email address.";
}

/**
 * The /join/<token> landing page for every invite kind. One component, not a
 * fork per kind: the token's prefix picks the API — ``vbnl_`` (site, straight
 * to registration), ``vbnb_`` (board, #1444), anything else a group invite —
 * and the rest of the page renders from the same name/id state.
 */
export default function JoinPage({ user }: Props) {
  const { token } = useParams<{ token: string }>();
  const navigate = useNavigate();
  // Name/id of what the invite joins: a group, or a board for vbnb_ tokens.
  const [groupName, setGroupName] = useState<string | null>(null);
  const [groupId, setGroupId] = useState<number | null>(null);
  const [boardRole, setBoardRole] = useState<BoardInviteRole | null>(null);
  // Group invites: the preview's advisory role, when the backend returns one (#2479).
  const [groupRole, setGroupRole] = useState<string | null>(null);
  const [boardGone, setBoardGone] = useState<BoardGoneCode>("revoked");
  const titleRef = useRef<HTMLHeadingElement & HTMLParagraphElement>(null);
  const [loading, setLoading] = useState(true);
  const [joining, setJoining] = useState(false);
  const [invalid, setInvalid] = useState(false);
  const [invalidReason, setInvalidReason] = useState<"expired" | "already_used">("expired");
  const [joinError, setJoinError] = useState<string | null>(null);
  // From the preview's advisory `can_register` (#1481). Only a literal false
  // switches to the sign-in-only view; undefined (older backend) keeps the
  // original layout.
  const [canRegister, setCanRegister] = useState<boolean | undefined>();
  const [providers, setProviders] = useState<AuthProviders | null>(null);
  // The join failed because the invite names another address (#1678): offer to switch account (#2479).
  const [mismatch, setMismatch] = useState(false);
  // Prevent double-firing auto-join in React StrictMode.
  const autoJoinFired = useRef(false);

  // Site-wide invite links (vbnl_ prefix) are for registration, not group joining.
  // Redirect to the login page with the token so the registration form can consume it.
  const kindName = token ? inviteKindOf(token).name : null;
  const isSiteInvite = kindName === "site";
  const isBoardInvite = kindName === "board";

  useEffect(() => {
    if (!token) return;
    if (isSiteInvite) {
      // Store the invite token for the registration form to pick up.
      sessionStorage.setItem("invite_token", token);
      // void: navigate() can return a Promise in React Router v7; fire-and-forget,
      // there is nothing to roll back if the navigation itself rejects.
      void navigate("/", { state: { authMode: "register" }, replace: true });
      return;
    }
    if (isBoardInvite) {
      BOARD_INVITE.resolve(token)
        .then((data) => {
          setGroupName(data.board_name);
          setGroupId(data.board_id);
          setBoardRole(data.role);
          setCanRegister(data.can_register);
        })
        .catch((err) => {
          // 410 names why; a 404 (unknown token) reads as "no longer valid".
          setBoardGone(goneCode(err) ?? "revoked");
          setInvalid(true);
        })
        .finally(() => setLoading(false));
      return;
    }
    // Resolve through the table so a kind added to INVITE_KINDS is previewed by
    // its own endpoint, not silently by the group one (#1491). Only the group
    // payload shape is handled here; a new kind needs its own branch above.
    (inviteKindOf(token).resolve as typeof GROUP_INVITE.resolve)(token)
      .then((data) => {
        setGroupName(data.group_name);
        setGroupId(data.group_id);
        setGroupRole(data.role ?? null);
        setCanRegister(data.can_register);
      })
      .catch((err) => {
        const httpStatus = (err as { response?: { status?: number } }).response?.status;
        setInvalidReason(httpStatus === 410 ? "already_used" : "expired");
        setInvalid(true);
      })
      .finally(() => setLoading(false));
  }, [token, isSiteInvite, isBoardInvite, navigate]);

  // Board invites: move focus to the title when the page switches to the
  // invalid or join-failed view, so a screen reader announces the outcome.
  useEffect(() => {
    if (isBoardInvite && (invalid || joinError)) titleRef.current?.focus();
  }, [isBoardInvite, invalid, joinError]);


  useEffect(() => {
    if (!user) {
      getAuthProviders()
        .then(setProviders)
        .catch(() => setProviders({ google: false, github: false, gitlab: false, oidc: false, oidc_name: null }));
    }
  }, [user]);

  // Auto-join: fires when the user is already authenticated and the token has resolved.
  // Replaces the manual "Join" button — authenticated users should land in the group
  // without an extra click.
  const joinBoardAndGo = (raw: string) =>
    joinInvite(raw)
      .then((outcome) => navigate(outcome.path, { state: outcome.state }))
      .catch((err) => {
        const code = goneCode(err);
        if (code) {
          // Used, expired or revoked since the preview: say which.
          setBoardGone(code);
          setInvalid(true);
        } else {
          setMismatch(recipientMismatchDetail(err) !== null);
          setJoinError(
            recipientMismatchDetail(err)
              ?? `Couldn't join ${groupName}. The invite may have expired or been used.`,
          );
        }
        setJoining(false);
      });

  useEffect(() => {
    if (!user || !groupId || !token || autoJoinFired.current) return;
    autoJoinFired.current = true;
    setJoining(true);
    if (isBoardInvite) {
      void joinBoardAndGo(token);
      return;
    }
    joinInvite(token)
      .then((outcome) => navigate(outcome.path, { state: outcome.state }))
      .catch((err) => {
        setMismatch(recipientMismatchDetail(err) !== null);
        setJoinError(recipientMismatchDetail(err) ?? "Failed to join group. The invite may have expired.");
        setJoining(false);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- joinBoardAndGo is recreated each render; the guard ref makes this fire once
  }, [user, groupId, token, groupName, navigate, isBoardInvite]);

  const handleRetry = () => {
    autoJoinFired.current = false;
    setJoinError(null);
    setJoining(true);
    if (!token) return;
    if (isBoardInvite) {
      void joinBoardAndGo(token);
      return;
    }
    joinInvite(token)
      .then((outcome) => navigate(outcome.path, { state: outcome.state }))
      .catch((err) => {
        setMismatch(recipientMismatchDetail(err) !== null);
        setJoinError(recipientMismatchDetail(err) ?? "Failed to join group. The invite may have expired.");
        setJoining(false);
      });
  };

  const handleAuthRedirect = (mode: "login" | "register") => {
    sessionStorage.setItem("pendingJoinToken", token!);
    sessionStorage.setItem("returnTo", `/join/${token}`);
    // An emailed group invite also authorizes sign-up on an invite-only site
    // (#1445): hand the token to the registration form, which sends it as
    // invite_token. Open sites ignore it; a shareable link is refused there
    // with a message saying so.
    if (mode === "register") sessionStorage.setItem("invite_token", token!);
    // void: navigate() can return a Promise in React Router v7; fire-and-forget,
    // there is nothing to roll back if the navigation itself rejects.
    void navigate("/", { state: { authMode: mode } });
  };

  const handleOAuthRedirect = (provider: string) => {
    // Store token for both paths: password login consumes returnTo via handleLogin
    // and navigates to JoinPage; OAuth returns to the root where App.tsx consumes
    // pendingJoinToken directly (handleLogin is never called for OAuth).
    sessionStorage.setItem("pendingJoinToken", token!);
    sessionStorage.setItem("returnTo", `/join/${token}`);
    // The backend stashes the token for an OAuth sign-up on an invite-only
    // site (#1445); an existing account signing in never reads it.
    window.location.href = `${providerLoginUrl(provider)}&invite_token=${encodeURIComponent(token!)}`;
  };

  // Signs out and reloads this invite signed out, so the visitor can sign in with the invited
  // account (#2479). A full reload, not navigate(): App holds the signed-in user in state.
  const handleSwitchAccount = () => {
    void logout()
      .catch(() => undefined)
      .finally(() => window.location.assign(`/join/${token}`));
  };

  const groupRoleLabel = groupRole ? groupRole.charAt(0).toUpperCase() + groupRole.slice(1) : null;
  const roleLabel = boardRole ? boardRole.charAt(0).toUpperCase() + boardRole.slice(1) : null;

  if (loading) {
    return (
      <CenteredLayout testId="join-page">
        <h1 className="sr-only">Checking invite</h1>
        <p role="status" className="text-center text-sm text-fg-secondary">Checking invite…</p>
      </CenteredLayout>
    );
  }

  if (invalid) {
    // Today's wording per link kind (#2479), in the status-card part.
    const [title, body] = isBoardInvite
      ? boardGone === "used"
        ? ["This invite has already been used", "This invite could only be used once. Ask a board admin to send you a new one."]
        : boardGone === "expired"
          ? ["This invite has expired", "Ask a board admin for a new invite."]
          : ["This invite is no longer valid", "It may have been revoked. Ask a board admin for a new one."]
      : invalidReason === "already_used"
        ? ["This link has already been used", "This was a single-use invite link. Ask a group admin for a new one."]
        : ["Invalid or expired invite link", "This link may have been revoked or has expired."];
    return (
      <CenteredLayout testId="join-page">
        <StatusCard
          title={title}
          // A used link is a spent one-shot, not a fault; the rest are.
          tone={(isBoardInvite ? boardGone === "used" : invalidReason === "already_used") ? "neutral" : "danger"}
          headingRef={isBoardInvite ? titleRef : undefined}
          actions={
            <a href="/" className={buttonClasses("primary", { size: "lg", fullWidth: true })}>
              {user ? "Go to Home" : "Go to sign in"}
            </a>
          }
        >
          <p>{body}</p>
          {/* void: navigate() can return a Promise in React Router v7; nothing to roll back. */}
          <RedirectCountdown seconds={5} destination={user ? "Home" : "sign in"} onDone={() => { void navigate("/"); }} />
        </StatusCard>
      </CenteredLayout>
    );
  }

  const hasOAuth = enabledProviders(providers).length > 0;
  // The link cannot create an account here (CLOSED site, shareable link,
  // non-admin sender, or email invites off — deliberately not said which), so
  // steer the visitor to sign in before they fill in a form that would 400.
  const registerBlocked = canRegister === false;

  return (
    <CenteredLayout testId="join-page">
      {/* Only what the anonymous preview returns: name, role and can_register (#2479). */}
      <CenteredHeader
        title="You're invited"
        headingRef={titleRef}
        subtitle={
          isBoardInvite && roleLabel ? (
            <>
              <p>Join the board <span className="text-fg font-semibold break-words">{groupName}</span> as a {roleLabel}</p>
              <p className="mt-1 text-xs text-fg-tertiary">{BOARD_CAPABILITY[boardRole!]}</p>
            </>
          ) : (
            <p>
              Join the group <span className="text-fg font-semibold break-words">{groupName}</span>
              {groupRoleLabel ? ` as ${/^[AEIOU]/.test(groupRoleLabel) ? "an" : "a"} ${groupRoleLabel}` : ""}
            </p>
          )
        }
      />

      {user ? (
        <div className="flex flex-col items-center gap-3 min-h-[4rem] justify-center text-center">
          {joining ? (
            <div role="status" className="flex items-center gap-2">
              <span aria-hidden="true" className="w-5 h-5 border-2 border-primary border-t-transparent rounded-full animate-spin" />
              <p className="text-fg-secondary text-sm truncate max-w-full">Joining…</p>
            </div>
          ) : joinError ? (
            <>
              <p role="alert" className="text-danger text-sm break-words">{joinError}</p>
              {mismatch ? (
                <Button variant="primary" size="lg" fullWidth onClick={handleSwitchAccount}>Sign out and switch account</Button>
              ) : (
                <Button variant="primary" size="lg" fullWidth onClick={handleRetry}>Try again</Button>
              )}
            </>
          ) : null}
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {registerBlocked ? (
            <>
              <p className="text-fg-secondary text-sm text-center">
                This invite link can't be used to create a new account. Sign in with an existing account to join.
              </p>
              <Button variant="primary" size="lg" fullWidth onClick={() => handleAuthRedirect("login")} aria-label={`Sign in to join ${groupName}`}>
                Sign in
              </Button>
            </>
          ) : (
            <>
              <p className="text-fg-secondary text-sm text-center">
                To accept this invitation you need a Visiban account.
              </p>
              <Button variant="primary" size="lg" fullWidth onClick={() => handleAuthRedirect("register")}>
                Create account and join
              </Button>
              <Button variant="secondary" size="lg" fullWidth onClick={() => handleAuthRedirect("login")}>
                I already have an account
              </Button>
            </>
          )}

          {hasOAuth && (
            <>
              <OrDivider label="or continue with" />
              <ProviderButtons providers={providers} onSelect={handleOAuthRedirect} />
            </>
          )}
        </div>
      )}
    </CenteredLayout>
  );
}
