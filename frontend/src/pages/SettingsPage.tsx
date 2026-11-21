import { useState, useEffect, useCallback, useRef, cloneElement, Fragment } from "react";
import { useNavigate, useLocation, useSearchParams } from "react-router-dom";
import { useEscapeStack } from "../hooks/useEscapeStack";
import { useConfirmFocusReturn } from "../hooks/useConfirmFocusReturn";
import { useConfirmAnnouncement } from "../hooks/useConfirmAnnouncement";
import type { Location } from "react-router-dom";
import { getCurrentUser, updateCurrentUser, changePassword, listTokens, createToken, revokeToken, resetTour, cancelPendingEmailChange, resendPendingEmailConfirmation, getAuthProviders, listConnectedAccounts, disconnectAccount } from "../api/auth";
import Navbar from "../components/Layout/Navbar";
import type { User, PersonalAccessToken, PersonalAccessTokenScope, CreatedPersonalAccessToken, ConnectedAccount, ProviderId } from "../types";
import { ProviderIcon, providerLabel } from "../components/Common/ProviderIcons";
import { startProviderConnect } from "../utils/oauth";
import { useTheme } from "../context/ThemeContext";
import type { ThemePreference } from "../context/ThemeContext";
import { TIMEZONE_OPTIONS, browserTimezone, formatDate as formatDateUtil } from "../utils/date";
import type { UserDatePrefs } from "../utils/date";
import SelectDropdown from "../components/Common/SelectDropdown";
import Avatar from "../components/Common/Avatar";
import {
  Button, InlineConfirm, PageHeading, SettingsCard, SettingsLayout, SaveBar, Field, SettingTwoSwitchHeader, SettingTwoSwitchRow, SettingSwitchRow, Switch,
} from "../components/Page";
import type { SettingsSection } from "../components/Page";

declare const __APP_VERSION__: string;

interface Props {
  user: User;
  onLogout: () => void;
  onUserUpdated: (user: User) => void;
}

const DATE_FORMAT_OPTIONS = [
  { value: "MM/DD/YYYY", label: "MM/DD/YYYY — US (12/31/2025)" },
  { value: "DD/MM/YYYY", label: "DD/MM/YYYY — European (31/12/2025)" },
  { value: "YYYY-MM-DD", label: "YYYY-MM-DD — ISO (2025-12-31)" },
];

const TIME_FORMAT_OPTIONS = [
  { value: "12h", label: "12-hour (2:30 PM)" },
  { value: "24h", label: "24-hour (14:30)" },
];

const NUMBER_LOCALE_OPTIONS = [
  { value: "en-US", label: "1,234.56 — US / UK" },
  { value: "de-DE", label: "1.234,56 — European" },
  { value: "fr-FR", label: "1 234,56 — French" },
  { value: "hi-IN", label: "1,23,456.78 — Indian" },
];

