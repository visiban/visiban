import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { updateCurrentUser, changePassword } from "../api/auth";
import Navbar from "../components/Layout/Navbar";
import type { User } from "../types";
import { useTheme } from "../context/ThemeContext";
import type { ThemePreference } from "../context/ThemeContext";

type Tab = "profile" | "security" | "notifications" | "appearance";

interface Props {
  user: User;
  onLogout: () => void;
  onUserUpdated: (user: User) => void;
}

function ProfileTab({ user, onUserUpdated }: { user: User; onUserUpdated: (u: User) => void }) {
  const [form, setForm] = useState({
    display_name: user.display_name ?? "",
    first_name: user.first_name ?? "",
    last_name: user.last_name ?? "",
    email: user.email ?? "",
    username: user.username ?? "",
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
      const updated = await updateCurrentUser(form);
      onUserUpdated(updated);
      setSaved(true);
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

function ComingSoonTab({ title }: { title: string }) {
  return (
    <div className="max-w-lg">
      <h2 className="text-white text-lg font-semibold mb-2">{title}</h2>
      <p className="text-gray-500 text-sm">This section is coming soon.</p>
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
    <div className="min-h-screen bg-gray-900 flex flex-col">
      <Navbar user={user} onLogout={onLogout} onUserUpdated={onUserUpdated} />

      <div className="flex items-center gap-2 px-4 py-2 bg-gray-800 border-b border-gray-700">
        <button onClick={() => navigate("/")} className="text-gray-400 hover:text-white text-sm transition">
          ← Dashboard
        </button>
      </div>

      <main className="flex-1 p-8 max-w-4xl mx-auto w-full">
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
            {activeTab === "notifications" && <ComingSoonTab title="Notifications" />}
            {activeTab === "appearance" && <AppearanceTab />}
          </div>
        </div>
      </main>
    </div>
  );
}
