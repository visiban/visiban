import { useState, useEffect, useCallback } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { useEscapeStack } from "../hooks/useEscapeStack";
import type { Location } from "react-router-dom";
import { updateCurrentUser, changePassword, listTokens, createToken, revokeToken } from "../api/auth";
import Navbar from "../components/Layout/Navbar";
import type { User, PersonalAccessToken, CreatedPersonalAccessToken } from "../types";
import { useTheme } from "../context/ThemeContext";
import type { ThemePreference } from "../context/ThemeContext";
import { TIMEZONE_OPTIONS, browserTimezone } from "../utils/date";
import SelectDropdown from "../components/Common/SelectDropdown";

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

  const set = (field: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((f) => ({ ...f, [field]: e.target.value }));

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const updated = await updateCurrentUser({
        ...form,
        timezone: form.timezone || browserTimezone(),
        date_format: form.date_format,
        time_format: form.time_format,
        number_locale: form.number_locale,
      });
      onUserUpdated(updated);
      setSaved(true);
      setTimeout(() => navigate(from ?? "/", { replace: true }), 1500);
    } catch {
      setError("Failed to save changes. Please try again.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-5 max-w-lg">
      <h2 className="text-white text-lg font-semibold">Profile</h2>

      <label className="flex flex-col gap-1 text-sm text-slate-400">
        Display name
        <input
          value={form.display_name}
          onChange={set("display_name")}
          placeholder="How you appear on the board"
          className="bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition placeholder-slate-500"
        />
      </label>

      <div className="flex gap-3">
        <label className="flex flex-col gap-1 flex-1 text-sm text-slate-400">
          First name
          <input
            value={form.first_name}
            onChange={set("first_name")}
            className="bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition placeholder-slate-500"
          />
        </label>
        <label className="flex flex-col gap-1 flex-1 text-sm text-slate-400">
          Last name
          <input
            value={form.last_name}
            onChange={set("last_name")}
            className="bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition placeholder-slate-500"
          />
        </label>
      </div>

      <label className="flex flex-col gap-1 text-sm text-slate-400">
        Username
        <input
          value={form.username}
          onChange={set("username")}
          required
          className="bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition placeholder-slate-500"
        />
      </label>

      <label className="flex flex-col gap-1 text-sm text-slate-400">
        Email address
        <input
          type="email"
          value={form.email}
          onChange={set("email")}
          required
          className="bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition placeholder-slate-500"
        />
      </label>

      <div className="flex flex-col gap-1 text-sm text-slate-400">
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
        <span className="text-xs text-slate-500">Used for due date labels and filters</span>
      </div>

      <div className="border-t border-slate-700 pt-4">
        <p className="text-sm text-slate-300 font-medium mb-4">Locale</p>
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1 text-sm text-slate-400">
            Date format
            <SelectDropdown
              value={form.date_format}
              onChange={(v) => setForm((f) => ({ ...f, date_format: v }))}
              options={DATE_FORMAT_OPTIONS}
              className="w-full"
            />
          </div>
          <div className="flex flex-col gap-1 text-sm text-slate-400">
            Time format
            <SelectDropdown
              value={form.time_format}
              onChange={(v) => setForm((f) => ({ ...f, time_format: v }))}
              options={TIME_FORMAT_OPTIONS}
              className="w-full"
            />
          </div>
          <div className="flex flex-col gap-1 text-sm text-slate-400">
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

      <p className="text-xs h-4">
        {error && <span className="text-red-400">{error}</span>}
        {saved && !error && <span className="text-green-400">Changes saved.</span>}
      </p>

      <div>
        <button
          type="submit"
          disabled={saving}
          className="bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white text-sm px-5 py-2 rounded-lg transition"
        >
          {saving ? "Saving…" : "Save changes"}
        </button>
      </div>
    </form>
  );
}