function ProfileTab({ user, onUserUpdated, from, onUnsavedChange }: { user: User; onUserUpdated: (u: User) => void; from?: Location; onUnsavedChange?: (unsaved: boolean) => void }) {
  const navigate = useNavigate();
  const initialForm = {
    display_name: user.display_name ?? "",
    first_name: user.first_name ?? "",
    last_name: user.last_name ?? "",
    email: user.email ?? "",
    username: user.username ?? "",
    timezone: user.timezone ?? "",
    date_format: user.date_format ?? "MM/DD/YYYY",
    time_format: user.time_format ?? "12h",
    number_locale: user.number_locale ?? "en-US",
  };
  const [form, setForm] = useState(initialForm);
  // What "unsaved" is measured against (Discard restores it); moves to the saved values on success.
  const [baseline, setBaseline] = useState(initialForm);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  // #1273: on installs with EMAIL_VERIFICATION=mandatory a new address is held
  // until confirmed from its inbox; `email` keeps the current one meanwhile.
  const [pendingEmail, setPendingEmail] = useState<string | null>(user.pending_email ?? null);
  // #1293: the Resend link / Cancel change actions on a pending email change.
  // Their result is announced through the same live region as a save, and a
  // new action or save replaces it, so no two results ever coexist.
  const [pendingAction, setPendingAction] = useState<"resend" | "cancel" | null>(null);
  const [emailNotice, setEmailNotice] = useState<{ tone: "success" | "warning" | "danger"; text: string } | null>(null);
  // The action buttons unmount once nothing is pending; move focus to the
  // field they belonged to rather than letting it fall to <body>.
  const emailInputRef = useRef<HTMLInputElement>(null);
  // The post-save "return to where you came from" timer. Cleared on unmount:
  // if the user leaves Settings (or switches tab) within the delay, a stale
  // timer must not yank them to another page afterwards.
  const leaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (leaveTimerRef.current) clearTimeout(leaveTimerRef.current);
  }, []);

  // An email change on an account with a password needs that password in the
  // same request (the server answers 400 on `current_password` otherwise).
  // Kept out of `form` so it is never sent with an unrelated save.
  const [emailPassword, setEmailPassword] = useState("");
  // The server's `current_password` error, shown in the field's helper slot.
  const [emailPasswordError, setEmailPasswordError] = useState<string | null>(null);
  // Set once the server has asked for the password, so the field shows even if
  // this page's copy of `has_usable_password` is out of date.
  const [serverWantsPassword, setServerWantsPassword] = useState(false);
  const emailPasswordRef = useRef<HTMLInputElement>(null);
  const emailChanged = form.email !== (user.email ?? "");
  const emailNeedsPassword =
    emailChanged && (user.has_usable_password !== false || serverWantsPassword);
  // Focus the field once its error has rendered (it may only just have appeared).
  useEffect(() => {
    if (emailPasswordError) emailPasswordRef.current?.focus();
  }, [emailPasswordError]);

  const set = (field: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((f) => ({ ...f, [field]: e.target.value }));

  const setEmail = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    setForm((f) => ({ ...f, email: value }));
    if (value === (user.email ?? "")) {
      // Edit reverted: the field goes away, so it must not come back pre-filled.
      setEmailPassword("");
      setEmailPasswordError(null);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (saving) return;
    setSaving(true);
    setError(null);
    setEmailPasswordError(null);
    setSaved(false);
    setEmailNotice(null);
    try {
      // Only send `email` when it was edited. On EMAIL_VERIFICATION=mandatory
      // installs, sending the current address back withdraws a pending email
      // change (#1273), so an unrelated profile save must not include it.
      const { email, ...rest } = form;
      const updated = await updateCurrentUser({
        ...rest,
        ...(emailChanged ? { email } : {}),
        ...(emailNeedsPassword ? { current_password: emailPassword } : {}),
        timezone: form.timezone || browserTimezone(),
        date_format: form.date_format,
        time_format: form.time_format,
        number_locale: form.number_locale,
      });
      onUserUpdated(updated);
      setSaved(true);
      setEmailPassword("");
      const pending = updated.pending_email ?? null;
      setPendingEmail(pending);
      if (pending) {
        // Stay on the page so the confirmation notice can be read, and show
        // the address that is actually in effect in the field.
        setForm((f) => ({ ...f, email: updated.email ?? "" }));
        setBaseline({ ...form, email: updated.email ?? "" });
      } else {
        setBaseline(form);
        if (leaveTimerRef.current) clearTimeout(leaveTimerRef.current);
        leaveTimerRef.current = setTimeout(() => navigate(from ?? "/", { replace: true }), 1500);
      }
    } catch (err) {
      const data = (err as { response?: { data?: Record<string, unknown> } })?.response?.data;
      const usernameError = Array.isArray(data?.username) ? data.username[0] : null;
      const passwordError = Array.isArray(data?.current_password) ? data.current_password[0] : null;
      // Never keep a password around after a failed save.
      setEmailPassword("");
      if (typeof passwordError === "string") {
        // Shown on the field itself, not in the status line below.
        setServerWantsPassword(true);
        setEmailPasswordError(passwordError);
      } else {
        setError(
          typeof usernameError === "string"
            ? usernameError
            : data?.code === "recent_login_required"
            ? // #1932: on an account without a password, an email change needs a
              // recent provider sign-in in this session (the #1260 rule).
              'To change your email address, sign out, sign in again with your sign-in provider, and then change it within a few minutes. If you can\'t sign in with a provider, use "Forgot password?" on the sign-in page to set a password first.'
            : "Failed to save changes. Please try again.",
        );
        if (emailNeedsPassword) emailPasswordRef.current?.focus();
      }
    } finally {
      setSaving(false);
    }
  };

  const startEmailAction = (action: "resend" | "cancel") => {
    setPendingAction(action);
    setError(null);
    setSaved(false);
    setEmailNotice(null);
  };

  const handleResend = async () => {
    const address = pendingEmail;
    startEmailAction("resend");
    try {
      await resendPendingEmailConfirmation();
      setEmailNotice({ tone: "success", text: `We sent a new confirmation link to ${address}.` });
    } catch (err) {
      const response = (err as { response?: { status?: number; data?: { detail?: unknown } } })?.response;
      const detail = typeof response?.data?.detail === "string" ? response.data.detail : null;
      if (response?.status === 429) {
        // allauth's per-address cooldown: nothing is broken, the user is just
        // early. The server owns the wording (and the wait it implies).
        setEmailNotice({ tone: "warning", text: detail ?? "A link was sent recently. Wait a few minutes before asking again." });
      } else if (response?.status === 404) {
        // Confirmed or canceled elsewhere (another tab, the link itself).
        setPendingEmail(null);
        emailInputRef.current?.focus();
        setEmailNotice({ tone: "warning", text: "There's no email change waiting for confirmation anymore. Reload the page to see your current address." });
      } else {
        setEmailNotice({ tone: "danger", text: "Couldn't resend the link. Please try again." });
      }
    } finally {
      setPendingAction(null);
    }
  };

  const handleCancelChange = async () => {
    startEmailAction("cancel");
    try {
      await cancelPendingEmailChange();
      // 204, no body (#2005): refetch the profile. The cancel has already
      // succeeded, so a failed refetch must not report it as failed; fall back
      // to the one field the cancel is documented to change.
      const updated = await getCurrentUser().catch((): User => ({ ...user, pending_email: null }));
      onUserUpdated(updated);
      setPendingEmail(updated.pending_email ?? null);
      setForm((f) => ({ ...f, email: updated.email ?? "" }));
      setBaseline((b) => ({ ...b, email: updated.email ?? "" }));
      emailInputRef.current?.focus();
      setEmailNotice({ tone: "success", text: "Email change canceled. Your email address hasn't changed." });
    } catch {
      setEmailNotice({ tone: "danger", text: "Couldn't cancel the email change. Please try again." });
    } finally {
      setPendingAction(null);
    }
  };

  const formRef = useRef<HTMLFormElement>(null);
  const dirty = JSON.stringify(form) !== JSON.stringify(baseline);
  // Reports unsaved edits to the page's leave guard; unmounting (a confirmed Discard) clears it.
  useEffect(() => {
    onUnsavedChange?.(dirty);
    return () => onUnsavedChange?.(false);
  }, [dirty, onUnsavedChange]);
  const discard = () => {
    setForm(baseline);
    setEmailPassword("");
    setEmailPasswordError(null);
    setError(null);
    setSaved(false);
  };
  const fullName = [form.first_name, form.last_name].filter(Boolean).join(" ");

  return (
    <form ref={formRef} onSubmit={handleSubmit} className="flex flex-col gap-4">
      <PageHeading level="h3" title="Profile" description="How you appear to your team, and how dates and numbers are shown to you." />

      {/* Live region (at the top so a failed save is seen without scrolling): with an email change pending the page stays here, so
          this line is the terminal state of the save and must be announced. */}
      <p className="text-xs min-h-4" role="status" aria-live="polite" aria-atomic="true">
        {error && <span className="text-danger">{error}</span>}
        {emailNotice && !error && (
          <span
            className={
              emailNotice.tone === "success"
                ? "text-success"
                : emailNotice.tone === "warning"
                  ? "text-warning"
                  : "text-danger"
            }
          >
            {emailNotice.text}
          </span>
        )}
        {saved && !error && !emailNotice && (
          <span className="text-success">
            {pendingEmail
              ? "Profile updated. Check your inbox to confirm your new email address."
              : "Changes saved."}
          </span>
        )}
      </p>


      <SettingsCard>
        <div className="flex items-center gap-3" data-testid="profile-identity">
          <Avatar user={user} size="lg" />
          <div className="min-w-0">
            <p className="text-sm font-semibold text-fg truncate">{user.display_name || fullName || user.username}</p>
            <p className="text-sm text-fg-secondary truncate">@{user.username}</p>
          </div>
        </div>
      </SettingsCard>

      <SettingsCard title="Personal details" headingAs="h4">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="First name" autoComplete="given-name" value={form.first_name} onChange={set("first_name")} />
          <Field label="Last name" autoComplete="family-name" value={form.last_name} onChange={set("last_name")} />
          <div className="sm:col-span-2">
            <Field label="Display name" autoComplete="nickname" value={form.display_name} onChange={set("display_name")} placeholder="How you appear on the board" />
          </div>
          <Field label="Username" autoComplete="username" value={form.username} onChange={set("username")} required />
          <Field label="Email address" type="email" autoComplete="email" inputRef={emailInputRef} value={form.email} onChange={setEmail} required />
          {emailNeedsPassword && (
            <div className="sm:col-span-2">
              <Field
                label="Current password"
                type="password"
                autoComplete="current-password"
                inputRef={emailPasswordRef}
                value={emailPassword}
                onChange={(e) => setEmailPassword(e.target.value)}
                required
                aria-invalid={emailPasswordError ? true : undefined}
                hint={emailPasswordError ?? "Required to change your email address, to confirm it's you."}
                hintTone={emailPasswordError ? "danger" : undefined}
              />
            </div>
          )}
        </div>
      </SettingsCard>

      {pendingEmail && (
        <SettingsCard title="Email change pending" headingAs="h4">
          <p id="pending-email-note" data-testid="pending-email-note" className="text-sm text-fg-secondary">
            {`Waiting for confirmation: we sent a link to ${pendingEmail}. Your email address changes once you open it.`}
          </p>
          <div className="mt-3 flex items-center gap-2">
            <Button onClick={() => { if (pendingAction === null && !saving) void handleResend() }} aria-busy={pendingAction === "resend" || undefined} aria-describedby="pending-email-note">
              {pendingAction === "resend" ? "Sending…" : "Resend"}
            </Button>
            <Button variant="quiet" onClick={() => { if (pendingAction === null && !saving) void handleCancelChange() }} aria-busy={pendingAction === "cancel" || undefined} aria-describedby="pending-email-note">
              {pendingAction === "cancel" ? "Canceling…" : "Cancel change"}
            </Button>
          </div>
        </SettingsCard>
      )}

      <SettingsCard title="Time and number formats" headingAs="h4">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <ProfileSelect label="Timezone" hint="Used for due date labels and filters">
              <SelectDropdown
                value={form.timezone}
                onChange={(v) => setForm((f) => ({ ...f, timezone: v }))}
                options={[
                  { value: "", label: `Detect automatically (${browserTimezone()})` },
                  ...TIMEZONE_OPTIONS.map(({ value, label }) => ({ value, label: `${label} — ${value}` })),
                ]}
                className="w-full"
              />
            </ProfileSelect>
          </div>
          <ProfileSelect label="Date format">
            <SelectDropdown value={form.date_format} onChange={(v) => setForm((f) => ({ ...f, date_format: v }))} options={DATE_FORMAT_OPTIONS} className="w-full" />
          </ProfileSelect>
          <ProfileSelect label="Time format">
            <SelectDropdown value={form.time_format} onChange={(v) => setForm((f) => ({ ...f, time_format: v }))} options={TIME_FORMAT_OPTIONS} className="w-full" />
          </ProfileSelect>
          <ProfileSelect label="Number format">
            <SelectDropdown value={form.number_locale} onChange={(v) => setForm((f) => ({ ...f, number_locale: v }))} options={NUMBER_LOCALE_OPTIONS} className="w-full" />
          </ProfileSelect>
        </div>
      </SettingsCard>

      <SaveBar
        thing="profile"
        saveLabel="Save profile"
        dirty={dirty}
        saving={saving || pendingAction !== null}
        onDiscard={discard}
        onSave={() => formRef.current?.requestSubmit()}
      />
    </form>
  );
}

