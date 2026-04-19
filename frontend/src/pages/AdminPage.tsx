import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useEscapeStack } from "../hooks/useEscapeStack";
import {
  createAdminUser,
  deactivateAdminUser,
  getAdminInviteLinks,
  getAdminSettings,
  getAdminUsers,
  createAdminInviteLink,
  patchAdminSettings,
  patchAdminUser,
  revokeAdminInviteLink,
} from "../api/auth";
import Avatar from "../components/Common/Avatar";
import Navbar from "../components/Layout/Navbar";
import ModalWrapper from "../components/shared/ModalWrapper";
import type { AdminInviteLink, AdminUser, CreatedAdminInviteLink, RegistrationMode, SiteSettings } from "../types";
import type { User } from "../types";

type Tab = "settings" | "users" | "invite_links";

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
  useEscapeStack(onCancel, 40);
  const modalRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = modalRef.current;
    if (!el) return;
    const focusable = Array.from(
      el.querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
      )
    ).filter(el => !el.hasAttribute('disabled'));
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    first?.focus();
    const trap = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;
      if (e.shiftKey) {
        if (document.activeElement === first) { e.preventDefault(); last?.focus(); }
      } else {
        if (document.activeElement === last) { e.preventDefault(); first?.focus(); }
      }
    };
    el.addEventListener('keydown', trap);
    return () => el.removeEventListener('keydown', trap);
  }, []);
  return (
    <div className="fixed inset-0 bg-backdrop/60 z-50 flex items-center justify-center p-4">
      <div ref={modalRef} role="dialog" aria-modal="true" aria-labelledby="confirm-dialog-message" className="bg-surface border border-line rounded-lg shadow-xl p-6 max-w-sm w-full">
        <p id="confirm-dialog-message" className="text-sm text-fg-secondary mb-6">{message}</p>
        <div className="flex justify-end gap-3">
          <button
            onClick={onCancel}
            className="px-3 py-1.5 text-sm text-fg-secondary hover:text-fg hover:bg-surface-hover rounded transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            className="px-3 py-1.5 text-sm bg-danger-bg hover:bg-danger-bg-hover text-on-danger rounded transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
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
    <ModalWrapper open onClose={onClose} title="Add User" maxWidth="max-w-md">
      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <label className="flex flex-col gap-1 text-sm text-fg-tertiary">
            Username
            <input
              value={form.username}
              onChange={set("username")}
              required
              autoComplete="off"
              className="bg-surface border border-line rounded px-3 py-1.5 text-sm text-fg-secondary focus:outline-none focus:ring-2 focus:ring-primary-emphasis focus:border-transparent placeholder-fg-muted"
            />
          </label>

          <label className="flex flex-col gap-1 text-sm text-fg-tertiary">
            Email address
            <input
              type="email"
              value={form.email}
              onChange={set("email")}
              required
              autoComplete="off"
              className="bg-surface border border-line rounded px-3 py-1.5 text-sm text-fg-secondary focus:outline-none focus:ring-2 focus:ring-primary-emphasis focus:border-transparent placeholder-fg-muted"
            />
          </label>

          <div className="flex flex-col gap-1">
            <label htmlFor="new-user-password" className="text-sm text-fg-tertiary">
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
              className="bg-surface border border-line rounded px-3 py-1.5 text-sm text-fg-secondary focus:outline-none focus:ring-2 focus:ring-primary-emphasis focus:border-transparent placeholder-fg-muted"
            />
            <span className="text-xs text-fg-muted">Minimum 12 characters</span>
          </div>

          <label className="flex items-center gap-3 cursor-pointer text-sm text-fg-secondary">
            <input
              type="checkbox"
              checked={form.force_password_reset}
              onChange={set("force_password_reset")}
              className="w-4 h-4 accent-blue-500"
            />
            Force password reset on first login
          </label>

          {error && <p className="text-sm text-danger">{error}</p>}

          <div className="flex justify-end gap-3 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="px-3 py-1.5 text-sm text-fg-secondary hover:text-fg hover:bg-surface-hover rounded transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving}
              className="px-3 py-1.5 text-sm bg-primary hover:bg-primary-hover disabled:opacity-40 text-on-primary rounded transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
            >
              {saving ? "Creating…" : "Create user"}
            </button>
          </div>
      </form>
    </ModalWrapper>
  );
}

