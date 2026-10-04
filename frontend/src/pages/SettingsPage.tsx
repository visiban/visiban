import { useState, useEffect, useCallback, useRef, useId } from "react";
import { useNavigate, useLocation, useSearchParams } from "react-router-dom";
import { useEscapeStack } from "../hooks/useEscapeStack";
import type { Location } from "react-router-dom";
import { updateCurrentUser, changePassword, listTokens, createToken, revokeToken, resetTour, cancelPendingEmailChange, resendPendingEmailConfirmation, getAuthProviders, listConnectedAccounts, disconnectAccount } from "../api/auth";
import Navbar from "../components/Layout/Navbar";
import type { User, PersonalAccessToken, CreatedPersonalAccessToken, ConnectedAccount, ProviderId } from "../types";
import { ProviderIcon, providerLabel } from "../components/Common/ProviderIcons";
import { startProviderConnect } from "../utils/oauth";
import { useTheme } from "../context/ThemeContext";
import type { ThemePreference } from "../context/ThemeContext";
import { TIMEZONE_OPTIONS, browserTimezone, formatDate as formatDateUtil } from "../utils/date";
import type { UserDatePrefs } from "../utils/date";
import SelectDropdown from "../components/Common/SelectDropdown";
import { Toggle } from "../components/Common/Toggle";

type Tab = "profile" | "security" | "access-tokens" | "notifications" | "appearance" | "behavior" | "about";

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