/** A labeled select row for the Profile card (the custom dropdown has no native label). */
function ProfileSelect({ label, hint, children }: { label: string; hint?: string; children: React.ReactElement<{ ariaLabel?: string }> }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-sm font-medium text-fg-secondary">{label}</span>
      {/* The custom dropdown has no native label, so it is named explicitly. */}
      {cloneElement(children, { ariaLabel: label })}
      {hint && <span className="text-xs text-fg-tertiary">{hint}</span>}
    </div>
  );
}

/** The outcome of a connect round trip, read from /settings?connected= or
 *  ?connect_error= by SettingsPage (#1314). */
interface ConnectResult {
  provider: string;
  error: string | null;
}

const PROVIDER_ORDER: ProviderId[] = ["oidc", "google", "github", "gitlab"];

function connectErrorMessage(code: string, label: string): string {
  if (code === "provider_already_connected") {
    return `That ${label} account is taken — it's already connected to a different Visiban account. Sign in with ${label} to use that account, or disconnect it there first.`;
  }
  if (code === "connect_identity_mismatch") {
    return `That isn't the ${label} account that tried to sign in, so nothing was connected. Check which ${label} account you're signed in to, then connect again if you meant to.`;
  }
  return `Couldn't connect ${label}. Please try again.`;
}

function ConnectedAccountRow({
  provider,
  label,
  account,
  isOnlyMethod,
  confirming,
  connecting,
  disconnecting,
  rowError,
  rowSuccess,
  onConnect,
  onStartDisconnect,
  onCancelDisconnect,
  onConfirmDisconnect,
}: {
  provider: ProviderId;
  label: string;
  account: ConnectedAccount | undefined;
  isOnlyMethod: boolean;
  confirming: boolean;
  connecting: boolean;
  disconnecting: boolean;
  rowError: string | null;
  rowSuccess: boolean;
  onConnect: () => void;
  onStartDisconnect: () => void;
  onCancelDisconnect: () => void;
  onConfirmDisconnect: () => void;
}) {
  const connected = !!account?.connected;
  const disconnectTriggerRef = useConfirmFocusReturn(confirming ? "disconnect" : null);
  useConfirmAnnouncement(confirming ? `Disconnect ${label}? You will no longer be able to sign in with it.` : null);
  const hintId = `disconnect-hint-${provider}`;
  return (
    <div className="flex flex-col gap-3 px-4 py-3 bg-surface/50 hover:bg-surface transition sm:flex-row sm:items-center" data-testid={`connected-account-${provider}`}>
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <ProviderIcon id={provider} className="w-5 h-5 shrink-0" />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm text-fg truncate">{label}</span>
            {connected ? (
              <span className="h-6 inline-flex items-center px-2.5 text-xs font-medium rounded-full bg-success/15 text-success-on-tint">Connected</span>
            ) : (
              <span className="h-6 inline-flex items-center px-2.5 text-xs font-medium rounded-full border border-line-boundary text-fg-secondary">Not connected</span>
            )}
          </div>
          {connected && account?.email && (
            <p className="text-xs text-fg-muted mt-0.5 truncate">{account.email}</p>
          )}
          <p className="text-xs min-h-4 mt-0.5" role="status" aria-live="polite" aria-atomic="true">
            {rowError && <span className="text-danger">{rowError}</span>}
            {rowSuccess && !rowError && <span className="text-success">Connected.</span>}
          </p>
        </div>
      </div>
      <div className="flex flex-col gap-1 sm:shrink-0 sm:items-end">
        {connected ? (
          confirming ? (
            <div className="sm:max-w-sm">
              <InlineConfirm
                message={<>Disconnect <span className="font-medium">{label}</span>? You will no longer be able to sign in with it.</>}
                actionLabel="Disconnect"
                busy={disconnecting}
                busyLabel="Disconnecting…"
                actionTestId={`confirm-disconnect-${provider}`}
                onConfirm={onConfirmDisconnect}
                onCancel={onCancelDisconnect}
              />
            </div>
          ) : (
            // aria-disabled, never native `disabled`: a disabled button drops
            // out of the tab order and hides *why* from keyboard and screen-
            // reader users. The reason stays visible and is announced via
            // aria-describedby; the click is a no-op.
            <Button
              buttonRef={disconnectTriggerRef("disconnect")}
              variant="quiet"
              aria-disabled={isOnlyMethod}
              aria-describedby={isOnlyMethod ? hintId : undefined}
              onClick={isOnlyMethod ? undefined : onStartDisconnect}
              className={isOnlyMethod ? "opacity-40 cursor-not-allowed" : "hover:text-danger"}
              aria-label={`Disconnect ${label}`}
              data-testid={`disconnect-${provider}`}
            >
              Disconnect
            </Button>
          )
        ) : (
          <Button variant="primary" onClick={connecting ? undefined : onConnect} aria-busy={connecting || undefined} data-testid={`connect-${provider}`}>
            {connecting ? "Connecting…" : "Connect"}
          </Button>
        )}
        {isOnlyMethod && (
          <p id={hintId} className="text-xs text-fg-secondary sm:text-right">You can't disconnect your only way to sign in; set a password first.</p>
        )}
      </div>
    </div>
  );
}

/**
 * Settings → Security → Connected accounts (#1314). Lists every provider the
 * instance has configured; connecting is a real navigation through the
 * provider, disconnecting an API call the server refuses for the last way to
 * sign in (the UI guard below only mirrors that rule).
 */
