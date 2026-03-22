import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  createAdminUser,
  getAdminSettings,
  getAdminUsers,
  patchAdminSettings,
  patchAdminUser,
} from "../api/auth";
import Avatar from "../components/Common/Avatar";
import Navbar from "../components/Layout/Navbar";
import type { AdminUser, RegistrationMode, SiteSettings } from "../types";
import type { User } from "../types";

type Tab = "settings" | "users";

interface Props {
  user: User;
  onLogout: () => void;
  onUserUpdated: (user: User) => void;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString("en-US", {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  } catch {
    return iso;
  }
}

// ---------------------------------------------------------------------------
// Confirm dialog
// ---------------------------------------------------------------------------

interface ConfirmDialogProps {
  message: string;
  onConfirm: () => void;
  onCancel: () => void;
}

function ConfirmDialog({ message, onConfirm, onCancel }: ConfirmDialogProps) {
  return (
    <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4">
      <div role="dialog" aria-modal="true" aria-labelledby="confirm-dialog-message" className="bg-slate-800 border border-slate-700 rounded-lg shadow-xl p-6 max-w-sm w-full">
        <p id="confirm-dialog-message" className="text-sm text-slate-300 mb-6">{message}</p>
        <div className="flex justify-end gap-3">
          <button
            onClick={onCancel}
            className="px-3 py-1.5 text-sm text-slate-300 hover:text-white hover:bg-slate-700 rounded transition focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            className="px-3 py-1.5 text-sm bg-red-600 hover:bg-red-700 text-white rounded transition focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            Confirm
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Add User modal
// ---------------------------------------------------------------------------

interface AddUserModalProps {
  onCreated: (user: AdminUser) => void;
  onClose: () => void;
}

function AddUserModal({ onCreated, onClose }: AddUserModalProps) {
  const [form, setForm] = useState({
    username: "",
    email: "",
    password: "",
    force_password_reset: true,
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const set =
    (field: keyof typeof form) =>
    (e: React.ChangeEvent<HTMLInputElement>) =>
      setForm((f) => ({ ...f, [field]: e.target.type === "checkbox" ? e.target.checked : e.target.value }));

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (form.password.length < 12) {
      setError("Password must be at least 12 characters.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const created = await createAdminUser(form);
      onCreated(created);
    } catch (err: unknown) {
      const data = (err as { response?: { data?: unknown } }).response?.data;
      if (data && typeof data === "object") {
        const msgs = Object.values(data as Record<string, string[]>)
          .flat()
          .join(" ");
        setError(msgs || "Failed to create user.");
      } else {
        setError("Failed to create user.");
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4">
      <div role="dialog" aria-modal="true" aria-labelledby="add-user-title" className="bg-slate-800 border border-slate-700 rounded-lg shadow-xl p-6 max-w-md w-full">
        <div className="flex items-center justify-between pb-4 mb-4 border-b border-slate-700">
          <h2 id="add-user-title" className="text-white text-lg font-semibold">Add User</h2>
          <button
            onClick={onClose}
            className="hover:bg-slate-700 p-1 rounded transition text-slate-400 hover:text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <label className="flex flex-col gap-1 text-sm text-slate-400">
            Username
            <input
              value={form.username}
              onChange={set("username")}
              required
              autoComplete="off"
              className="bg-slate-800 border border-slate-700 rounded px-3 py-1.5 text-sm text-slate-300 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent placeholder-slate-500"
            />
          </label>

          <label className="flex flex-col gap-1 text-sm text-slate-400">
            Email address
            <input
              type="email"
              value={form.email}
              onChange={set("email")}
              required
              autoComplete="off"
              className="bg-slate-800 border border-slate-700 rounded px-3 py-1.5 text-sm text-slate-300 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent placeholder-slate-500"
            />
          </label>

          <div className="flex flex-col gap-1">
            <label htmlFor="new-user-password" className="text-sm text-slate-400">
              Password
            </label>
            <input
              id="new-user-password"
              type="password"
              value={form.password}
              onChange={set("password")}
              required
              minLength={12}
              autoComplete="new-password"
              className="bg-slate-800 border border-slate-700 rounded px-3 py-1.5 text-sm text-slate-300 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent placeholder-slate-500"
            />
            <span className="text-xs text-slate-500">Minimum 12 characters</span>
          </div>

          <label className="flex items-center gap-3 cursor-pointer text-sm text-slate-300">
            <input
              type="checkbox"
              checked={form.force_password_reset}
              onChange={set("force_password_reset")}
              className="w-4 h-4 accent-blue-500"
            />
            Force password reset on first login
          </label>

          {error && <p className="text-sm text-red-400">{error}</p>}

          <div className="flex justify-end gap-3 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="px-3 py-1.5 text-sm text-slate-300 hover:text-white hover:bg-slate-700 rounded transition focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving}
              className="px-3 py-1.5 text-sm bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white rounded transition focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              {saving ? "Creating…" : "Create user"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Settings tab
// ---------------------------------------------------------------------------

const REGISTRATION_MODE_OPTIONS: { value: RegistrationMode; label: string; description: string }[] = [
  {
    value: "open",
    label: "Open",
    description: "Anyone can register a new account",
  },
  {
    value: "invite_only",
    label: "Invite-only",
    description: "Registration requires a valid invite link",
  },
  {
    value: "closed",
    label: "Closed",
    description: "Self-registration is disabled; admins create accounts manually",
  },
];

function SettingsTab() {
  const [settings, setSettings] = useState<SiteSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const savedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => { if (savedTimerRef.current) clearTimeout(savedTimerRef.current) };
  }, []);

  useEffect(() => {
    getAdminSettings()
      .then(setSettings)
      .catch(() => setError("Failed to load settings."))
      .finally(() => setLoading(false));
  }, []);

  const handleChange = async (mode: RegistrationMode) => {
    if (!settings || saving) return;
    const prev = settings.registration_mode;
    setSettings((s) => s ? { ...s, registration_mode: mode } : s);
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const updated = await patchAdminSettings({ registration_mode: mode });
      setSettings(updated);
      setSaved(true);
      if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
      savedTimerRef.current = setTimeout(() => setSaved(false), 3000);
    } catch {
      setSettings((s) => s ? { ...s, registration_mode: prev } : s);
      setError("Failed to save settings.");
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return <div className="text-slate-400 text-sm">Loading…</div>;
  }

  return (
    <div className="flex flex-col gap-6 max-w-lg">
      <h2 className="text-white text-lg font-semibold">Instance Settings</h2>

      <div>
        <p className="text-sm font-medium text-slate-400 uppercase tracking-wide mb-3">
          Registration
        </p>
        <div className="flex flex-col gap-2">
          {REGISTRATION_MODE_OPTIONS.map(({ value, label, description }) => (
            <button
              key={value}
              onClick={() => handleChange(value)}
              disabled={saving}
              className={`flex items-center gap-3 w-full text-left px-4 py-3 rounded-lg border transition disabled:opacity-50 ${
                settings?.registration_mode === value
                  ? "border-blue-500 bg-blue-600/10 text-white"
                  : "border-slate-700 bg-slate-800 text-slate-300 hover:border-slate-500"
              }`}
            >
              <span
                className={`w-4 h-4 rounded-full border-2 flex items-center justify-center shrink-0 ${
                  settings?.registration_mode === value
                    ? "border-blue-500"
                    : "border-slate-500"
                }`}
              >
                {settings?.registration_mode === value && (
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

      <p className="text-sm h-5">
        {error && <span className="text-red-400">{error}</span>}
        {saved && <span className="text-green-400">Settings saved.</span>}
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Users tab
// ---------------------------------------------------------------------------

interface ConfirmState {
  message: string;
  onConfirm: () => void;
}

function UsersTab({ currentUser }: { currentUser: User }) {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showAddModal, setShowAddModal] = useState(false);
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const fetchUsers = useCallback(
    async (searchVal: string, pageVal: number) => {
      setLoading(true);
      setError(null);
      try {
        const data = await getAdminUsers({ search: searchVal || undefined, page: pageVal });
        setUsers(data.results);
        setTotal(data.count);
      } catch {
        setError("Failed to load users.");
      } finally {
        setLoading(false);
      }
    },
    []
  );

  useEffect(() => {
    fetchUsers(search, page);
  }, [page]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleSearchChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    setSearch(val);
    setPage(1);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => fetchUsers(val, 1), 400);
  };

  const applyPatch = async (
    userId: number,
    patch: Partial<Pick<AdminUser, "is_active" | "is_site_admin" | "must_change_password">>
  ) => {
    setActionError(null);
    try {
      const updated = await patchAdminUser(userId, patch);
      setUsers((prev) => prev.map((u) => (u.id === userId ? updated : u)));
    } catch (err: unknown) {
      const data = (err as { response?: { data?: { detail?: string } } }).response?.data;
      setActionError(data?.detail ?? "Action failed. Please try again.");
    }
  };

  const confirmAndRun = (message: string, fn: () => Promise<void>) => {
    setConfirm({
      message,
      onConfirm: async () => {
        setConfirm(null);
        await fn();
      },
    });
  };

  const handleDeactivate = (user: AdminUser) => {
    confirmAndRun(
      `Deactivate ${user.display_name || user.username}? They will no longer be able to log in.`,
      () => applyPatch(user.id, { is_active: false })
    );
  };

  const handleDemote = (user: AdminUser) => {
    confirmAndRun(
      `Remove site admin role from ${user.display_name || user.username}?`,
      () => applyPatch(user.id, { is_site_admin: false })
    );
  };

  const PAGE_SIZE = 50;
  const totalPages = Math.ceil(total / PAGE_SIZE);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-4">
        <h2 className="text-white text-lg font-semibold">Users</h2>
        <button
          onClick={() => setShowAddModal(true)}
          className="px-3 py-1.5 text-sm bg-blue-600 hover:bg-blue-700 text-white rounded transition focus:outline-none focus:ring-2 focus:ring-blue-500"
        >
          + Add User
        </button>
      </div>

      <input
        type="search"
        value={search}
        onChange={handleSearchChange}
        placeholder="Search by name, email, or username…"
        className="bg-slate-800 border border-slate-700 rounded px-3 py-1.5 text-sm text-slate-300 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent placeholder-slate-500 max-w-md"
      />

      {actionError && (
        <p className="text-sm text-red-400">{actionError}</p>
      )}

      {loading ? (
        <div className="text-slate-400 text-sm">Loading…</div>
      ) : error ? (
        <div className="text-red-400 text-sm">{error}</div>
      ) : (
        <>
          <div className="overflow-x-auto rounded-lg border border-slate-700">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-slate-800 text-slate-400 text-xs uppercase tracking-wide">
                  <th className="text-left px-4 py-2.5 font-medium">User</th>
                  <th className="text-left px-4 py-2.5 font-medium">Email</th>
                  <th className="text-left px-4 py-2.5 font-medium">Joined</th>
                  <th className="text-left px-4 py-2.5 font-medium">Status</th>
                  <th className="text-left px-4 py-2.5 font-medium">Actions</th>
                </tr>
              </thead>
              <tbody>
                {users.map((u) => (
                  <tr
                    key={u.id}
                    className="border-t border-slate-800 hover:bg-slate-800/50 transition"
                  >
                    <td className="px-4 py-2.5">
                      <div className="flex items-center gap-2">
                        <Avatar user={u} size="sm" />
                        <div>
                          <div className="flex items-center gap-1.5">
                            <span className="text-slate-200">
                              {u.display_name || u.first_name || u.username}
                            </span>
                            {u.is_site_admin && (
                              <span className="px-1.5 py-0.5 text-xs rounded-full bg-blue-500/20 text-blue-400">
                                Admin
                              </span>
                            )}
                            {u.must_change_password && (
                              <span className="px-1.5 py-0.5 text-xs rounded-full bg-amber-500/20 text-amber-400">
                                Reset req.
                              </span>
                            )}
                          </div>
                          <span className="text-xs text-slate-500">@{u.username}</span>
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-2.5 text-slate-300">{u.email}</td>
                    <td className="px-4 py-2.5 text-slate-500">{formatDate(u.date_joined)}</td>
                    <td className="px-4 py-2.5">
                      {u.is_active ? (
                        <span className="text-green-400 text-xs">Active</span>
                      ) : (
                        <span className="text-slate-500 text-xs">Inactive</span>
                      )}
                    </td>
                    <td className="px-4 py-2.5">
                      <div className="flex items-center gap-2">
                        {/* Deactivate / Reactivate */}
                        {u.id !== currentUser.id && (
                          u.is_active ? (
                            <button
                              onClick={() => handleDeactivate(u)}
                              className="text-xs text-slate-400 hover:text-red-400 transition"
                            >
                              Deactivate
                            </button>
                          ) : (
                            <button
                              onClick={() => applyPatch(u.id, { is_active: true })}
                              className="text-xs text-slate-400 hover:text-green-400 transition"
                            >
                              Reactivate
                            </button>
                          )
                        )}

                        {/* Promote / Demote site admin */}
                        {u.id !== currentUser.id && (
                          u.is_site_admin ? (
                            <button
                              onClick={() => handleDemote(u)}
                              className="text-xs text-slate-400 hover:text-amber-400 transition"
                            >
                              Demote admin
                            </button>
                          ) : (
                            <button
                              onClick={() => confirmAndRun(
                                `Grant site admin to ${u.display_name || u.username}? They will have full access to this admin panel.`,
                                () => applyPatch(u.id, { is_site_admin: true })
                              )}
                              className="text-xs text-slate-400 hover:text-blue-400 transition"
                            >
                              Make admin
                            </button>
                          )
                        )}

                        {/* Force password reset */}
                        {!u.must_change_password && (
                          <button
                            onClick={() => applyPatch(u.id, { must_change_password: true })}
                            className="text-xs text-slate-400 hover:text-amber-400 transition"
                          >
                            Force reset
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
                {users.length === 0 && (
                  <tr>
                    <td colSpan={5} className="px-4 py-8 text-center text-slate-500">
                      No users found.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          <div className="flex items-center justify-between text-sm text-slate-400">
            <span>{total} {total === 1 ? "user" : "users"}</span>
            {totalPages > 1 && (
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  disabled={page === 1}
                  className="px-2 py-1 text-xs text-slate-400 hover:text-white hover:bg-slate-700 rounded disabled:opacity-50 transition"
                >
                  ← Prev
                </button>
                <span className="text-xs">
                  Page {page} of {totalPages}
                </span>
                <button
                  onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                  disabled={page === totalPages}
                  className="px-2 py-1 text-xs text-slate-400 hover:text-white hover:bg-slate-700 rounded disabled:opacity-50 transition"
                >
                  Next →
                </button>
              </div>
            )}
          </div>
        </>
      )}

      {showAddModal && (
        <AddUserModal
          onCreated={(newUser) => {
            setUsers((prev) => [newUser, ...prev]);
            setTotal((t) => t + 1);
            setShowAddModal(false);
          }}
          onClose={() => setShowAddModal(false)}
        />
      )}

      {confirm && (
        <ConfirmDialog
          message={confirm.message}
          onConfirm={confirm.onConfirm}
          onCancel={() => setConfirm(null)}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// AdminPage
// ---------------------------------------------------------------------------

const TABS: { id: Tab; label: string }[] = [
  { id: "settings", label: "Settings" },
  { id: "users", label: "Users" },
];

export default function AdminPage({ user, onLogout, onUserUpdated }: Props) {
  const navigate = useNavigate();
  const [activeTab, setActiveTab] = useState<Tab>("settings");

  // Redirect non-admins immediately.
  useEffect(() => {
    if (!user.is_site_admin) {
      navigate("/", { replace: true });
    }
  }, [user.is_site_admin, navigate]);

  if (!user.is_site_admin) return null;

  return (
    <div className="h-full bg-slate-900 flex flex-col">
      <Navbar user={user} onLogout={onLogout} onUserUpdated={onUserUpdated} />

      <main className="flex-1 overflow-y-auto p-8 max-w-5xl mx-auto w-full">
        <h1 className="text-white text-2xl font-bold mb-8">Site Administration</h1>

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
            {activeTab === "settings" && <SettingsTab />}
            {activeTab === "users" && <UsersTab currentUser={user} />}
          </div>
        </div>
      </main>
    </div>
  );
}