function ProfileTab({ user, onUserUpdated, from }: { user: User; onUserUpdated: (u: User) => void; from?: Location }) {
  const navigate = useNavigate();
  const [form, setForm] = useState({
    display_name: user.display_name ?? "",
    first_name: user.first_name ?? "",
    last_name: user.last_name ?? "",
    email: user.email ?? "",
    username: user.username ?? "",
    timezone: user.timezone ?? "",
    date_format: user.date_format ?? "MM/DD/YYYY",
    time_format: user.time_format ?? "12h",
    number_locale: user.number_locale ?? "en-US",
  });
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

  const set = (field: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((f) => ({ ...f, [field]: e.target.value }));

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    setSaved(false);
    setEmailNotice(null);
    try {
      // Only send `email` when it was edited. On EMAIL_VERIFICATION=mandatory
      // installs, sending the current address back withdraws a pending email
      // change (#1273), so an unrelated profile save must not include it.
      const { email, ...rest } = form;
      const updated = await updateCurrentUser({
        ...rest,
        ...(email !== (user.email ?? "") ? { email } : {}),
        timezone: form.timezone || browserTimezone(),
        date_format: form.date_format,
        time_format: form.time_format,
        number_locale: form.number_locale,
      });
      onUserUpdated(updated);
      setSaved(true);
      const pending = updated.pending_email ?? null;
      setPendingEmail(pending);
      if (pending) {
        // Stay on the page so the confirmation notice can be read, and show
        // the address that is actually in effect in the field.
        setForm((f) => ({ ...f, email: updated.email ?? "" }));
      } else {
        if (leaveTimerRef.current) clearTimeout(leaveTimerRef.current);
        leaveTimerRef.current = setTimeout(() => navigate(from ?? "/", { replace: true }), 1500);
      }
    } catch (err) {
      const data = (err as { response?: { data?: Record<string, unknown> } })?.response?.data;
      const usernameError = Array.isArray(data?.username) ? data.username[0] : null;
      setError(
        typeof usernameError === "string"
          ? usernameError
          : "Failed to save changes. Please try again.",
      );
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
      const updated = await cancelPendingEmailChange();
      onUserUpdated(updated);
      setPendingEmail(updated.pending_email ?? null);
      setForm((f) => ({ ...f, email: updated.email ?? "" }));
      emailInputRef.current?.focus();
      setEmailNotice({ tone: "success", text: "Email change canceled. Your email address hasn't changed." });
    } catch {
      setEmailNotice({ tone: "danger", text: "Couldn't cancel the email change. Please try again." });
    } finally {
      setPendingAction(null);
    }
  };

  const emailActionClass =
    "text-xs text-fg-secondary hover:text-fg hover:bg-surface-hover rounded px-1.5 py-0.5 transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis disabled:opacity-40 disabled:cursor-not-allowed";

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-5 max-w-lg">
      <h2 className="text-fg text-lg font-semibold">Profile</h2>

      <label className="flex flex-col gap-1 text-sm text-fg-tertiary">
        Display name
        <input
          value={form.display_name}
          onChange={set("display_name")}
          placeholder="How you appear on the board"
          className="bg-surface border border-line rounded px-3 py-1.5 text-sm text-fg-secondary focus:outline-none focus:ring-2 focus:ring-primary-emphasis focus:border-transparent transition placeholder-fg-muted"
        />
      </label>

      <div className="flex gap-3">
        <label className="flex flex-col gap-1 flex-1 text-sm text-fg-tertiary">
          First name
          <input
            value={form.first_name}
            onChange={set("first_name")}
            className="bg-surface border border-line rounded px-3 py-1.5 text-sm text-fg-secondary focus:outline-none focus:ring-2 focus:ring-primary-emphasis focus:border-transparent transition placeholder-fg-muted"
          />
        </label>
        <label className="flex flex-col gap-1 flex-1 text-sm text-fg-tertiary">
          Last name
          <input
            value={form.last_name}
            onChange={set("last_name")}
            className="bg-surface border border-line rounded px-3 py-1.5 text-sm text-fg-secondary focus:outline-none focus:ring-2 focus:ring-primary-emphasis focus:border-transparent transition placeholder-fg-muted"
          />
        </label>
      </div>

      <label className="flex flex-col gap-1 text-sm text-fg-tertiary">
        Username
        <input
          value={form.username}
          onChange={set("username")}
          required
          className="bg-surface border border-line rounded px-3 py-1.5 text-sm text-fg-secondary focus:outline-none focus:ring-2 focus:ring-primary-emphasis focus:border-transparent transition placeholder-fg-muted"
        />
      </label>

      <div className="flex flex-col gap-1 text-sm text-fg-tertiary">
        <label className="flex flex-col gap-1">
          Email address
          <input
            ref={emailInputRef}
            type="email"
            value={form.email}
            onChange={set("email")}
            required
            aria-describedby="pending-email-note"
            className="bg-surface border border-line rounded px-3 py-1.5 text-sm text-fg-secondary focus:outline-none focus:ring-2 focus:ring-primary-emphasis focus:border-transparent transition placeholder-fg-muted"
          />
        </label>
        {/* Reserved slot (frontend/CLAUDE.md § Inline status messages): the
            container always renders so the form doesn't shift, and the
            input's aria-describedby always has a stable target. */}
        <span id="pending-email-note" data-testid="pending-email-note" className="block min-h-4 text-xs text-fg-muted">
          {pendingEmail &&
            `Waiting for confirmation: we sent a link to ${pendingEmail}. Your email address changes once you open it.`}
        </span>
        {/* #1293: outside the <label> so the buttons don't become part of the
            input's accessible name. Only while a change is pending; the note
            above says what they act on. */}
        {pendingEmail && (
          <div className="flex items-center gap-3 -ml-1.5">
            <button
              type="button"
              onClick={handleResend}
              disabled={pendingAction !== null || saving}
              aria-describedby="pending-email-note"
              className={emailActionClass}
            >
              {pendingAction === "resend" ? "Sending…" : "Resend link"}
            </button>
            <button
              type="button"
              onClick={handleCancelChange}
              disabled={pendingAction !== null || saving}
              aria-describedby="pending-email-note"
              className={emailActionClass}
            >
              {pendingAction === "cancel" ? "Canceling…" : "Cancel change"}
            </button>
          </div>
        )}
      </div>

      <div className="flex flex-col gap-1 text-sm text-fg-tertiary">
        Timezone
        <SelectDropdown
          value={form.timezone}
          onChange={(v) => setForm((f) => ({ ...f, timezone: v }))}
          options={[
            { value: "", label: `Detect automatically (${browserTimezone()})` },
            ...TIMEZONE_OPTIONS.map(({ value, label }) => ({ value, label: `${label} — ${value}` })),
          ]}
          className="w-full"
        />
        <span className="text-xs text-fg-muted">Used for due date labels and filters</span>
      </div>

      <div className="border-t border-line pt-4">
        <p className="text-sm text-fg-secondary font-medium mb-4">Locale</p>
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1 text-sm text-fg-tertiary">
            Date format
            <SelectDropdown
              value={form.date_format}
              onChange={(v) => setForm((f) => ({ ...f, date_format: v }))}
              options={DATE_FORMAT_OPTIONS}
              className="w-full"
            />
          </div>
          <div className="flex flex-col gap-1 text-sm text-fg-tertiary">
            Time format
            <SelectDropdown
              value={form.time_format}
              onChange={(v) => setForm((f) => ({ ...f, time_format: v }))}
              options={TIME_FORMAT_OPTIONS}
              className="w-full"
            />
          </div>
          <div className="flex flex-col gap-1 text-sm text-fg-tertiary">
            Number format
            <SelectDropdown
              value={form.number_locale}
              onChange={(v) => setForm((f) => ({ ...f, number_locale: v }))}
              options={NUMBER_LOCALE_OPTIONS}
              className="w-full"
            />
          </div>
        </div>
      </div>

      {/* Live region: with an email change pending the page stays here, so
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

      <div>
        <button
          type="submit"
          disabled={saving || pendingAction !== null}
          className="bg-button-primary hover:bg-button-primary-hover disabled:opacity-40 text-on-primary text-sm font-medium px-5 py-2 rounded transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
        >
          {saving ? "Saving…" : "Save changes"}
        </button>
      </div>
    </form>
  );
}

/** The outcome of a connect round trip, read from /settings?connected= or
 *  ?connect_error= by SettingsPage (#1314). */
interface ConnectResult {
  provider: string;
  error: string | null;
}

const PROVIDER_ORDER: ProviderId[] = ["google", "github", "gitlab", "oidc"];

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
  const hintId = `disconnect-hint-${provider}`;
  return (
    <div className="flex items-center gap-3 px-4 py-3 bg-surface/50 hover:bg-surface transition" data-testid={`connected-account-${provider}`}>
      <ProviderIcon id={provider} className="w-5 h-5 shrink-0" />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm text-fg truncate">{label}</span>
          {connected ? (
            <span className="px-2 py-0.5 text-xs rounded-full bg-success/20 text-success">Connected</span>
          ) : (
            <span className="px-2 py-0.5 text-xs rounded-full border border-line text-fg-tertiary">Not connected</span>
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
      <div className="shrink-0 flex flex-col items-end gap-1">
        {connected ? (
          confirming ? (
            <div className="flex flex-wrap items-center justify-end gap-2 max-w-sm">
              <span className="text-xs text-fg-tertiary">
                Disconnect <span className="text-fg font-medium">{label}</span>? You will no longer be able to sign in with it.
              </span>
              <button
                type="button"
                onClick={onConfirmDisconnect}
                disabled={disconnecting}
                className="text-xs text-danger hover:text-danger font-medium transition disabled:opacity-40 rounded focus:outline-none focus:ring-2 focus:ring-danger-emphasis"
                aria-label={`Confirm disconnect ${label}`}
                data-testid={`confirm-disconnect-${provider}`}
              >
                {disconnecting ? "Disconnecting…" : "Confirm"}
              </button>
              <button
                type="button"
                onClick={onCancelDisconnect}
                disabled={disconnecting}
                className="text-xs text-fg-tertiary hover:text-fg transition disabled:opacity-40 rounded focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
              >
                Cancel
              </button>
            </div>
          ) : (
            // aria-disabled, never native `disabled`: a disabled button drops
            // out of the tab order and hides *why* from keyboard and screen-
            // reader users. The reason stays visible and is announced via
            // aria-describedby; the click is a no-op.
            <button
              type="button"
              aria-disabled={isOnlyMethod}
              aria-describedby={isOnlyMethod ? hintId : undefined}
              onClick={isOnlyMethod ? undefined : onStartDisconnect}
              className={
                isOnlyMethod
                  ? "text-xs rounded text-fg-tertiary opacity-40 cursor-not-allowed focus:outline-none focus:ring-2 focus:ring-danger-emphasis"
                  : "text-xs rounded text-fg-tertiary hover:text-danger transition focus:outline-none focus:ring-2 focus:ring-danger-emphasis"
              }
              aria-label={`Disconnect ${label}`}
              data-testid={`disconnect-${provider}`}
            >
              Disconnect
            </button>
          )
        ) : (
          <button
            type="button"
            onClick={onConnect}
            disabled={connecting}
            className="px-3 py-1.5 text-sm font-medium bg-button-primary hover:bg-button-primary-hover disabled:opacity-40 text-on-primary rounded transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
            data-testid={`connect-${provider}`}
          >
            {connecting ? "Connecting…" : "Connect"}
          </button>
        )}
        {isOnlyMethod && (
          <p id={hintId} className="text-xs text-fg-muted text-right">This is your only sign-in method.</p>
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
      setAccounts(await disconnectAccount(id));
      setConfirmingId(null);
    } catch (err: unknown) {
      const detail = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
      setRowStatus({ provider: id, error: detail ?? `Couldn't disconnect ${labelFor(id)}. Please try again.`, fromUrl: false });
      setConfirmingId(null);
    } finally {
      setDisconnectingId(null);
    }
  };

  return (
    <div className="flex flex-col gap-3 border-t border-line pt-4" data-testid="connected-accounts">
      <div>
        <h3 className="text-sm font-medium text-fg-tertiary uppercase tracking-wide">Connected accounts</h3>
        <p className="text-sm text-fg-tertiary mt-1">
          Connect an account for faster sign-in. You must keep at least one way to sign in.
        </p>
      </div>
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
    </div>
  );
}

/** Connect-return codes (from the URL) become fixed copy — never echoed
 *  verbatim; any other string is a server `detail` from a disconnect call. */
function connectErrorOrDetail(error: string, label: string, fromUrl: boolean): string {
  return fromUrl ? connectErrorMessage(error, label) : error;
}

function SecurityTab({ user, connectResult = null }: { user: User; connectResult?: ConnectResult | null }) {
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

  const set = (field: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((f) => ({ ...f, [field]: e.target.value }));

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
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
      setSaved(true);
      setPasswordJustSet(true);
      setForm({ current_password: "", new_password: "", confirm: "" });
    } catch {
      setError(
        hasPw
          ? "Failed to change password. Check your current password and try again."
          : "Failed to set password. Please try again."
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex flex-col gap-8 max-w-lg">
      <form onSubmit={handleSubmit} className="flex flex-col gap-5">
        <h2 className="text-fg text-lg font-semibold">Security</h2>

        {!hasPw && (
          <p className="text-sm text-fg-tertiary">
            You signed in with a social account. Set a password below to also enable
            username/password login.
          </p>
        )}

        {hasPw && (
          <label className="flex flex-col gap-1 text-sm text-fg-tertiary">
            Current password
            <input
              type="password"
              value={form.current_password}
              onChange={set("current_password")}
              required
              autoComplete="current-password"
              className="bg-surface border border-line rounded px-3 py-1.5 text-sm text-fg-secondary focus:outline-none focus:ring-2 focus:ring-primary-emphasis focus:border-transparent transition placeholder-fg-muted"
            />
          </label>
        )}

        <label className="flex flex-col gap-1 text-sm text-fg-tertiary">
          New password
          <input
            type="password"
            value={form.new_password}
            onChange={set("new_password")}
            required
            autoComplete="new-password"
            minLength={12}
            className="bg-surface border border-line rounded px-3 py-1.5 text-sm text-fg-secondary focus:outline-none focus:ring-2 focus:ring-primary-emphasis focus:border-transparent transition placeholder-fg-muted"
          />
        </label>

        <label className="flex flex-col gap-1 text-sm text-fg-tertiary">
          Confirm new password
          <input
            type="password"
            value={form.confirm}
            onChange={set("confirm")}
            required
            autoComplete="new-password"
            className="bg-surface border border-line rounded px-3 py-1.5 text-sm text-fg-secondary focus:outline-none focus:ring-2 focus:ring-primary-emphasis focus:border-transparent transition placeholder-fg-muted"
          />
        </label>

        <p className="text-xs h-4">
          {error && <span className="text-danger">{error}</span>}
          {saved && !error && <span className="text-success">{hasPw ? "Password changed successfully." : "Password set successfully."}</span>}
        </p>

        <div>
          <button
            type="submit"
            disabled={saving}
            className="bg-button-primary hover:bg-button-primary-hover disabled:opacity-40 text-on-primary text-sm font-medium px-5 py-2 rounded transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
          >
            {saving ? (hasPw ? "Changing…" : "Setting…") : (hasPw ? "Change password" : "Set password")}
          </button>
        </div>
      </form>
      <ConnectedAccountsSection hasUsablePassword={hasPw || passwordJustSet} connectResult={connectResult} />
    </div>
  );
}

const PAT_MAX = 10;

function AccessTokensTab({ user }: { user?: UserDatePrefs | null }) {
  const [tokens, setTokens] = useState<PersonalAccessToken[]>([]);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState("");
  const [expiresAt, setExpiresAt] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [newToken, setNewToken] = useState<CreatedPersonalAccessToken | null>(null);
  const [revokingId, setRevokingId] = useState<number | null>(null);
  const [confirmRevokeId, setConfirmRevokeId] = useState<number | null>(null);
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

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    setCreating(true);
    setCreateError(null);
    try {
      const created = await createToken(name.trim(), expiresAt || undefined);
      setNewToken(created);
      setName("");
      setExpiresAt("");
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

  return (
    <div className="flex flex-col gap-6 max-w-2xl" data-testid="access-tokens-tab">
      <h2 className="text-fg text-lg font-semibold">Access Tokens</h2>
      <p className="text-sm text-fg-tertiary">
        Personal access tokens let you authenticate API requests. Tokens are shown once on creation.
        All tokens are revoked if you change your password.
      </p>

      {/* One-time reveal panel */}
      {newToken && (
        <div className="border border-warning/50 rounded-lg p-4 bg-sunken flex flex-col gap-2" data-testid="new-token-reveal">
          <p className="text-sm text-warning font-medium">
            Copy your token now — it won't be shown again.
          </p>
          <code className="font-mono text-sm text-fg bg-sunken px-3 py-2 rounded break-all select-all" data-testid="new-token-value">
            {newToken.token}
          </code>
          <button
            onClick={() => setNewToken(null)}
            className="self-end text-xs text-fg-tertiary hover:text-fg transition"
            data-testid="dismiss-token"
          >
            I've copied it — dismiss
          </button>
        </div>
      )}

      {/* Create form */}
      {tokens.length < PAT_MAX && (
        <form onSubmit={handleCreate} className="flex flex-col gap-3" data-testid="create-token-form">
          <h3 className="text-sm font-medium text-fg-tertiary uppercase tracking-wide">New token</h3>
          <div className="flex gap-2 flex-wrap">
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Token name (e.g. CI pipeline)"
              maxLength={64}
              required
              className="flex-1 min-w-0 bg-surface border border-line rounded px-3 py-1.5 text-sm text-fg-secondary placeholder-fg-muted focus:outline-none focus:ring-2 focus:ring-primary-emphasis focus:border-transparent"
              data-testid="token-name-input"
            />
            <input
              type="date"
              value={expiresAt}
              onChange={(e) => setExpiresAt(e.target.value)}
              title="Optional expiry date (max 1 year)"
              className="bg-surface border border-line rounded px-3 py-1.5 text-sm text-fg-secondary focus:outline-none focus:ring-2 focus:ring-primary-emphasis focus:border-transparent"
              data-testid="token-expiry-input"
            />
            <button
              type="submit"
              disabled={creating || !name.trim()}
              className="bg-button-primary hover:bg-button-primary-hover disabled:opacity-40 text-on-primary text-sm font-medium px-3 py-1.5 rounded transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
              data-testid="create-token-button"
            >
              {creating ? "Creating…" : "Generate token"}
            </button>
          </div>
          <p className="text-xs h-4">
            {createError
              ? <span className="text-danger">{createError}</span>
              : <span className="text-fg-muted">Leave expiry blank for a non-expiring token (max 1 year if set).</span>
            }
          </p>
        </form>
      )}
      {tokens.length >= PAT_MAX && (
        <p className="text-sm text-warning" data-testid="max-tokens-notice">
          You've reached the maximum of {PAT_MAX} tokens. Revoke one to create another.
        </p>
      )}

      {/* Token list */}
      {loading ? (
        <div className="flex items-center justify-center py-8">
          <div className="w-5 h-5 border-2 border-primary border-t-transparent rounded-full animate-spin" />
        </div>
      ) : loadError ? (
        <p className="text-sm text-danger" data-testid="tokens-load-error">{loadError}</p>
      ) : tokens.length === 0 ? (
        <p className="text-sm text-fg-muted" data-testid="no-tokens-message">No access tokens yet.</p>
      ) : (
        <div className="flex flex-col gap-1" data-testid="token-list">
          <div className="grid grid-cols-[1fr_auto_auto_auto] gap-x-4 px-3 py-1.5 text-xs text-fg-muted uppercase tracking-wide border-b border-line">
            <span>Name</span>
            <span>Created</span>
            <span>Expires</span>
            <span />
          </div>
          {tokens.map((token) => (
            <div
              key={token.id}
              className="grid grid-cols-[1fr_auto_auto_auto] gap-x-4 items-center px-3 py-2 rounded hover:bg-surface/50"
              data-testid={`token-row-${token.id}`}
            >
              <div className="flex flex-col gap-0.5 min-w-0">
                <span className="text-sm text-fg truncate">{token.name}</span>
                <span className="font-mono text-xs text-fg-muted">{token.prefix}…</span>
              </div>
              <span className="text-xs text-fg-tertiary whitespace-nowrap">{formatDate(token.created_at)}</span>
              <span className="text-xs text-fg-tertiary whitespace-nowrap">{formatDate(token.expires_at)}</span>
              <div className="flex items-center gap-2">
                {confirmRevokeId !== token.id && (
                  <button
                    type="button"
                    onClick={() => { setRevokeError(null); setConfirmRevokeId(token.id); }}
                    aria-label={`Revoke ${token.name}`}
                    className="text-xs text-fg-tertiary hover:text-danger transition rounded focus:outline-none focus:ring-2 focus:ring-danger-emphasis"
                    data-testid={`revoke-${token.id}`}
                  >
                    Revoke
                  </button>
                )}
              </div>
              {confirmRevokeId === token.id && (
                <div className="col-span-full mt-1 flex flex-wrap items-center gap-2 text-xs">
                  <span className="text-fg-tertiary">
                    Revoke <span className="text-fg font-medium">{token.name}</span>? Anything using this token will lose access.
                  </span>
                  <button
                    type="button"
                    onClick={() => handleRevoke(token.id)}
                    disabled={revokingId === token.id}
                    className="text-danger hover:text-danger font-medium transition disabled:opacity-40 rounded focus:outline-none focus:ring-2 focus:ring-danger-emphasis"
                    data-testid={`confirm-revoke-${token.id}`}
                  >
                    {revokingId === token.id ? "Revoking…" : "Confirm"}
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmRevokeId(null)}
                    disabled={revokingId === token.id}
                    className="text-fg-tertiary hover:text-fg transition disabled:opacity-40 rounded focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
                  >
                    Cancel
                  </button>
                  {revokeError && <span role="alert" className="text-danger">{revokeError}</span>}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
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
  { key: "notif_card_assigned", label: "Card assigned to me", description: "When someone assigns a card to you", emailKey: "email_notif_card_assigned" },
  { key: "notif_mentioned", label: "Someone @mentions me", description: "When you are mentioned in a comment", emailKey: "email_notif_mentioned" },
  { key: "notif_due_soon", label: "Due date approaching", description: "24h warning before a card you own is due", emailKey: "email_notif_due_soon" },
  { key: "notif_card_moved", label: "Card I\u2019m watching is moved", description: "When a watched card changes column", emailKey: "email_notif_card_moved" },
  { key: "notif_comment_added", label: "Comment on a watched card", description: "When someone comments on a card you\u2019re watching", emailKey: "email_notif_comment_added" },
  { key: "notif_stale", label: "Card has gone stale", description: "When a card you own has not moved for a while" },
];

/**
 * One event's in-app toggle plus, where the event supports it, a subordinate
 * email toggle.
 *
 * Two structural notes that are load-bearing rather than cosmetic:
 *
 * - The row is NOT wrapped in a single `<label>` any more. With two controls in
 *   one label, a click on the text forwards to the first labelable descendant,
 *   so clicking the email row's text would flip the in-app switch. Each control
 *   gets its own `htmlFor` label around its own text block instead.
 * - The email toggle is disabled while the in-app toggle is off, because email
 *   delivery rides on the in-app notification row: with no notification there is
 *   nothing to email, so an enabled-looking toggle would silently do nothing.
 *   The stored value is deliberately left alone rather than auto-cleared — that
 *   would need a second PATCH, could half-fail, and would throw away a choice
 *   the user will want back when they re-enable the in-app notification.
 *
 * Extracted as a component so `useId` is called once per row rather than inside
 * a `.map` callback.
 */
function NotificationRow({
  spec,
  prefs,
  saving,
  onToggle,
}: {
  spec: NotifRowSpec;
  prefs: NotifPrefs;
  saving: string | null;
  onToggle: (field: NotifPrefKey | EmailPrefKey) => void;
}) {
  const baseId = useId();
  const appId = `${baseId}-app`;
  const emailId = `${baseId}-email`;
  const reasonId = `${baseId}-reason`;

  const appOn = prefs[spec.key];
  const emailKey = spec.emailKey;
  const emailOn = emailKey ? prefs[emailKey] : false;

  // Four states, because the same sentence cannot honestly describe all of them.
  // In particular the ON-sounding "Sends a copy..." must not appear under a
  // switch that is off, where it reads as a claim that email is already going out.
  let emailHelper = emailOn
    ? "Sends a copy to your account address."
    : "Email a copy to your account address.";
  if (emailKey && !appOn) {
    emailHelper = emailOn
      ? "Paused while the in-app notification above is off. Your email setting is kept."
      : "Turn on the in-app notification above to enable email.";
  }

  return (
    <div role="group" aria-label={spec.label} className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-4">
        <label htmlFor={appId} className="min-w-0 cursor-pointer">
          <span className="block text-sm text-fg">{spec.label}</span>
          <span className="block text-xs text-fg-muted">{spec.description}</span>
        </label>
        <Toggle
          id={appId}
          checked={appOn}
          onChange={() => onToggle(spec.key)}
          disabled={saving === spec.key}
          aria-label={spec.label}
        />
      </div>
      {emailKey && (
        <div className="ml-6 border-l-2 border-line pl-4 flex items-center justify-between gap-4">
          <label
            htmlFor={emailId}
            className={`min-w-0 ${appOn ? "cursor-pointer" : "cursor-not-allowed"}`}
          >
            <span className={`block text-sm ${appOn ? "text-fg" : "text-fg-muted"}`}>
              Also send by email
            </span>
            <span id={reasonId} className="block text-xs text-fg-muted">
              {emailHelper}
            </span>
          </label>
          <Toggle
            id={emailId}
            checked={emailOn}
            onChange={() => onToggle(emailKey)}
            disabled={saving === emailKey}
            // The reason this switch is inert (parent notification is off) is
            // shown via aria-describedby below, so keyboard focus must be able
            // to reach it — native `disabled` would remove it from the tab
            // order and leave the reason reachable only in browse mode (#1159).
            ariaDisabled={!appOn}
            aria-label={`Also send by email: ${spec.label}`}
            aria-describedby={reasonId}
          />
        </div>
      )}
    </div>
  );
}

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
    <div className="flex flex-col gap-5 max-w-lg">
      <h2 className="text-fg text-lg font-semibold">Notifications</h2>
      <div className="flex flex-col gap-1">
        <p className="text-sm text-fg-tertiary">
          Choose which events notify you in the app, and which of those are also emailed to you.
        </p>
        <p className="text-xs text-fg-muted">
          An email is a copy of the in-app notification, so the event must be on in the app first.
          Emails go to your account address and are only sent if your administrator has set up
          outgoing email.
        </p>
      </div>
      <div className="flex flex-col gap-4">
        {NOTIF_ROWS.map((spec) => (
          <NotificationRow
            key={spec.key}
            spec={spec}
            prefs={prefs}
            saving={saving}
            onToggle={toggle}
          />
        ))}
      </div>
      {error && <p role="alert" className="text-sm text-danger">{error}</p>}
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
    <div className="flex flex-col gap-5 max-w-lg">
      <h2 className="text-fg text-lg font-semibold">Appearance</h2>

      <div>
        <p className="text-sm text-fg-tertiary mb-3">Theme</p>
        <div className="flex flex-col gap-2" role="radiogroup" aria-label="Theme">
          {THEME_OPTIONS.map(({ value, label, description }) => (
            <label
              key={value}
              className={`flex items-center gap-3 w-full px-4 py-3 rounded-lg border transition-colors duration-150 cursor-pointer focus-within:ring-2 focus-within:ring-primary-emphasis ${
                preference === value
                  ? "border-primary-emphasis bg-primary-emphasis/10"
                  : "border-line-strong hover:bg-surface-hover/40"
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
              <span className={`w-4 h-4 rounded-full border-2 flex items-center justify-center shrink-0 ${
                preference === value ? "border-primary-emphasis" : "border-line-strong"
              }`}>
                {preference === value && (
                  <span className="w-2 h-2 rounded-full bg-primary-emphasis" />
                )}
              </span>
              <span>
                <span className="block text-sm font-medium text-fg">{label}</span>
                <span className="block text-xs text-fg-muted mt-0.5">{description}</span>
              </span>
            </label>
          ))}

        </div>
      </div>

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
    <div className="flex flex-col gap-5 max-w-lg">
      <h2 className="text-fg text-lg font-semibold">Behavior</h2>

      <div>
        <p className="text-sm text-fg-tertiary mb-3">Card editor</p>
        <label className="flex items-center justify-between gap-4 cursor-pointer">
          <span>
            <span className="block text-sm text-fg">Close editor on Enter</span>
            <span className="block text-xs text-fg-muted">When on, pressing Enter in the inline card input submits the card and closes the editor. Enabled by default.</span>
          </span>
          <Toggle
            checked={user.close_editor_on_enter ?? true}
            onChange={() => toggleCloseOnEnter()}
            disabled={saving}
            aria-label="Close editor on Enter"
          />
        </label>
        <p className="text-xs h-4 mt-1">{error && <span className="text-danger">{error}</span>}</p>
      </div>

      <div className="border-t border-line pt-4">
        <p className="text-sm text-fg-secondary font-medium mb-3">Onboarding</p>
        <button
          disabled={resetting}
          onClick={handleResetTour}
          className="text-sm text-fg-secondary hover:text-fg hover:bg-surface-hover px-3 py-1.5 rounded transition disabled:opacity-40 focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
        >
          {resetting ? "Restarting…" : "Restart onboarding tour"}
        </button>
        <p className="text-xs h-4 mt-1">
          {resetConfirmed && <span className="text-success">Tour will restart on your next visit to a board.</span>}
          {resetError && <span className="text-danger">{resetError}</span>}
        </p>
      </div>
    </div>
  );
}

function AboutTab() {
  return (
    <div className="flex flex-col gap-5 max-w-lg">
      <h2 className="text-fg text-lg font-semibold">About</h2>
      <div className="flex flex-col gap-3">
        <div className="flex flex-col gap-0.5">
          <span className="text-sm text-fg-tertiary">Version</span>
          <span className="font-mono text-xs text-fg-muted">{__APP_VERSION__}</span>
        </div>
        <div className="flex flex-col gap-0.5">
          <span className="text-sm text-fg-tertiary">License</span>
          <span className="text-xs text-fg-muted">Apache 2.0</span>
        </div>
      </div>
    </div>
  );
}

const TABS: { id: Tab; label: string }[] = [
  { id: "profile", label: "Profile" },
  { id: "security", label: "Security" },
  { id: "access-tokens", label: "Access Tokens" },
  { id: "notifications", label: "Notifications" },
  { id: "appearance", label: "Appearance" },
  { id: "behavior", label: "Behavior" },
  { id: "about", label: "About" },
];

export default function SettingsPage({ user, onLogout, onUserUpdated }: Props) {
  const navigate = useNavigate();
  const location = useLocation();
  const from = (location.state as { from?: Location } | null)?.from;
  const [searchParams] = useSearchParams();
  // A connect round trip (#1314) returns here with ?connected=<provider> or
  // ?connect_error=<code>&provider=<provider>. Read once, open the Security
  // tab so the outcome shows on its row, then drop the params from the URL
  // so a refresh doesn't repeat it.
  const [connectResult] = useState<ConnectResult | null>(() => {
    const connected = searchParams.get("connected");
    if (connected) return { provider: connected, error: null };
    const connectError = searchParams.get("connect_error");
    if (connectError) return { provider: searchParams.get("provider") ?? "", error: connectError };
    return null;
  });
  const [activeTab, setActiveTab] = useState<Tab>(connectResult ? "security" : "profile");

  useEffect(() => {
    if (searchParams.has("connected") || searchParams.has("connect_error")) {
      // void: navigate() can return a Promise in React Router v7; fire-and-forget,
      // there is nothing to roll back if the navigation itself rejects.
      void navigate(".", { replace: true, state: location.state });
    }
  }, [navigate, searchParams, location.state]);

  useEscapeStack(() => {
    const tag = (document.activeElement as HTMLElement)?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return false;
    // void: navigate() can return a Promise in React Router v7; fire-and-forget,
    // there is nothing to roll back if the navigation itself rejects.
    if (window.history.length > 1) { void navigate(-1); return; }
    void navigate(from ?? "/", { replace: true });
  }, 0);

  return (
    <div className="h-full bg-sunken flex flex-col">
      <Navbar user={user} onLogout={onLogout} onUserUpdated={onUserUpdated} breadcrumb={[{ label: "Settings" }]} />

      <main className="flex-1 overflow-y-auto p-8 max-w-4xl mx-auto w-full">
        <h1 className="text-fg text-2xl font-bold mb-8">Settings</h1>

        <div className="flex gap-8">
          {/* Sidebar nav */}
          <nav className="w-44 shrink-0">
            <ul className="flex flex-col gap-0.5">
              {TABS.map((tab) => (
                <li key={tab.id}>
                  <button
                    onClick={() => setActiveTab(tab.id)}
                    className={`w-full text-left px-3 py-2 rounded text-sm transition ${
                      activeTab === tab.id
                        ? "bg-primary text-on-primary font-medium"
                        : "text-fg-tertiary hover:text-fg hover:bg-surface"
                    }`}
                  >
                    {tab.label}
                  </button>
                </li>
              ))}
            </ul>
          </nav>

          {/* Content */}
          <div className="flex-1 min-w-0">
            {activeTab === "profile" && <ProfileTab user={user} onUserUpdated={onUserUpdated} from={from} />}
            {activeTab === "security" && <SecurityTab user={user} connectResult={connectResult} />}
            {activeTab === "access-tokens" && <AccessTokensTab user={user} />}
            {activeTab === "notifications" && <NotificationsTab user={user} onUserUpdated={onUserUpdated} />}
            {activeTab === "appearance" && <AppearanceTab />}
            {activeTab === "behavior" && <BehaviorTab user={user} onUserUpdated={onUserUpdated} />}
            {activeTab === "about" && <AboutTab />}
          </div>
        </div>
      </main>
    </div>
  );
}