function ConnectedAccountsSection({
  hasUsablePassword,
  connectResult,
}: {
  hasUsablePassword: boolean;
  connectResult: ConnectResult | null;
}) {
  const [configured, setConfigured] = useState<ProviderId[] | null>(null);
  const [oidcName, setOidcName] = useState<string | null>(null);
  const [accounts, setAccounts] = useState<ConnectedAccount[] | null>(null);
  // A failed list load must not render as "Not connected" on every row — that
  // would be a false account-security status. Show an error with Retry.
  const [loadFailed, setLoadFailed] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [connectingId, setConnectingId] = useState<string | null>(null);
  const [disconnectingId, setDisconnectingId] = useState<string | null>(null);
  const [rowStatus, setRowStatus] = useState<{ provider: string; error: string | null; fromUrl: boolean } | null>(
    connectResult ? { provider: connectResult.provider, error: connectResult.error, fromUrl: true } : null,
  );

  // Escape cancels an open inline disconnect confirm before the page-level
  // Escape-to-navigate handler (priority 0) can leave the page (#1366).
  useEscapeStack(() => {
    // Inert while a disconnect request is running: closing the confirm would
    // hide the "Disconnecting…" state of a request that still completes.
    if (confirmingId !== null && disconnectingId === null) { setConfirmingId(null); return; }
    return false;
  }, 40);

  useEffect(() => {
    let cancelled = false;
    getAuthProviders()
      .then((p) => {
        if (cancelled) return;
        setConfigured(PROVIDER_ORDER.filter((id) => p[id]));
        setOidcName(p.oidc_name);
      })
      .catch(() => { if (!cancelled) setConfigured([]); });
    listConnectedAccounts()
      .then((rows) => { if (!cancelled) { setAccounts(rows); setLoadFailed(false); } })
      .catch(() => { if (!cancelled) { setAccounts([]); setLoadFailed(true); } });
    return () => { cancelled = true; };
  }, [reloadKey]);

  const providersLoading = configured === null || accounts === null;
  if (!providersLoading && configured.length === 0) return null;

  const labelFor = (id: string) => providerLabel(id, oidcName);
  const byProvider = new Map((accounts ?? []).map((a) => [a.provider, a]));
  const connectedCount = (accounts ?? []).filter((a) => a.connected).length;

  const handleConnect = (id: ProviderId) => {
    setConnectingId(id);
    setRowStatus(null);
    startProviderConnect(id);
  };

  const confirmDisconnect = async (id: ProviderId) => {
    setDisconnectingId(id);
    setRowStatus(null);
    try {
      await disconnectAccount(id);
      // 204, no body (#2005): refetch the list. The disconnect has already
      // succeeded, so a failed refetch must not report it as failed; mark just
      // this provider's row disconnected, which the server has confirmed.
      const rows = await listConnectedAccounts().catch((): ConnectedAccount[] =>
        (accounts ?? []).map((a) => (a.provider === id ? { ...a, connected: false, email: null, connected_at: null } : a)),
      );
      setAccounts(rows);
      setConfirmingId(null);
    } catch (err: unknown) {
      const detail = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
      setRowStatus({ provider: id, error: detail ?? `Failed to disconnect ${labelFor(id)}. Please try again.`, fromUrl: false });
      setConfirmingId(null);
    } finally {
      setDisconnectingId(null);
    }
  };

  return (
    <div data-testid="connected-accounts">
    <SettingsCard
      title="Connected accounts"
      headingAs="h4"
      description="Connect an account for faster sign-in. You must keep at least one way to sign in."
    >
      {providersLoading ? (
        <div className="flex items-center justify-center py-6">
          <div className="w-5 h-5 border-2 border-primary border-t-transparent rounded-full animate-spin" />
        </div>
      ) : loadFailed ? (
        <div className="flex items-center gap-3" data-testid="connected-accounts-error">
          <p className="text-sm text-danger">Failed to load connected accounts.</p>
          <button
            type="button"
            onClick={() => { setAccounts(null); setReloadKey((k) => k + 1); }}
            className="text-xs text-fg-tertiary hover:text-fg underline transition rounded focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
          >
            Retry
          </button>
        </div>
      ) : (
        <div className="flex flex-col divide-y divide-line rounded-lg border border-line overflow-hidden" data-testid="connected-accounts-list">
          {configured.map((id) => {
            const account = byProvider.get(id);
            const status = rowStatus?.provider === id ? rowStatus : null;
            return (
              <ConnectedAccountRow
                key={id}
                provider={id}
                label={labelFor(id)}
                account={account}
                isOnlyMethod={!!account?.connected && !hasUsablePassword && connectedCount === 1}
                confirming={confirmingId === id}
                connecting={connectingId === id}
                disconnecting={disconnectingId === id}
                rowError={status?.error ? connectErrorOrDetail(status.error, labelFor(id), status.fromUrl) : null}
                rowSuccess={!!status && !status.error && !!account?.connected}
                onConnect={() => handleConnect(id)}
                onStartDisconnect={() => { setRowStatus(null); setConfirmingId(id); }}
                onCancelDisconnect={() => setConfirmingId(null)}
                onConfirmDisconnect={() => confirmDisconnect(id)}
              />
            );
          })}
        </div>
      )}
    </SettingsCard>
    </div>
  );
}

/** Connect-return codes (from the URL) become fixed copy — never echoed
 *  verbatim; any other string is a server `detail` from a disconnect call. */
function connectErrorOrDetail(error: string, label: string, fromUrl: boolean): string {
  return fromUrl ? connectErrorMessage(error, label) : error;
}