// ---------------------------------------------------------------------------
// Invite links tab
// ---------------------------------------------------------------------------

const TTL_OPTIONS: { label: string; value: number | null }[] = [
  { label: "1 day", value: 1 },
  { label: "7 days", value: 7 },
  { label: "30 days", value: 30 },
  { label: "Never", value: null },
];

const STATUS_STYLES: Record<AdminInviteLink["status"], string> = {
  pending: "bg-success/20 text-success",
  used: "bg-fg-muted/20 text-fg-tertiary",
  expired: "bg-danger/20 text-danger",
  revoked: "bg-fg-muted/20 text-fg-muted",
};

function formatExpiry(link: AdminInviteLink): string {
  if (!link.expires_at) return "Never";
  return new Date(link.expires_at).toLocaleDateString("en-US", {
    month: "short", day: "numeric", year: "numeric",
  });
}

function InviteLinksTab() {
  const [links, setLinks] = useState<AdminInviteLink[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [form, setForm] = useState<{ expires_in_days: number | null; single_use: boolean }>({
    expires_in_days: 7,
    single_use: false,
  });
  const [newLink, setNewLink] = useState<CreatedAdminInviteLink | null>(null);
  const [copied, setCopied] = useState(false);
  const [revokeConfirm, setRevokeConfirm] = useState<number | null>(null);
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => { if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current); };
  }, []);

  useEffect(() => {
    getAdminInviteLinks()
      .then(setLinks)
      .catch(() => setError("Failed to load invite links."))
      .finally(() => setLoading(false));
  }, []);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    setCreating(true);
    setCreateError(null);
    setNewLink(null);
    try {
      const created = await createAdminInviteLink(form);
      setNewLink(created);
      setLinks((prev) => [created, ...prev]);
    } catch (err: unknown) {
      const data = (err as { response?: { data?: unknown } }).response?.data;
      if (data && typeof data === "object") {
        const msgs = Object.values(data as Record<string, string[]>).flat().join(" ");
        setCreateError(msgs || "Failed to create invite link.");
      } else {
        setCreateError("Failed to create invite link.");
      }
    } finally {
      setCreating(false);
    }
  };

  const handleCopy = () => {
    if (!newLink) return;
    navigator.clipboard.writeText(`${window.location.origin}/join/${newLink.raw_token}`).then(() => {
      setCopied(true);
      if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
      copiedTimerRef.current = setTimeout(() => setCopied(false), 2000);
    });
  };

  const handleRevoke = async (id: number) => {
    try {
      const updated = await revokeAdminInviteLink(id);
      setLinks((prev) => prev.map((l) => (l.id === id ? updated : l)));
    } catch {
      setError("Failed to revoke invite link.");
    } finally {
      setRevokeConfirm(null);
    }
  };

  if (loading) return <div className="text-fg-tertiary text-sm">Loading…</div>;

  return (
    <div className="flex flex-col gap-6">
      <h2 className="text-fg text-lg font-semibold">Invite Links</h2>

      {/* Create form */}
      <form onSubmit={handleCreate} className="flex flex-col gap-4 max-w-sm">
        <div className="flex flex-col gap-1">
          <label className="text-sm font-medium text-fg-tertiary uppercase tracking-wide">Expires after</label>
          <select
            value={form.expires_in_days ?? ""}
            onChange={(e) => setForm((f) => ({ ...f, expires_in_days: e.target.value === "" ? null : Number(e.target.value) }))}
            className="bg-surface border border-line rounded px-3 py-1.5 text-sm text-fg-secondary focus:outline-none focus:ring-2 focus:ring-primary-emphasis focus:border-transparent"
          >
            {TTL_OPTIONS.map((o) => (
              <option key={String(o.value)} value={o.value ?? ""}>{o.label}</option>
            ))}
          </select>
          {form.expires_in_days === null && (
            <p className="text-xs text-warning">Never-expiring links are a security risk — use with caution.</p>
          )}
        </div>

        <label className="flex items-center gap-3 cursor-pointer text-sm text-fg-secondary">
          <button
            type="button"
            role="switch"
            aria-checked={form.single_use}
            onClick={() => setForm((f) => ({ ...f, single_use: !f.single_use }))}
            className={`relative inline-flex h-5 w-9 items-center rounded-full transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis ${form.single_use ? "bg-primary" : "bg-surface-active"}`}
          >
            <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition ${form.single_use ? "translate-x-4" : "translate-x-1"}`} />
          </button>
          Single-use
        </label>

        {createError && <p className="text-sm text-danger">{createError}</p>}

        <button
          type="submit"
          disabled={creating}
          className="self-start px-3 py-1.5 text-sm bg-primary hover:bg-primary-hover disabled:opacity-40 text-on-primary rounded transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
        >
          {creating ? "Creating…" : "Create link"}
        </button>
      </form>

      {/* One-time token reveal */}
      {newLink && (
        <div className="flex flex-col gap-2 p-3 rounded-lg border border-warning/50 bg-sunken max-w-lg transition-all duration-150">
          <p className="text-xs text-warning">Copy this link now — it won't be shown again.</p>
          <div className="flex items-center gap-2">
            <span
              title={`${window.location.origin}/join/${newLink.raw_token}`}
              className="flex-1 font-mono text-xs text-fg bg-surface border border-line rounded px-2 py-1.5 truncate"
            >
              {`${window.location.origin}/join/${newLink.raw_token}`}
            </span>
            <button
              onClick={handleCopy}
              className="shrink-0 px-3 py-1.5 text-sm bg-primary hover:bg-primary-hover text-on-primary rounded transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
            >
              {copied ? "Copied!" : "Copy"}
            </button>
            <button
              onClick={() => setNewLink(null)}
              className="shrink-0 px-3 py-1.5 text-sm text-fg-tertiary hover:text-fg hover:bg-surface-hover rounded transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
            >
              Done
            </button>
          </div>
        </div>
      )}

      {error && <p className="text-sm text-danger">{error}</p>}

      {/* Link list */}
      {links.length === 0 ? (
        <p className="text-sm text-fg-muted">No invite links yet.</p>
      ) : (
        <div className="flex flex-col divide-y divide-line rounded-lg border border-line overflow-hidden">
          {links.map((link) => (
            <div key={link.id} className="flex items-center gap-3 px-4 py-3 bg-surface/50 hover:bg-surface transition">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-mono text-xs text-fg-tertiary">{link.prefix}…</span>
                  <span className={`px-2 py-0.5 text-xs rounded-full ${STATUS_STYLES[link.status]}`}>
                    {link.status}
                  </span>
                  {link.single_use && (
                    <span className="px-2 py-0.5 text-xs rounded-full bg-fg-muted/20 text-fg-tertiary">single-use</span>
                  )}
                </div>
                <p className="text-xs text-fg-muted mt-0.5">
                  Expires {formatExpiry(link)}
                  {` · ${link.use_count} ${link.use_count === 1 ? "use" : "uses"}`}
                  {link.created_by_username && ` · created by ${link.created_by_username}`}
                </p>
              </div>
              {link.status === "pending" && (
                revokeConfirm === link.id ? (
                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      onClick={() => handleRevoke(link.id)}
                      className="text-xs text-danger hover:text-danger transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
                    >
                      Confirm revoke
                    </button>
                    <button
                      onClick={() => setRevokeConfirm(null)}
                      className="text-xs text-fg-tertiary hover:text-fg transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
                    >
                      Cancel
                    </button>
                  </div>
                ) : (
                  <button
                    onClick={() => setRevokeConfirm(link.id)}
                    className="shrink-0 text-xs text-danger hover:text-danger transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
                  >
                    Revoke
                  </button>
                )
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Offboarding modal
// ---------------------------------------------------------------------------

interface OffboardingModalProps {
  user: AdminUser;
  onDeactivated: (updated: AdminUser) => void;
  onClose: () => void;
}

function OffboardingModal({ user, onDeactivated, onClose }: OffboardingModalProps) {
  const contentRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = contentRef.current;
    if (!el) return;
    const focusable = Array.from(
      el.querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
      )
    ).filter(el => !el.hasAttribute('disabled'));
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    first?.focus();
    const trap = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;
      if (e.shiftKey) {
        if (document.activeElement === first) { e.preventDefault(); last?.focus(); }
      } else {
        if (document.activeElement === last) { e.preventDefault(); first?.focus(); }
      }
    };
    el.addEventListener('keydown', trap);
    return () => el.removeEventListener('keydown', trap);
  }, []);
  // Per-board transfer map: board id → selected user id
  const [transfers, setTransfers] = useState<Record<number, number | null>>(
    () => Object.fromEntries(user.owned_boards.map((b) => [b.id, null]))
  );
  const [memberSearch, setMemberSearch] = useState<Record<number, string>>({});
  const [memberResults, setMemberResults] = useState<Record<number, User[]>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const debounceRefs = useRef<Record<number, ReturnType<typeof setTimeout>>>({});

  const handleMemberSearch = (boardId: number, query: string) => {
    setMemberSearch((prev) => ({ ...prev, [boardId]: query }));
    setTransfers((prev) => ({ ...prev, [boardId]: null }));
    if (debounceRefs.current[boardId]) clearTimeout(debounceRefs.current[boardId]);
    if (query.length < 2) {
      setMemberResults((prev) => ({ ...prev, [boardId]: [] }));
      return;
    }
    debounceRefs.current[boardId] = setTimeout(async () => {
      try {
        const { default: client } = await import("../api/client");
        const res = await client.get<User[]>(`/api/users/?search=${encodeURIComponent(query)}&board_id=${boardId}`);
        setMemberResults((prev) => ({ ...prev, [boardId]: res.data }));
      } catch {
        // silently ignore search errors
      }
    }, 300);
  };

  const selectTransfer = (boardId: number, member: User) => {
    setTransfers((prev) => ({ ...prev, [boardId]: member.id }));
    setMemberSearch((prev) => ({ ...prev, [boardId]: member.display_name || member.username }));
    setMemberResults((prev) => ({ ...prev, [boardId]: [] }));
  };

  const allAssigned = user.owned_boards.every((b) => transfers[b.id] !== null);

  const handleConfirm = async () => {
    setSaving(true);
    setError(null);
    try {
      const transferList = user.owned_boards.map((b) => ({
        board_id: b.id,
        transfer_to: transfers[b.id] as number,
      }));
      const updated = await deactivateAdminUser(user.id, transferList);
      onDeactivated(updated);
    } catch (err: unknown) {
      const data = (err as { response?: { data?: { detail?: string } } }).response?.data;
      setError(data?.detail ?? "Deactivation failed. Please try again.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <ModalWrapper open onClose={onClose} title="Transfer boards & deactivate" maxWidth="max-w-lg" headerBorder>
      <div ref={contentRef}>
        <p className="text-sm text-fg-secondary mb-4">
          <span className="font-medium text-fg">{user.display_name || user.username}</span> owns the boards below.
          Assign a new owner for each before deactivating.
        </p>

        <div className="flex flex-col divide-y divide-line mb-4 rounded-lg border border-line overflow-hidden">
          {user.owned_boards.map((board) => (
            <div key={board.id} className="flex flex-col gap-2 px-4 py-3 bg-surface/50">
              <span className="text-sm text-fg truncate" title={board.name}>{board.name}</span>
              <div className="relative">
                <input
                  type="text"
                  placeholder="Search for a member…"
                  value={memberSearch[board.id] ?? ""}
                  onChange={(e) => handleMemberSearch(board.id, e.target.value)}
                  className="w-full bg-surface border border-line rounded px-3 py-1.5 text-sm text-fg-secondary focus:outline-none focus:ring-2 focus:ring-primary-emphasis focus:border-transparent placeholder-fg-muted"
                />
                {(memberResults[board.id] ?? []).length > 0 && (
                  <ul className="absolute z-10 w-full mt-1 bg-surface border border-line rounded shadow-lg max-h-40 overflow-y-auto">
                    {memberResults[board.id].map((member) => (
                      <li key={member.id}>
                        <button
                          type="button"
                          onClick={() => selectTransfer(board.id, member)}
                          className="w-full text-left px-3 py-2 text-sm text-fg-secondary hover:bg-surface-hover transition focus:outline-none focus:bg-surface-hover"
                        >
                          {member.display_name || member.username}
                          <span className="text-fg-muted ml-1">@{member.username}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              <p className="text-xs text-fg-muted">Only users who are members of this board can receive ownership.</p>
            </div>
          ))}
        </div>

        <p className="text-sm text-warning mb-4">
          This transfer cannot be undone automatically. The new owner will have full admin access to their transferred boards.
        </p>

        {error && <p className="text-sm text-danger mb-3">{error}</p>}

        <div className="flex justify-end gap-3">
          <button
            onClick={onClose}
            className="px-3 py-1.5 text-sm text-fg-secondary hover:text-fg hover:bg-surface-hover rounded transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
          >
            Cancel
          </button>
          <button
            onClick={handleConfirm}
            disabled={saving || !allAssigned}
            className="px-3 py-1.5 text-sm bg-danger-bg hover:bg-danger-bg-hover disabled:opacity-40 text-on-danger rounded transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
          >
            {saving ? "Processing…" : "Transfer ownership and deactivate"}
          </button>
        </div>
      </div>
    </ModalWrapper>
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

  const handleUploadsToggle = async () => {
    if (!settings || saving) return;
    const prev = settings.uploads_enabled;
    const next = !prev;
    setSettings((s) => s ? { ...s, uploads_enabled: next } : s);
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const updated = await patchAdminSettings({ uploads_enabled: next });
      setSettings(updated);
      setSaved(true);
      if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
      savedTimerRef.current = setTimeout(() => setSaved(false), 3000);
    } catch {
      setSettings((s) => s ? { ...s, uploads_enabled: prev } : s);
      setError("Failed to save settings.");
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return <div className="text-fg-tertiary text-sm">Loading…</div>;
  }

  return (
    <div className="flex flex-col gap-6 max-w-lg">
      <h2 className="text-fg text-lg font-semibold">Instance Settings</h2>

      <div>
        <p className="text-sm font-medium text-fg-tertiary uppercase tracking-wide mb-3">
          Registration
        </p>
        <div className="flex flex-col gap-2" role="radiogroup" aria-label="Registration mode">
          {REGISTRATION_MODE_OPTIONS.map(({ value, label, description }) => (
            <label
              key={value}
              className={`flex items-center gap-3 w-full px-4 py-3 rounded-lg border transition-colors duration-150 cursor-pointer focus-within:ring-2 focus-within:ring-primary-emphasis ${
                saving ? "opacity-50 pointer-events-none" : ""
              } ${
                settings?.registration_mode === value
                  ? "border-primary-emphasis bg-info/10"
                  : "border-line-strong hover:bg-surface-hover/40"
              }`}
            >
              <input
                type="radio"
                className="sr-only"
                name="registration_mode"
                value={value}
                checked={settings?.registration_mode === value}
                disabled={saving}
                onChange={() => handleChange(value)}
              />
              <span
                className={`w-4 h-4 rounded-full border-2 flex items-center justify-center shrink-0 ${
                  settings?.registration_mode === value
                    ? "border-primary-emphasis"
                    : "border-line-strong"
                }`}
              >
                {settings?.registration_mode === value && (
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

      <div>
        <p className="text-sm font-medium text-fg-tertiary uppercase tracking-wide mb-3">
          Features
        </p>
        <div className="flex items-center justify-between px-4 py-3 rounded-lg border border-line bg-surface">
          <div>
            <span className="block text-sm font-medium text-fg">File uploads</span>
            <span className="block text-xs text-fg-muted">Allow members to attach files to cards</span>
          </div>
          <button
            role="switch"
            aria-checked={settings?.uploads_enabled ?? true}
            onClick={handleUploadsToggle}
            disabled={saving}
            className={`relative inline-flex h-5 w-9 items-center rounded-full transition disabled:opacity-40 focus:outline-none focus:ring-2 focus:ring-primary-emphasis ${
              settings?.uploads_enabled ? "bg-primary" : "bg-surface-active"
            }`}
          >
            <span
              className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition ${
                settings?.uploads_enabled ? "translate-x-4" : "translate-x-1"
              }`}
            />
          </button>
        </div>
      </div>

      <p className="text-sm h-5">
        {error && <span className="text-danger">{error}</span>}
        {saved && <span className="text-success">Settings saved.</span>}
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
  const [pageSize, setPageSize] = useState(50);
  const [offset, setOffset] = useState(0);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showAddModal, setShowAddModal] = useState(false);
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);
  const [offboardingUser, setOffboardingUser] = useState<AdminUser | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const fetchUsers = useCallback(
    async (searchVal: string, offsetVal: number) => {
      setLoading(true);
      setError(null);
      try {
        const data = await getAdminUsers({ search: searchVal || undefined, offset: offsetVal });
        setUsers(data.results);
        setTotal(data.count);
        // Use the server-returned page_size so pagination controls stay in sync
        // even if the server-side default changes.
        setPageSize(data.page_size);
      } catch {
        setError("Failed to load users.");
      } finally {
        setLoading(false);
      }
    },
    []
  );

  useEffect(() => {
    fetchUsers(search, offset);
  }, [offset]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleSearchChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    setSearch(val);
    setOffset(0);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => fetchUsers(val, 0), 400);
  };

  const applyPatch = async (
    userId: number,
    patch: Partial<Pick<AdminUser, "is_active" | "is_site_admin" | "can_access_all_content" | "must_change_password">>
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
    if (user.owned_boards.length > 0) {
      // User owns boards — show the offboarding modal to collect transfer targets.
      setOffboardingUser(user);
      return;
    }
    confirmAndRun(
      `Deactivate ${user.display_name || user.username}? They will no longer be able to log in.`,
      async () => {
        setActionError(null);
        try {
          const updated = await deactivateAdminUser(user.id);
          setUsers((prev) => prev.map((u) => (u.id === user.id ? updated : u)));
        } catch (err: unknown) {
          const data = (err as { response?: { data?: { detail?: string } } }).response?.data;
          setActionError(data?.detail ?? "Action failed. Please try again.");
        }
      }
    );
  };

  const handleDemote = (user: AdminUser) => {
    confirmAndRun(
      `Remove site admin role from ${user.display_name || user.username}?`,
      () => applyPatch(user.id, { is_site_admin: false })
    );
  };

  const handleGrantContentAccess = (user: AdminUser) => {
    confirmAndRun(
      `Grant "${user.display_name || user.username}" access to all boards and groups regardless of membership?`,
      () => applyPatch(user.id, { can_access_all_content: true })
    );
  };

  const handleRevokeContentAccess = (user: AdminUser) => {
    confirmAndRun(
      `Revoke all-content access from ${user.display_name || user.username}? They will only see boards they are a member of.`,
      () => applyPatch(user.id, { can_access_all_content: false })
    );
  };

  const totalPages = Math.ceil(total / pageSize);
  const currentPage = pageSize > 0 ? Math.floor(offset / pageSize) + 1 : 1;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-4">
        <h2 className="text-fg text-lg font-semibold">Users</h2>
        <button
          onClick={() => setShowAddModal(true)}
          className="px-3 py-1.5 text-sm bg-primary hover:bg-primary-hover text-on-primary rounded transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
        >
          + Add User
        </button>
      </div>

      <input
        type="search"
        value={search}
        onChange={handleSearchChange}
        placeholder="Search by name, email, or username…"
        className="bg-surface border border-line rounded px-3 py-1.5 text-sm text-fg-secondary focus:outline-none focus:ring-2 focus:ring-primary-emphasis focus:border-transparent placeholder-fg-muted max-w-md"
      />

      {actionError && (
        <p className="text-sm text-danger">{actionError}</p>
      )}

      {loading ? (
        <div className="text-fg-tertiary text-sm">Loading…</div>
      ) : error ? (
        <div className="text-danger text-sm">{error}</div>
      ) : (
        <>
          <div className="overflow-x-auto rounded-lg border border-line">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-surface text-fg-tertiary text-xs uppercase tracking-wide">
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
                    className="border-t border-line-subtle hover:bg-surface/50 transition"
                  >
                    <td className="px-4 py-2.5">
                      <div className="flex items-center gap-2">
                        <Avatar user={u} size="sm" />
                        <div>
                          <div className="flex items-center gap-1.5">
                            <span className="text-fg">
                              {u.display_name || u.first_name || u.username}
                            </span>
                            {u.is_site_admin && (
                              <span className="px-1.5 py-0.5 text-xs rounded-full bg-info/20 text-info">
                                Admin
                              </span>
                            )}
                            {u.can_access_all_content && (
                              <span className="px-1.5 py-0.5 text-xs rounded-full bg-accent-violet/20 text-accent-violet">
                                All content
                              </span>
                            )}
                            {u.must_change_password && (
                              <span className="px-1.5 py-0.5 text-xs rounded-full bg-warning/20 text-warning">
                                Reset req.
                              </span>
                            )}
                          </div>
                          <span className="text-xs text-fg-muted">@{u.username}</span>
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-2.5 text-fg-secondary">{u.email}</td>
                    <td className="px-4 py-2.5 text-fg-muted">{formatDate(u.date_joined)}</td>
                    <td className="px-4 py-2.5">
                      {u.is_active ? (
                        <span className="text-success text-xs">Active</span>
                      ) : (
                        <span className="text-fg-muted text-xs">Inactive</span>
                      )}
                    </td>
                    <td className="px-4 py-2.5">
                      <div className="flex items-center gap-2">
                        {/* Deactivate / Reactivate */}
                        {u.id !== currentUser.id && (
                          u.is_active ? (
                            <button
                              onClick={() => handleDeactivate(u)}
                              className="text-xs text-fg-tertiary hover:text-danger transition"
                            >
                              Deactivate
                            </button>
                          ) : (
                            <button
                              onClick={() => applyPatch(u.id, { is_active: true })}
                              className="text-xs text-fg-tertiary hover:text-success transition"
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
                              className="text-xs text-fg-tertiary hover:text-warning transition"
                            >
                              Demote admin
                            </button>
                          ) : (
                            <button
                              onClick={() => confirmAndRun(
                                `Grant site admin to ${u.display_name || u.username}? They will have full access to this admin panel.`,
                                () => applyPatch(u.id, { is_site_admin: true })
                              )}
                              className="text-xs text-fg-tertiary hover:text-info transition"
                            >
                              Make admin
                            </button>
                          )
                        )}

                        {/* Can access all content */}
                        {u.can_access_all_content ? (
                          <button
                            onClick={() => handleRevokeContentAccess(u)}
                            title="Revoke access to all boards and groups"
                            className="text-xs text-fg-tertiary hover:text-warning transition"
                          >
                            Revoke all-content
                          </button>
                        ) : (
                          <button
                            onClick={() => handleGrantContentAccess(u)}
                            title="Grants read/write access to all boards and groups regardless of membership"
                            className="text-xs text-fg-tertiary hover:text-accent-violet transition"
                          >
                            Grant all-content
                          </button>
                        )}

                        {/* Force password reset */}
                        {!u.must_change_password && (
                          <button
                            onClick={() => applyPatch(u.id, { must_change_password: true })}
                            className="text-xs text-fg-tertiary hover:text-warning transition"
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
                    <td colSpan={5} className="px-4 py-8 text-center text-fg-muted">
                      No users found.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          <div className="flex items-center justify-between text-sm text-fg-tertiary">
            <span>{total} {total === 1 ? "user" : "users"}</span>
            {totalPages > 1 && (
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setOffset((o) => Math.max(0, o - pageSize))}
                  disabled={offset === 0}
                  className="px-2 py-1 text-xs text-fg-tertiary hover:text-fg hover:bg-surface-hover rounded disabled:opacity-40 transition"
                >
                  ← Prev
                </button>
                <span className="text-xs">
                  Page {currentPage} of {totalPages}
                </span>
                <button
                  onClick={() => setOffset((o) => Math.min((totalPages - 1) * pageSize, o + pageSize))}
                  disabled={currentPage === totalPages}
                  className="px-2 py-1 text-xs text-fg-tertiary hover:text-fg hover:bg-surface-hover rounded disabled:opacity-40 transition"
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

      {offboardingUser && (
        <OffboardingModal
          user={offboardingUser}
          onDeactivated={(updated) => {
            setUsers((prev) => prev.map((u) => (u.id === updated.id ? updated : u)));
            setOffboardingUser(null);
          }}
          onClose={() => setOffboardingUser(null)}
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
  { id: "invite_links", label: "Invite Links" },
];

export default function AdminPage({ user, onLogout, onUserUpdated }: Props) {
  const navigate = useNavigate();
  const [activeTab, setActiveTab] = useState<Tab>("settings");

  useEscapeStack(() => {
    const tag = (document.activeElement as HTMLElement)?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return false;
    if (window.history.length > 1) { navigate(-1); return; }
    navigate("/");
  }, 0);

  // Redirect non-admins immediately.
  useEffect(() => {
    if (!user.is_site_admin) {
      navigate("/", { replace: true });
    }
  }, [user.is_site_admin, navigate]);

  if (!user.is_site_admin) return null;

  return (
    <div className="h-full bg-sunken flex flex-col">
      <Navbar user={user} onLogout={onLogout} onUserUpdated={onUserUpdated} />

      <main className="flex-1 overflow-y-auto p-8 max-w-5xl mx-auto w-full">
        <h1 className="text-fg text-2xl font-bold mb-8">Site Administration</h1>

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
            {activeTab === "settings" && <SettingsTab />}
            {activeTab === "users" && <UsersTab currentUser={user} />}
            {activeTab === "invite_links" && <InviteLinksTab />}
          </div>
        </div>
      </main>
    </div>
  );
}