function SecurityTab({ user }: { user: User }) {
  // Default true: older API responses that predate this field should be
  // treated as password accounts so the current-password field is shown.
  const hasPw = user.has_usable_password ?? true;
  const [form, setForm] = useState({ current_password: "", new_password: "", confirm: "" });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

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
    <form onSubmit={handleSubmit} className="flex flex-col gap-5 max-w-lg">
      <h2 className="text-white text-lg font-semibold">Security</h2>

      {!hasPw && (
        <p className="text-sm text-slate-400">
          You signed in with a social account. Set a password below to also enable
          username/password login.
        </p>
      )}

      {hasPw && (
        <label className="flex flex-col gap-1 text-sm text-slate-400">
          Current password
          <input
            type="password"
            value={form.current_password}
            onChange={set("current_password")}
            required
            autoComplete="current-password"
            className="bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition placeholder-slate-500"
          />
        </label>
      )}

      <label className="flex flex-col gap-1 text-sm text-slate-400">
        New password
        <input
          type="password"
          value={form.new_password}
          onChange={set("new_password")}
          required
          autoComplete="new-password"
          minLength={12}
          className="bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition placeholder-slate-500"
        />
      </label>

      <label className="flex flex-col gap-1 text-sm text-slate-400">
        Confirm new password
        <input
          type="password"
          value={form.confirm}
          onChange={set("confirm")}
          required
          autoComplete="new-password"
          className="bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition placeholder-slate-500"
        />
      </label>

      <p className="text-xs h-4">
        {error && <span className="text-red-400">{error}</span>}
        {saved && !error && <span className="text-green-400">{hasPw ? "Password changed successfully." : "Password set successfully."}</span>}
      </p>

      <div>
        <button
          type="submit"
          disabled={saving}
          className="bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white text-sm px-5 py-2 rounded-lg transition"
        >
          {saving ? (hasPw ? "Changing…" : "Setting…") : (hasPw ? "Change password" : "Set password")}
        </button>
      </div>
    </form>
  );
}

const PAT_MAX = 10;