function SecurityTab({
  user,
  connectResult = null,
  onUserUpdated,
}: {
  user: User;
  connectResult?: ConnectResult | null;
  onUserUpdated?: (u: User) => void;
}) {
  // Default true: older API responses that predate this field should be
  // treated as password accounts so the current-password field is shown.
  const hasPw = user.has_usable_password ?? true;
  const [form, setForm] = useState({ current_password: "", new_password: "", confirm: "" });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  // A password set on this page counts as a sign-in method right away, so
  // the "only sign-in method" guard lifts without a reload.
  const [passwordJustSet, setPasswordJustSet] = useState(false);
  // Worded at success time: after a first password is set, `user` is updated
  // and `hasPw` turns true, which must not re-word the message.
  const [savedText, setSavedText] = useState("");

  const set = (field: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((f) => ({ ...f, [field]: e.target.value }));

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (saving) return;
    if (form.new_password !== form.confirm) {
      setError("New passwords do not match.");
      return;
    }
    if (form.new_password.length < 12) {
      setError("New password must be at least 12 characters.");
      return;
    }
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      await changePassword(form.current_password, form.new_password);
      setSavedText(hasPw ? "Password changed successfully." : "Password set successfully.");
      setSaved(true);
      setPasswordJustSet(true);
      setForm({ current_password: "", new_password: "", confirm: "" });
      // A first password changes what other tabs ask for (e.g. Profile now
      // needs the current password to change the email), so update the shared
      // user rather than waiting for a reload.
      if (!hasPw) onUserUpdated?.({ ...user, has_usable_password: true });
    } catch (err) {
      const response = (err as { response?: { status?: number; data?: { code?: unknown } } })?.response;
      const status = response?.status;
      setError(
        status === 429
          ? "Too many attempts. Please wait before trying again."
          : response?.data?.code === "recent_login_required"
          ? // #1260: a first password needs a recent provider sign-in in this session.
            'To set a password, sign out, sign in again with your sign-in provider, and then set the password within a few minutes. If you can\'t sign in with a provider, use "Forgot password?" on the sign-in page instead.'
          : hasPw
          ? "Failed to change password. Check your current password and try again."
          : "Failed to set password. Please try again."
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <PageHeading level="h3" title="Security" description="Your password and the accounts you can sign in with." />
      <form onSubmit={handleSubmit}>
        <SettingsCard title={hasPw ? "Password" : "Set a password"} headingAs="h4">
          <div className="flex flex-col gap-4 max-w-md">
            {!hasPw && (
              <p className="text-sm text-fg-secondary">
                You signed in with a social account. Set a password below to also enable
                username/password login. For your security, this works only within a few
                minutes of signing in.
              </p>
            )}
            {hasPw && (
              <Field label="Current password" type="password" autoComplete="current-password" value={form.current_password} onChange={set("current_password")} required />
            )}
            <Field label="New password" type="password" autoComplete="new-password" value={form.new_password} onChange={set("new_password")} required minLength={12} />
            <Field label="Confirm new password" type="password" autoComplete="new-password" value={form.confirm} onChange={set("confirm")} required />
            <p className="text-xs min-h-4" role="status" aria-live="polite">
              {error && <span className="text-danger">{error}</span>}
              {saved && !error && <span className="text-success">{savedText}</span>}
            </p>
            <div>
              <Button type="submit" variant="primary" aria-busy={saving || undefined}>
                {saving ? (hasPw ? "Changing…" : "Setting…") : (hasPw ? "Change password" : "Set password")}
              </Button>
            </div>
          </div>
        </SettingsCard>
      </form>
      <ConnectedAccountsSection hasUsablePassword={hasPw || passwordJustSet} connectResult={connectResult} />
    </div>
  );
}

const PAT_MAX = 10;

// Mirrors PAT_SCOPES in backend/accounts/models.py. Scopes are strictly
// non-hierarchical, so each is an independent checkbox. `read` + `write` are
// pre-checked (the backend's PAT_DEFAULT_SCOPES); `admin` and `mcp:*` are
// opt-in. The backend has no rule limiting who may request `admin` (it grants
// nothing to a non-admin account), so the UI only hides it from non-admins to
// avoid offering a no-op.
const PAT_SCOPE_OPTIONS: { scope: PersonalAccessTokenScope; label: string; hint: string }[] = [
  { scope: "read", label: "read", hint: "Read data over the REST API" },
  { scope: "write", label: "write", hint: "Create and change data over the REST API" },
  { scope: "admin", label: "admin", hint: "Admin REST endpoints" },
  { scope: "mcp:read", label: "mcp:read", hint: "Connect an MCP client and call its read tools" },
  { scope: "mcp:write", label: "mcp:write", hint: "Let an MCP client call write tools (also needs mcp:read)" },
];
const PAT_DEFAULT_SCOPES: PersonalAccessTokenScope[] = ["read", "write"];

function AccessTokensTab({ user, isSiteAdmin = false, onUnsavedChange }: { user?: UserDatePrefs | null; isSiteAdmin?: boolean; onUnsavedChange?: (unsaved: boolean) => void }) {
  const [tokens, setTokens] = useState<PersonalAccessToken[]>([]);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState("");
  const [expiresAt, setExpiresAt] = useState("");
  const [scopes, setScopes] = useState<PersonalAccessTokenScope[]>(PAT_DEFAULT_SCOPES);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [newToken, setNewToken] = useState<CreatedPersonalAccessToken | null>(null);
  const [copied, setCopied] = useState(false);
  // A visible reveal-once token is unsaved work: leaving would lose it for good.
  const tokenVisible = newToken !== null;
  useEffect(() => {
    onUnsavedChange?.(tokenVisible);
    return () => onUnsavedChange?.(false);
  }, [tokenVisible, onUnsavedChange]);
  const [revokingId, setRevokingId] = useState<number | null>(null);
  const [confirmRevokeId, setConfirmRevokeId] = useState<number | null>(null);
  const revokeTriggerRef = useConfirmFocusReturn(confirmRevokeId);
  const confirmingToken = confirmRevokeId === null ? undefined : tokens.find((t) => t.id === confirmRevokeId);
  useConfirmAnnouncement(confirmingToken ? `Revoke ${confirmingToken.name}? Anything using this token will lose access.` : null);
  const [revokeError, setRevokeError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Escape cancels an open inline revoke confirm before the page-level
  // Escape-to-navigate handler (priority 0) can leave the page (#1238).
  useEscapeStack(() => {
    if (confirmRevokeId !== null) { setConfirmRevokeId(null); return; }
    return false;
  }, 40);

  const fetchTokens = useCallback(async () => {
    try {
      setTokens(await listTokens());
      setLoadError(null);
    } catch {
      setLoadError("Failed to load access tokens.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // void: fetchTokens handles its own errors via setLoadError and never rethrows.
    void fetchTokens();
  }, [fetchTokens]);

  const atLimit = tokens.length >= PAT_MAX;
  const copyRef = useRef<HTMLButtonElement>(null);
  // A reveal-once secret takes focus on its Copy button (frontend/CLAUDE.md, Settings pages).
  useEffect(() => { if (newToken) copyRef.current?.focus(); }, [newToken]);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (creating || atLimit || !name.trim() || scopes.length === 0) return;
    setCreating(true);
    setCreateError(null);
    try {
      const created = await createToken(name.trim(), expiresAt || undefined, scopes);
      setNewToken(created);
      setCopied(false);
      setName("");
      setExpiresAt("");
      setScopes(PAT_DEFAULT_SCOPES);
      await fetchTokens();
    } catch (err: unknown) {
      const detail = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
      setCreateError(detail ?? "Failed to create token.");
    } finally {
      setCreating(false);
    }
  };

  const handleRevoke = async (id: number) => {
    // Keep the confirm prompt open until the request settles so the in-flight
    // label and disabled state are real and the trigger doesn't reappear mid-flight.
    setRevokingId(id);
    setRevokeError(null);
    try {
      await revokeToken(id);
      setTokens((prev) => prev.filter((t) => t.id !== id));
      if (newToken?.id === id) setNewToken(null);
      setConfirmRevokeId(null);
    } catch {
      setRevokeError("Failed to revoke token. Please try again.");
    } finally {
      setRevokingId(null);
    }
  };

  const formatDate = (iso: string | null) => {
    if (!iso) return "Never";
    return formatDateUtil(iso, user);
  };

  const toggleScope = (scope: PersonalAccessTokenScope) =>
    setScopes((prev) => {
      // mcp:write is useless without mcp:read, so it turns mcp:read on and locks it (#2477).
      if (scope === "mcp:read" && prev.includes("mcp:write")) return prev;
      if (prev.includes(scope)) return prev.filter((s) => s !== scope);
      return scope === "mcp:write" && !prev.includes("mcp:read") ? [...prev, "mcp:read", scope] : [...prev, scope];
    });

  return (
    <div className="flex flex-col gap-4" data-testid="access-tokens-tab">
      <PageHeading
        level="h3"
        title="Access tokens"
        description="Personal access tokens let you authenticate API requests. Tokens are shown once on creation. All tokens are revoked if you change your password."
      />

      {/* One-time reveal panel */}
      {newToken && (
        <div className="border border-warning/50 rounded-[10px] p-4 bg-sunken flex flex-col gap-2" role="status" data-testid="new-token-reveal">
          <p className="text-sm text-warning-on-tint font-medium">
            Copy your token now — it won't be shown again.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <code className="min-w-0 flex-1 font-mono text-sm text-fg bg-surface px-3 py-2 rounded break-all select-all" data-testid="new-token-value">
              {newToken.token}
            </code>
            <Button
              variant="primary"
              buttonRef={copyRef}
              onClick={() => { void navigator.clipboard?.writeText(newToken.token).then(() => setCopied(true)).catch(() => undefined); }}
              data-testid="copy-token"
            >
              Copy
            </Button>
          </div>
          <p role="status" className="text-xs text-success min-h-4" data-testid="copied-status">{copied ? "Copied" : ""}</p>
          <div className="self-end">
            <Button variant="quiet" onClick={() => setNewToken(null)} data-testid="dismiss-token">
              I've copied it — dismiss
            </Button>
          </div>
        </div>
      )}

      <SettingsCard title="New token" headingAs="h4">
        <form onSubmit={handleCreate} className="flex flex-col gap-4" data-testid="create-token-form">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-[minmax(0,1fr)_200px]">
            <Field
              label="Name"
              autoComplete="off"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Token name (e.g. CI pipeline)"
              maxLength={64}
              required
              data-testid="token-name-input"
            />
            <Field
              label="Expires (optional)"
              autoComplete="off"
              type="date"
              value={expiresAt}
              onChange={(e) => setExpiresAt(e.target.value)}
              title="Optional expiry date (max 1 year)"
              data-testid="token-expiry-input"
            />
          </div>
          <fieldset className="flex flex-col gap-1.5" data-testid="token-scopes" aria-describedby={scopes.length === 0 ? "token-scopes-error" : undefined}>
            <legend className="text-sm font-medium text-fg-secondary mb-1">Scopes</legend>
            {PAT_SCOPE_OPTIONS.filter((o) => o.scope !== "admin" || isSiteAdmin).map((o) => {
              const locked = o.scope === "mcp:read" && scopes.includes("mcp:write");
              return (
                <label key={o.scope} className={`flex items-start gap-3 text-sm text-fg-secondary max-sm:min-h-11 max-sm:items-center ${locked ? "cursor-not-allowed" : "cursor-pointer"}`}>
                  <input
                    type="checkbox"
                    checked={scopes.includes(o.scope)}
                    onChange={() => toggleScope(o.scope)}
                    aria-disabled={locked || undefined}
                    className="accent-primary shrink-0 mt-0.5 max-sm:mt-0 max-sm:h-6 max-sm:w-6"
                    data-testid={`token-scope-${o.scope}`}
                  />
                  <span className="min-w-0 flex flex-col sm:flex-row sm:gap-2">
                    <span className="font-mono text-xs text-fg">{o.label}</span>
                    <span className="text-xs text-fg-secondary">{o.hint}{locked ? " (required by mcp:write)" : ""}</span>
                  </span>
                </label>
              );
            })}
            <p className="text-xs text-fg-secondary">
              An MCP client needs <span className="font-mono">mcp:read</span> to use this token.
            </p>
            {scopes.length === 0 && (
              <p id="token-scopes-error" role="alert" className="text-xs text-danger" data-testid="token-scopes-error">
                Select at least one scope.
              </p>
            )}
          </fieldset>
          <p className="text-xs min-h-4" role={createError ? "alert" : undefined}>
            {createError
              ? <span className="text-danger">{createError}</span>
              : <span className="text-fg-secondary">Leave expiry blank for a non-expiring token (max 1 year if set).</span>
            }
          </p>
          <div className="flex flex-wrap items-center gap-3">
            {/* aria-disabled, not `disabled`: at the limit the reason below must stay reachable (#2477). */}
            <Button
              type="submit"
              variant="primary"
              aria-disabled={atLimit || !name.trim() || scopes.length === 0 || undefined}
              aria-describedby={atLimit ? "max-tokens-notice" : undefined}
              aria-busy={creating || undefined}
              data-testid="create-token-button"
            >
              {creating ? "Creating…" : "Generate token"}
            </Button>
            {atLimit && (
              <p id="max-tokens-notice" className="text-sm text-warning-on-tint" data-testid="max-tokens-notice">
                You've reached the maximum of {PAT_MAX} tokens. Revoke one to create another.
              </p>
            )}
          </div>
        </form>
      </SettingsCard>

      {/* Token list */}
      <SettingsCard title="Your tokens" headingAs="h4">
      {loading ? (
        <div className="flex items-center justify-center py-8">
          <div className="w-5 h-5 border-2 border-primary border-t-transparent rounded-full animate-spin" />
        </div>
      ) : loadError ? (
        <p className="text-sm text-danger" data-testid="tokens-load-error">{loadError}</p>
      ) : tokens.length === 0 ? (
        <p className="text-sm text-fg-secondary" data-testid="no-tokens-message">No access tokens yet.</p>
      ) : (
        // A real table from `sm` (column headers for assistive tech too); on phones each row is a
        // stacked card and the header row is visually hidden but still read (#2477).
        <table className="w-full text-left border-collapse max-sm:block" data-testid="token-list">
          <caption className="sr-only">Access tokens</caption>
          <thead className="max-sm:sr-only">
            <tr className="text-xs text-fg-tertiary uppercase tracking-wide border-b border-line">
              <th scope="col" className="px-3 py-1.5 font-normal">Name</th>
              <th scope="col" className="px-3 py-1.5 font-normal">Scopes</th>
              <th scope="col" className="px-3 py-1.5 font-normal w-24">Created</th>
              <th scope="col" className="px-3 py-1.5 font-normal w-24">Expires</th>
              <th scope="col" className="px-3 py-1.5 font-normal w-20"><span className="sr-only">Actions</span></th>
            </tr>
          </thead>
          <tbody className="max-sm:block">
            {tokens.map((token) => (
              <Fragment key={token.id}>
                <tr
                  className="hover:bg-surface-hover max-sm:flex max-sm:flex-col max-sm:gap-2 max-sm:px-3 max-sm:py-2 max-sm:rounded"
                  data-testid={`token-row-${token.id}`}
                >
                  <td className="px-3 py-2 align-top min-w-0 max-sm:p-0 max-sm:block">
                    <span className="block text-sm text-fg truncate">{token.name}</span>
                    <span className="block font-mono text-xs text-fg-tertiary">{token.prefix}…</span>
                  </td>
                  <td className="px-3 py-2 align-top max-sm:p-0 max-sm:block">
                    <span className="flex flex-wrap gap-1" data-testid={`token-scopes-${token.id}`}>
                      {token.scopes === null
                        ? <span className="h-6 inline-flex items-center px-2 rounded-full bg-surface-hover text-xs text-fg-secondary">Legacy: full REST access</span>
                        : token.scopes.map((sc) => (
                            <span key={sc} className="h-6 inline-flex items-center px-2 rounded-full bg-surface-hover font-mono text-xs text-fg-secondary">{sc}</span>
                          ))}
                    </span>
                  </td>
                  <td className="px-3 py-2 align-top text-xs text-fg-secondary sm:whitespace-nowrap max-sm:p-0 max-sm:block"><span className="sm:hidden">Created </span>{formatDate(token.created_at)}</td>
                  <td className="px-3 py-2 align-top text-xs text-fg-secondary sm:whitespace-nowrap max-sm:p-0 max-sm:block"><span className="sm:hidden">Expires </span>{formatDate(token.expires_at)}</td>
                  <td className="px-3 py-2 align-top max-sm:p-0 max-sm:block">
                    {confirmRevokeId !== token.id && (
                      <Button
                        buttonRef={revokeTriggerRef(token.id)}
                        variant="quiet"
                        className="max-sm:w-full"
                        onClick={() => { setRevokeError(null); setConfirmRevokeId(token.id); }}
                        aria-label={`Revoke ${token.name}`}
                        data-testid={`revoke-${token.id}`}
                      >
                        Revoke
                      </Button>
                    )}
                  </td>
                </tr>
                {confirmRevokeId === token.id && (
                  <tr className="max-sm:block">
                    <td colSpan={5} className="px-3 pb-2 max-sm:block">
                      <InlineConfirm
                        message={<>Revoke <span className="font-medium">{token.name}</span>? Anything using this token will lose access.
                          {/* Always-mounted failure slot (#2232): the text changes, the region stays mounted. */}
                          {" "}<span role="alert" className={revokeError ? "text-danger text-xs" : "sr-only"}>{revokeError}</span></>}
                        actionLabel="Revoke"
                        busy={revokingId === token.id}
                        busyLabel="Revoking…"
                        actionTestId={`confirm-revoke-${token.id}`}
                        onConfirm={() => { if (revokingId === null) void handleRevoke(token.id); }}
                        onCancel={() => setConfirmRevokeId(null)}
                      />
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
      )}
      </SettingsCard>
    </div>
  );
}

type NotifPrefKey =
  | "notif_card_assigned"
  | "notif_mentioned"
  | "notif_due_soon"
  | "notif_card_moved"
  | "notif_comment_added"
  | "notif_stale";

type EmailPrefKey =
  | "email_notif_card_assigned"
  | "email_notif_mentioned"
  | "email_notif_due_soon"
  | "email_notif_card_moved"
  | "email_notif_comment_added";

type NotifPrefs = Record<NotifPrefKey, boolean> & Record<EmailPrefKey, boolean>;

interface NotifRowSpec {
  key: NotifPrefKey;
  label: string;
  description: string;
  /** Omitted for events with no email counterpart in this release. */
  emailKey?: EmailPrefKey;
}

const NOTIF_ROWS: NotifRowSpec[] = [
  { key: "notif_card_assigned", label: "Card assigned to me", description: "When someone assigns a card or checklist item to you", emailKey: "email_notif_card_assigned" },
  { key: "notif_mentioned", label: "Someone @mentions me", description: "When you are mentioned in a comment", emailKey: "email_notif_mentioned" },
  { key: "notif_due_soon", label: "Due date approaching", description: "24h warning before a card you own is due", emailKey: "email_notif_due_soon" },
  { key: "notif_card_moved", label: "Card I\u2019m watching is moved", description: "When a watched card changes column", emailKey: "email_notif_card_moved" },
  { key: "notif_comment_added", label: "Comment on a watched card", description: "When someone comments on a card you\u2019re watching", emailKey: "email_notif_comment_added" },
  { key: "notif_stale", label: "Card has gone stale", description: "When a card you own has not moved for a while" },
];

function NotificationsTab({ user, onUserUpdated }: { user: User; onUserUpdated: (u: User) => void }) {
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const prefs: NotifPrefs = {
    notif_card_assigned: user.notif_card_assigned ?? true,
    notif_mentioned: user.notif_mentioned ?? true,
    notif_due_soon: user.notif_due_soon ?? false,
    notif_card_moved: user.notif_card_moved ?? false,
    notif_comment_added: user.notif_comment_added ?? false,
    notif_stale: user.notif_stale ?? false,
    email_notif_card_assigned: user.email_notif_card_assigned ?? false,
    email_notif_mentioned: user.email_notif_mentioned ?? false,
    email_notif_due_soon: user.email_notif_due_soon ?? false,
    email_notif_card_moved: user.email_notif_card_moved ?? false,
    email_notif_comment_added: user.email_notif_comment_added ?? false,
  };

  const toggle = async (field: NotifPrefKey | EmailPrefKey) => {
    if (saving) return;
    const newVal = !prefs[field];
    setSaving(field);
    setError(null);
    try {
      const updated = await updateCurrentUser({ [field]: newVal });
      onUserUpdated(updated);
    } catch {
      setError("Failed to save. Please try again.");
    } finally {
      setSaving(null);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <PageHeading
        level="h3"
        title="Notifications"
        description="Choose which events notify you in the app, and which of those are also emailed to you."
      />
      <SettingsCard>
        <p className="text-sm text-fg-secondary">
          An email is a copy of the in-app notification, so the event must be on in the app first.
          Emails go to your account address and are only sent if your administrator has set up
          outgoing email.
        </p>
        <div className="mt-3 divide-y divide-line">
          <SettingTwoSwitchHeader />
          {NOTIF_ROWS.map((spec) => (
            <div key={spec.key} role="group" aria-label={spec.label}>
              {spec.emailKey ? (
                <SettingTwoSwitchRow
                  event={spec.label}
                  description={spec.description}
                  inApp={prefs[spec.key]}
                  email={prefs[spec.emailKey]}
                  inAppBusy={saving === spec.key}
                  emailBusy={saving === spec.emailKey}
                  onInAppChange={() => toggle(spec.key)}
                  onEmailChange={() => toggle(spec.emailKey as EmailPrefKey)}
                />
              ) : (
                // No email counterpart for this event in this release: one switch, in the In-app column.
                <div className="flex items-center justify-between gap-4 py-3">
                  <div className="min-w-0">
                    <p id={`${spec.key}-label`} className="text-sm font-medium text-fg">{spec.label}</p>
                    <p className="mt-0.5 text-sm text-fg-secondary">{spec.description}</p>
                  </div>
                  <div className="flex items-center gap-4">
                    <Switch checked={prefs[spec.key]} busy={saving === spec.key} onChange={() => toggle(spec.key)} aria-label={`${spec.label}, in-app`} />
                    <span className="w-11" aria-hidden="true" />
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
        <p role="alert" className="mt-2 text-sm text-danger min-h-5">{error}</p>
      </SettingsCard>
    </div>
  );
}

// VITE_THEME_LIGHT_ENABLED originally gated the "Light" option during the
// component-sweep rollout (#120). The sweep is complete, so Light is available
// by default. The flag remains as an explicit opt-out ("false") for operators
// who want to hide the option on install-specific forks.
const LIGHT_ENABLED = import.meta.env.VITE_THEME_LIGHT_ENABLED !== "false";

const THEME_OPTIONS: { value: ThemePreference; label: string; description: string }[] = [
  { value: "system", label: "System", description: "Follows your OS preference" },
  { value: "dark",   label: "Dark",   description: "Always use dark mode" },
  ...(LIGHT_ENABLED
    ? [{ value: "light" as const, label: "Light", description: "Always use light mode" }]
    : []),
];

function AppearanceTab() {
  const { preference, setPreference } = useTheme();

  return (
    <div className="flex flex-col gap-4">
      <PageHeading level="h3" title="Appearance" description="Applies on every device you sign in on." />
      <SettingsCard title="Theme" headingAs="h4">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3" role="radiogroup" aria-label="Theme">
          {THEME_OPTIONS.map(({ value, label, description }) => (
            <label
              key={value}
              className={`flex flex-col gap-2 rounded-[10px] border p-3 transition-colors cursor-pointer focus-within:ring-2 focus-within:ring-primary-emphasis ${
                preference === value
                  ? "border-primary-emphasis bg-primary-emphasis/10"
                  : "border-line-strong hover:bg-surface-hover"
              }`}
            >
              <input
                type="radio"
                className="sr-only"
                name="theme"
                value={value}
                checked={preference === value}
                onChange={() => setPreference(value)}
              />
              {/* Preview: a miniature page and card in that theme (System splits light/dark). */}
              <span aria-hidden="true" className="flex h-14 overflow-hidden rounded border border-line">
                {(value === "system" ? ["dark", "light"] : [value]).map((mode) => (
                  // data-theme scopes the tokens, so the preview shows that theme whichever is active.
                  <span key={mode} data-theme={mode} className="flex flex-1 items-end gap-1 bg-page p-1.5">
                    <span className="h-6 flex-1 rounded-sm bg-surface border border-line" />
                    <span className="h-4 flex-1 rounded-sm bg-surface border border-line" />
                  </span>
                ))}
              </span>
              <span>
                <span className="block text-sm font-medium text-fg">{label}</span>
                <span className="block text-xs text-fg-secondary mt-0.5">{description}</span>
              </span>
            </label>
          ))}
        </div>
      </SettingsCard>
    </div>
  );
}

function BehaviorTab({ user, onUserUpdated }: { user: User; onUserUpdated: (u: User) => void }) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resetting, setResetting] = useState(false);
  const [resetConfirmed, setResetConfirmed] = useState(false);
  const [resetError, setResetError] = useState<string | null>(null);
  const resetConfirmedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    // Clear any pending confirmation timer on unmount so setResetConfirmed(false)
    // never runs after teardown — otherwise React logs an unhandled exception
    // when CI is slow enough to outlast the 4s fade (issue #870).
    return () => {
      if (resetConfirmedTimerRef.current !== null) {
        clearTimeout(resetConfirmedTimerRef.current);
        resetConfirmedTimerRef.current = null;
      }
    };
  }, []);

  const toggleCloseOnEnter = async () => {
    const newVal = !(user.close_editor_on_enter ?? true);
    setSaving(true);
    setError(null);
    try {
      const updated = await updateCurrentUser({ close_editor_on_enter: newVal });
      onUserUpdated(updated);
    } catch {
      setError("Failed to save. Please try again.");
    } finally {
      setSaving(false);
    }
  };

  const handleResetTour = async () => {
    setResetting(true);
    setResetConfirmed(false);
    setResetError(null);
    try {
      await resetTour();
      onUserUpdated({ ...user, has_completed_tour: false });
      setResetConfirmed(true);
      if (resetConfirmedTimerRef.current !== null) {
        clearTimeout(resetConfirmedTimerRef.current);
      }
      resetConfirmedTimerRef.current = setTimeout(() => {
        setResetConfirmed(false);
        resetConfirmedTimerRef.current = null;
      }, 4000);
    } catch {
      setResetError("Failed to reset tour. Please try again.");
    } finally {
      setResetting(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <PageHeading level="h3" title="Behavior" description="How the card editor and onboarding work for you." />
      <SettingsCard title="Card editor" headingAs="h4">
        <SettingSwitchRow
          label="Close editor on Enter"
          description="When on, pressing Enter in the inline card input submits the card and closes the editor. Enabled by default."
          checked={user.close_editor_on_enter ?? true}
          busy={saving}
          onChange={() => { if (!saving) void toggleCloseOnEnter(); }}
        />
        <p className="text-xs min-h-4 mt-1" role="alert">{error && <span className="text-danger">{error}</span>}</p>
      </SettingsCard>
      <SettingsCard title="Onboarding" headingAs="h4">
        <Button aria-busy={resetting || undefined} onClick={() => { if (!resetting) void handleResetTour(); }}>
          {resetting ? "Restarting…" : "Restart onboarding tour"}
        </Button>
        <p className="text-xs min-h-4 mt-2" role="status" aria-live="polite">
          {resetConfirmed && <span className="text-success">Tour will restart on your next visit to a board.</span>}
          {resetError && <span className="text-danger">{resetError}</span>}
        </p>
      </SettingsCard>
    </div>
  );
}

function AboutTab() {
  return (
    <div className="flex flex-col gap-4">
      <PageHeading level="h3" title="About" description="The version of Visiban you are using." />
      <SettingsCard>
        <dl className="flex flex-col gap-3">
          <div className="flex flex-col gap-0.5">
            <dt className="text-sm text-fg-secondary">Version</dt>
            <dd className="font-mono text-sm text-fg">{__APP_VERSION__}</dd>
          </div>
          <div className="flex flex-col gap-0.5">
            <dt className="text-sm text-fg-secondary">License</dt>
            <dd className="text-sm text-fg">Apache 2.0</dd>
          </div>
        </dl>
      </SettingsCard>
    </div>
  );
}

export default function SettingsPage({ user, onLogout, onUserUpdated }: Props) {
  const navigate = useNavigate();
  const location = useLocation();
  // Captured once: switching sections rewrites the URL without router state, and the
  // post-save and Escape returns still need to know where the user came from.
  const [from] = useState<Location | undefined>(() => (location.state as { from?: Location } | null)?.from);
  const [searchParams, setSearchParams] = useSearchParams();
  // A connect round trip (#1314) returns here with ?connected=<provider> or
  // ?connect_error=<code>&provider=<provider>. Read once, land on Security so
  // the outcome shows on its row, then drop the params from the URL so a
  // refresh doesn't repeat it.
  const [connectResult] = useState<ConnectResult | null>(() => {
    const connected = searchParams.get("connected");
    if (connected) return { provider: connected, error: null };
    const connectError = searchParams.get("connect_error");
    if (connectError) return { provider: searchParams.get("provider") ?? "", error: connectError };
    return null;
  });

  useEffect(() => {
    if (searchParams.has("connected") || searchParams.has("connect_error")) {
      // void: navigate() can return a Promise in React Router v7; fire-and-forget,
      // there is nothing to roll back if the navigation itself rejects.
      void navigate("?tab=security", { replace: true, state: location.state });
    }
  }, [navigate, searchParams, location.state]);

  // Leave guard: the open section reports unsaved Profile edits or a reveal-once token here.
  // Leaving (another section, Escape, closing the tab) asks first instead of dropping them.
  const unsavedRef = useRef<{ profile: boolean; token: boolean }>({ profile: false, token: false });
  const [leaving, setLeaving] = useState<{ kind: "section"; id: string } | { kind: "leave" } | null>(null);
  const setProfileUnsaved = useCallback((v: boolean) => { unsavedRef.current.profile = v; }, []);
  const setTokenUnsaved = useCallback((v: boolean) => { unsavedRef.current.token = v; }, []);
  const hasUnsaved = () => unsavedRef.current.profile || unsavedRef.current.token;
  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (unsavedRef.current.profile || unsavedRef.current.token) { e.preventDefault(); e.returnValue = ""; }
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, []);
  const goBack = () => {
    // void: navigate() can return a Promise in React Router v7; fire-and-forget,
    // there is nothing to roll back if the navigation itself rejects.
    if (window.history.length > 1) { void navigate(-1); return; }
    void navigate(from ?? "/", { replace: true });
  };
  const confirmLeave = () => {
    const target = leaving;
    setLeaving(null);
    if (target?.kind === "section") {
      const next = new URLSearchParams(searchParams);
      next.set("tab", target.id);
      setSearchParams(next, { replace: true });
    } else if (target) {
      goBack();
    }
  };

  useEscapeStack(() => {
    const tag = (document.activeElement as HTMLElement)?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return false;
    if (hasUnsaved()) { setLeaving({ kind: "leave" }); return; }
    goBack();
  }, 0);

  // Section ids are the old tab ids, so every existing `?tab=` deep link keeps working.
  const sections: SettingsSection[] = [
    { id: "profile", label: "Profile", group: "Account", keywords: ["name", "display name", "username", "email", "timezone", "date format", "time format", "number format", "locale"], render: () => <ProfileTab user={user} onUserUpdated={onUserUpdated} from={from} onUnsavedChange={setProfileUnsaved} /> },
    { id: "security", label: "Security", group: "Account", keywords: ["password", "connected accounts", "google", "github", "gitlab", "oidc", "sign in", "sso"], render: () => <SecurityTab user={user} connectResult={connectResult} onUserUpdated={onUserUpdated} /> },
    { id: "access-tokens", label: "Access tokens", group: "Account", keywords: ["api", "token", "scopes", "mcp", "pat", "revoke"], render: () => <AccessTokensTab user={user} isSiteAdmin={!!user?.is_site_admin} onUnsavedChange={setTokenUnsaved} /> },
    { id: "notifications", label: "Notifications", group: "Preferences", keywords: ["email", "in-app", "mentions", "assigned", "due date", "watching", "stale"], render: () => <NotificationsTab user={user} onUserUpdated={onUserUpdated} /> },
    { id: "appearance", label: "Appearance", group: "Preferences", keywords: ["theme", "dark", "light", "system"], render: () => <AppearanceTab /> },
    { id: "behavior", label: "Behavior", group: "Preferences", keywords: ["card editor", "enter", "onboarding", "tour"], render: () => <BehaviorTab user={user} onUserUpdated={onUserUpdated} /> },
    { id: "about", label: "About", group: "Visiban", keywords: ["version", "license"], render: () => <AboutTab /> },
  ];

  return (
    <div className="h-full bg-sunken flex flex-col">
      <Navbar user={user} onLogout={onLogout} onUserUpdated={onUserUpdated} breadcrumb={[{ label: "Settings" }]} />

      <main className="flex-1 overflow-y-auto">
        {/* h2 under the app shell, whose header owns the h1 (#2473). */}
        <SettingsLayout
          title={
            <div className="flex flex-col gap-4">
              <PageHeading title="Your settings" description="Your account, how Visiban notifies you, and how it looks." />
              {leaving && (
                <InlineConfirm
                  message={unsavedRef.current.token
                    ? "Leave without copying your new access token? It won't be shown again."
                    : "Leave without saving? Your unsaved profile changes will be discarded."}
                  actionLabel="Discard"
                  actionTestId="leave-discard"
                  onConfirm={confirmLeave}
                  onCancel={() => setLeaving(null)}
                />
              )}
            </div>
          }
          sections={sections}
          navLabel="Settings sections"
          defaultId={connectResult ? "security" : undefined}
          onBeforeSelect={(id) => {
            if (!hasUnsaved()) return true;
            setLeaving({ kind: "section", id });
            return false;
          }}
        />
      </main>
    </div>
  );
}
