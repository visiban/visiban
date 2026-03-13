import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { updateCurrentUser, changePassword } from "../api/auth";
import Navbar from "../components/Layout/Navbar";
import type { User } from "../types";
import { useTheme } from "../context/ThemeContext";
import type { ThemePreference } from "../context/ThemeContext";
import { TIMEZONE_OPTIONS, browserTimezone } from "../utils/date";
import SelectDropdown from "../components/Common/SelectDropdown";

type Tab = "profile" | "security" | "notifications" | "appearance";

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

function ProfileTab({ user, onUserUpdated }: { user: User; onUserUpdated: (u: User) => void }) {
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
      setTimeout(() => navigate("/"), 1500);
    } catch {
      setError("Failed to save changes. Please try again.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-5 max-w-lg">
      <h2 className="text-white text-lg font-semibold">Profile</h2>

      <label className="flex flex-col gap-1 text-sm text-gray-400">
        Display name
        <input
          value={form.display_name}
          onChange={set("display_name")}
          placeholder="How you appear on the board"
          className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white outline-none focus:border-blue-500 transition"
        />
      </label>

      <div className="flex gap-3">
        <label className="flex flex-col gap-1 flex-1 text-sm text-gray-400">
          First name
          <input
            value={form.first_name}
            onChange={set("first_name")}
            className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white outline-none focus:border-blue-500 transition"
          />
        </label>
        <label className="flex flex-col gap-1 flex-1 text-sm text-gray-400">
          Last name
          <input
            value={form.last_name}
            onChange={set("last_name")}
            className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white outline-none focus:border-blue-500 transition"
          />
        </label>
      </div>

      <label className="flex flex-col gap-1 text-sm text-gray-400">
        Username
        <input
          value={form.username}
          onChange={set("username")}
          required
          className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white outline-none focus:border-blue-500 transition"
        />
      </label>

      <label className="flex flex-col gap-1 text-sm text-gray-400">
        Email address
        <input
          type="email"
          value={form.email}
          onChange={set("email")}
          required
          className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white outline-none focus:border-blue-500 transition"
        />
      </label>

      <div className="flex flex-col gap-1 text-sm text-gray-400">
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
        <span className="text-xs text-gray-500">Used for due date labels and filters</span>
      </div>

      <div className="border-t border-gray-700 pt-4">
        <p className="text-sm text-gray-300 font-medium mb-4">Locale</p>
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1 text-sm text-gray-400">
            Date format
            <SelectDropdown
              value={form.date_format}
              onChange={(v) => setForm((f) => ({ ...f, date_format: v }))}
              options={DATE_FORMAT_OPTIONS}
              className="w-full"
            />
          </div>
          <div className="flex flex-col gap-1 text-sm text-gray-400">
            Time format
            <SelectDropdown
              value={form.time_format}
              onChange={(v) => setForm((f) => ({ ...f, time_format: v }))}
              options={TIME_FORMAT_OPTIONS}
              className="w-full"
            />
          </div>
          <div className="flex flex-col gap-1 text-sm text-gray-400">
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

      {error && <p className="text-sm text-red-400">{error}</p>}
      {saved && <p className="text-sm text-green-400">Changes saved.</p>}

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
        <p className="text-sm text-gray-400">
          You signed in with a social account. Set a password below to also enable
          username/password login.
        </p>
      )}

      {hasPw && (
        <label className="flex flex-col gap-1 text-sm text-gray-400">
          Current password
          <input
            type="password"
            value={form.current_password}
            onChange={set("current_password")}
            required
            autoComplete="current-password"
            className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white outline-none focus:border-blue-500 transition"
          />
        </label>
      )}

      <label className="flex flex-col gap-1 text-sm text-gray-400">
        New password
        <input
          type="password"
          value={form.new_password}
          onChange={set("new_password")}
          required
          autoComplete="new-password"
          minLength={12}
          className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white outline-none focus:border-blue-500 transition"
        />
      </label>

      <label className="flex flex-col gap-1 text-sm text-gray-400">
        Confirm new password
        <input
          type="password"
          value={form.confirm}
          onChange={set("confirm")}
          required
          autoComplete="new-password"
          className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white outline-none focus:border-blue-500 transition"
        />
      </label>

      {error && <p className="text-sm text-red-400">{error}</p>}
      {saved && (
        <p className="text-sm text-green-400">
          {hasPw ? "Password changed successfully." : "Password set successfully."}
        </p>
      )}

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
      <p className="text-sm text-gray-400">Choose which events send you a notification.</p>
      <div className="flex flex-col gap-3">
        {rows.map(({ key, label, description }) => (
          <label key={key} className="flex items-center justify-between gap-4 cursor-pointer">
            <span>
              <span className="block text-sm text-white">{label}</span>
              <span className="block text-xs text-gray-500">{description}</span>
            </span>
            <button
              role="switch"
              aria-checked={prefs[key]}
              disabled={saving === key}
              onClick={() => toggle(key)}
              className={`relative w-10 h-6 rounded-full transition shrink-0 ${
                prefs[key] ? "bg-blue-600" : "bg-gray-700"
              } disabled:opacity-50`}
            >
              <span className={`absolute top-1 w-4 h-4 bg-white rounded-full shadow transition-all ${
                prefs[key] ? "left-5" : "left-1"
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
        <p className="text-sm text-gray-400 mb-3">Theme</p>
        <div className="flex flex-col gap-2">
          {THEME_OPTIONS.map(({ value, label, description }) => (
            <button
              key={value}
              onClick={() => setPreference(value)}
              className={`flex items-center gap-3 w-full text-left px-4 py-3 rounded-lg border transition ${
                preference === value
                  ? "border-blue-500 bg-blue-600/10 text-white"
                  : "border-gray-700 bg-gray-800 text-gray-300 hover:border-gray-500"
              }`}
            >
              <span className={`w-4 h-4 rounded-full border-2 flex items-center justify-center shrink-0 ${
                preference === value ? "border-blue-500" : "border-gray-500"
              }`}>
                {preference === value && (
                  <span className="w-2 h-2 rounded-full bg-blue-500" />
                )}
              </span>
              <span>
                <span className="block text-sm font-medium">{label}</span>
                <span className="block text-xs text-gray-500">{description}</span>
              </span>
            </button>
          ))}

          {/* Light mode placeholder — shown once light-mode styles are implemented */}
          <div className="flex items-center gap-3 w-full text-left px-4 py-3 rounded-lg border border-gray-700 bg-gray-800/50 opacity-50 cursor-not-allowed">
            <span className="w-4 h-4 rounded-full border-2 border-gray-600 shrink-0" />
            <span>
              <span className="block text-sm font-medium text-gray-400">Light</span>
              <span className="block text-xs text-gray-600">Coming soon</span>
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

const TABS: { id: Tab; label: string }[] = [
  { id: "profile", label: "Profile" },
  { id: "security", label: "Security" },
  { id: "notifications", label: "Notifications" },
  { id: "appearance", label: "Appearance" },
];

export default function SettingsPage({ user, onLogout, onUserUpdated }: Props) {
  const [activeTab, setActiveTab] = useState<Tab>("profile");
  const navigate = useNavigate();

  return (
    <div className="h-full bg-gray-900 flex flex-col">
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
                        : "text-gray-400 hover:text-white hover:bg-gray-800"
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
            {activeTab === "profile" && <ProfileTab user={user} onUserUpdated={onUserUpdated} />}
            {activeTab === "security" && <SecurityTab user={user} />}
            {activeTab === "notifications" && <NotificationsTab user={user} onUserUpdated={onUserUpdated} />}
            {activeTab === "appearance" && <AppearanceTab />}
          </div>
        </div>
      </main>
    </div>
  );
}