function AccessTokensTab() {
  const [tokens, setTokens] = useState<PersonalAccessToken[]>([]);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState("");
  const [expiresAt, setExpiresAt] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [newToken, setNewToken] = useState<CreatedPersonalAccessToken | null>(null);
  const [revokingId, setRevokingId] = useState<number | null>(null);
  const [confirmRevokeId, setConfirmRevokeId] = useState<number | null>(null);

  const fetchTokens = useCallback(async () => {
    try {
      setTokens(await listTokens());
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchTokens(); }, [fetchTokens]);

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
    setRevokingId(id);
    setConfirmRevokeId(null);
    try {
      await revokeToken(id);
      setTokens((prev) => prev.filter((t) => t.id !== id));
      if (newToken?.id === id) setNewToken(null);
    } finally {
      setRevokingId(null);
    }
  };

  const formatDate = (iso: string | null) => {
    if (!iso) return "Never";
    return new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  };

  return (
    <div className="flex flex-col gap-6 max-w-2xl" data-testid="access-tokens-tab">
      <h2 className="text-white text-lg font-semibold">Access Tokens</h2>
      <p className="text-sm text-slate-400">
        Personal access tokens let you authenticate API requests. Tokens are shown once on creation.
        All tokens are revoked if you change your password.
      </p>

      {/* One-time reveal panel */}
      {newToken && (
        <div className="border border-amber-600 rounded-lg p-4 bg-amber-900/20 flex flex-col gap-2" data-testid="new-token-reveal">
          <p className="text-sm text-amber-400 font-medium">
            Copy your token now — it won't be shown again.
          </p>
          <code className="font-mono text-sm text-slate-200 bg-slate-900 px-3 py-2 rounded break-all select-all" data-testid="new-token-value">
            {newToken.token}
          </code>
          <button
            onClick={() => setNewToken(null)}
            className="self-end text-xs text-slate-400 hover:text-white transition"
            data-testid="dismiss-token"
          >
            I've copied it — dismiss
          </button>
        </div>
      )}

      {/* Create form */}
      {tokens.length < PAT_MAX && (
        <form onSubmit={handleCreate} className="flex flex-col gap-3" data-testid="create-token-form">
          <h3 className="text-sm font-medium text-slate-400 uppercase tracking-wide">New token</h3>
          <div className="flex gap-2 flex-wrap">
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Token name (e.g. CI pipeline)"
              maxLength={64}
              required
              className="flex-1 min-w-0 bg-slate-800 border border-slate-700 rounded px-3 py-1.5 text-sm text-slate-300 placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              data-testid="token-name-input"
            />
            <input
              type="date"
              value={expiresAt}
              onChange={(e) => setExpiresAt(e.target.value)}
              title="Optional expiry date (max 1 year)"
              className="bg-slate-800 border border-slate-700 rounded px-3 py-1.5 text-sm text-slate-300 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              data-testid="token-expiry-input"
            />
            <button
              type="submit"
              disabled={creating || !name.trim()}
              className="bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white text-sm px-3 py-1.5 rounded transition"
              data-testid="create-token-button"
            >
              {creating ? "Creating…" : "Generate token"}
            </button>
          </div>
          <p className="text-xs h-4">
            {createError
              ? <span className="text-red-400">{createError}</span>
              : <span className="text-slate-500">Leave expiry blank for a non-expiring token (max 1 year if set).</span>
            }
          </p>
        </form>
      )}
      {tokens.length >= PAT_MAX && (
        <p className="text-sm text-amber-400" data-testid="max-tokens-notice">
          You've reached the maximum of {PAT_MAX} tokens. Revoke one to create another.
        </p>
      )}

      {/* Token list */}
      {loading ? (
        <div className="flex items-center justify-center py-8">
          <div className="w-5 h-5 border-2 border-slate-600 border-t-blue-500 rounded-full animate-spin" />
        </div>
      ) : tokens.length === 0 ? (
        <p className="text-sm text-slate-500" data-testid="no-tokens-message">No access tokens yet.</p>
      ) : (
        <div className="flex flex-col gap-1" data-testid="token-list">
          <div className="grid grid-cols-[1fr_auto_auto_auto] gap-x-4 px-3 py-1.5 text-xs text-slate-500 uppercase tracking-wide border-b border-slate-700">
            <span>Name</span>
            <span>Created</span>
            <span>Expires</span>
            <span />
          </div>
          {tokens.map((token) => (
            <div
              key={token.id}
              className="grid grid-cols-[1fr_auto_auto_auto] gap-x-4 items-center px-3 py-2 rounded hover:bg-slate-800/50"
              data-testid={`token-row-${token.id}`}
            >
              <div className="flex flex-col gap-0.5 min-w-0">
                <span className="text-sm text-slate-200 truncate">{token.name}</span>
                <span className="font-mono text-xs text-slate-500">{token.prefix}…</span>
              </div>
              <span className="text-xs text-slate-400 whitespace-nowrap">{formatDate(token.created_at)}</span>
              <span className="text-xs text-slate-400 whitespace-nowrap">{formatDate(token.expires_at)}</span>
              <div className="flex items-center gap-2">
                {confirmRevokeId === token.id ? (
                  <>
                    <button
                      onClick={() => handleRevoke(token.id)}
                      disabled={revokingId === token.id}
                      className="text-xs text-red-400 hover:text-red-300 transition"
                      data-testid={`confirm-revoke-${token.id}`}
                    >
                      {revokingId === token.id ? "Revoking…" : "Confirm"}
                    </button>
                    <button
                      onClick={() => setConfirmRevokeId(null)}
                      className="text-xs text-slate-400 hover:text-white transition"
                    >
                      Cancel
                    </button>
                  </>
                ) : (
                  <button
                    onClick={() => setConfirmRevokeId(token.id)}
                    className="text-xs text-slate-400 hover:text-red-400 transition"
                    data-testid={`revoke-${token.id}`}
                  >
                    Revoke
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function NotificationsTab({ user, onUserUpdated }: { user: User; onUserUpdated: (u: User) => void }) {
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const prefs = {
    notif_card_assigned: user.notif_card_assigned ?? true,
    notif_mentioned: user.notif_mentioned ?? true,
    notif_due_soon: user.notif_due_soon ?? false,
    notif_card_moved: user.notif_card_moved ?? false,
    notif_comment_added: user.notif_comment_added ?? false,
  };

  const toggle = async (field: keyof typeof prefs) => {
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

  const rows: { key: keyof typeof prefs; label: string; description: string }[] = [
    { key: "notif_card_assigned", label: "Card assigned to me", description: "When someone assigns a card to you" },
    { key: "notif_mentioned", label: "Someone @mentions me", description: "When you are mentioned in a comment" },
    { key: "notif_due_soon", label: "Due date approaching", description: "24h warning before a card you own is due" },
    { key: "notif_card_moved", label: "Card I’m watching is moved", description: "When a watched card changes column" },
    { key: "notif_comment_added", label: "Comment on a watched card", description: "When someone comments on a card you’re watching" },
  ];

  return (
    <div className="flex flex-col gap-5 max-w-lg">
      <h2 className="text-white text-lg font-semibold">Notifications</h2>
      <p className="text-sm text-slate-400">Choose which events send you a notification.</p>
      <div className="flex flex-col gap-3">
        {rows.map(({ key, label, description }) => (
          <label key={key} className="flex items-center justify-between gap-4 cursor-pointer">
            <span>
              <span className="block text-sm text-white">{label}</span>
              <span className="block text-xs text-slate-500">{description}</span>
            </span>
            <button
              role="switch"
              aria-checked={prefs[key]}
              disabled={saving === key}
              onClick={() => toggle(key)}
              className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors shrink-0 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 ${
                prefs[key] ? "bg-blue-600" : "bg-slate-600"
              }`}
            >
              <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow transition-transform ${
                prefs[key] ? "translate-x-4" : "translate-x-1"
              }`} />
            </button>
          </label>
        ))}
      </div>
      {error && <p className="text-sm text-red-400">{error}</p>}
    </div>
  );
}

const THEME_OPTIONS: { value: ThemePreference; label: string; description: string }[] = [
  { value: "system", label: "System", description: "Follows your OS preference" },
  { value: "dark",   label: "Dark",   description: "Always use dark mode" },
];

function AppearanceTab() {
  const { preference, setPreference } = useTheme();

  return (
    <div className="flex flex-col gap-5 max-w-lg">
      <h2 className="text-white text-lg font-semibold">Appearance</h2>

      <div>
        <p className="text-sm text-slate-400 mb-3">Theme</p>
        <div className="flex flex-col gap-2">
          {THEME_OPTIONS.map(({ value, label, description }) => (
            <button
              key={value}
              onClick={() => setPreference(value)}
              className={`flex items-center gap-3 w-full text-left px-4 py-3 rounded-lg border transition ${
                preference === value
                  ? "border-blue-500 bg-blue-600/10 text-white"
                  : "border-slate-700 bg-slate-800 text-slate-300 hover:border-slate-500"
              }`}
            >
              <span className={`w-4 h-4 rounded-full border-2 flex items-center justify-center shrink-0 ${
                preference === value ? "border-blue-500" : "border-slate-500"
              }`}>
                {preference === value && (
                  <span className="w-2 h-2 rounded-full bg-blue-500" />
                )}
              </span>
              <span>
                <span className="block text-sm font-medium">{label}</span>
                <span className="block text-xs text-slate-500">{description}</span>
              </span>
            </button>
          ))}

        </div>
      </div>

    </div>
  );
}

function BehaviorTab({ user, onUserUpdated }: { user: User; onUserUpdated: (u: User) => void }) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  return (
    <div className="flex flex-col gap-5 max-w-lg">
      <h2 className="text-white text-lg font-semibold">Behavior</h2>

      <div>
        <p className="text-sm text-slate-400 mb-3">Card editor</p>
        <label className="flex items-center justify-between gap-4 cursor-pointer">
          <span>
            <span className="block text-sm text-white">Close editor on Enter</span>
            <span className="block text-xs text-slate-500">When on, pressing Enter in the inline card input submits the card and closes the editor. Enabled by default.</span>
          </span>
          <button
            role="switch"
            aria-checked={user.close_editor_on_enter ?? true}
            disabled={saving}
            onClick={toggleCloseOnEnter}
            className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors shrink-0 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 ${
              (user.close_editor_on_enter ?? true) ? "bg-blue-600" : "bg-slate-600"
            }`}
          >
            <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow transition-transform ${
              (user.close_editor_on_enter ?? true) ? "translate-x-4" : "translate-x-1"
            }`} />
          </button>
        </label>
        <p className="text-xs h-4 mt-1">{error && <span className="text-red-400">{error}</span>}</p>
      </div>
    </div>
  );
}

function AboutTab() {
  return (
    <div className="flex flex-col gap-5 max-w-lg">
      <h2 className="text-white text-lg font-semibold">About</h2>
      <div className="flex flex-col gap-3">
        <div className="flex flex-col gap-0.5">
          <span className="text-sm text-slate-400">Version</span>
          <span className="font-mono text-xs text-slate-500">{__APP_VERSION__}</span>
        </div>
        <div className="flex flex-col gap-0.5">
          <span className="text-sm text-slate-400">License</span>
          <span className="text-xs text-slate-500">Apache 2.0</span>
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
  const [activeTab, setActiveTab] = useState<Tab>("profile");

  useEscapeStack(() => {
    const tag = (document.activeElement as HTMLElement)?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return false;
    if (window.history.length > 1) { navigate(-1); return; }
    navigate(from ?? "/", { replace: true });
  }, 0);

  return (
    <div className="h-full bg-slate-900 flex flex-col">
      <Navbar user={user} onLogout={onLogout} onUserUpdated={onUserUpdated} />

      <main className="flex-1 overflow-y-auto p-8 max-w-4xl mx-auto w-full">
        <h1 className="text-white text-2xl font-bold mb-8">Settings</h1>

        <div className="flex gap-8">
          {/* Sidebar nav */}
          <nav className="w-44 shrink-0">
            <ul className="flex flex-col gap-0.5">
              {TABS.map((tab) => (
                <li key={tab.id}>
                  <button
                    onClick={() => setActiveTab(tab.id)}
                    className={`w-full text-left px-3 py-2 rounded-lg text-sm transition ${
                      activeTab === tab.id
                        ? "bg-blue-600 text-white font-medium"
                        : "text-slate-400 hover:text-white hover:bg-slate-800"
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
            {activeTab === "security" && <SecurityTab user={user} />}
            {activeTab === "access-tokens" && <AccessTokensTab />}
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
