import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useEscapeStack } from "../hooks/useEscapeStack";
import { useConfirmFocusReturn } from "../hooks/useConfirmFocusReturn";
import { useConfirmAnnouncement } from "../hooks/useConfirmAnnouncement";
import { useIsPhoneViewport } from "../hooks/useIsPhoneViewport";
import {
  clearAdminUserLockout,
  createAdminUser,
  deactivateAdminUser,
  getAdminBoardInviteLinks,
  getAdminInviteLinksPage,
  getAdminSettings,
  getAdminUsers,
  createAdminInviteLink,
  patchAdminSettings,
  patchAdminUser,
  revokeAdminInviteLink,
  sendAdminInviteEmail,
} from "../api/auth";
import Avatar from "../components/Common/Avatar";
import EmailInviteForm from "../components/Common/EmailInviteForm";
import BoardInvitesTab from "../components/Admin/BoardInvitesTab";
import EmailSettingsSection from "../components/Admin/EmailSettingsSection";
import Navbar from "../components/Layout/Navbar";
import OverflowMenu, { type OverflowItem } from "../components/Layout/OverflowMenu";
import ModalWrapper from "../components/shared/ModalWrapper";
import {
  Button,
  EmptyState,
  Field,
  InlineConfirm,
  ListRow,
  ListWell,
  PageHeading,
  SettingSwitchRow,
  SettingsCard,
  SettingsLayout,
  StatusPill,
  Switch,
  type SettingsSection,
  type StatusTone,
} from "../components/Page";
import type { AdminInviteLinkPage } from "../api/auth";
import type { AdminInviteLink, AdminUser, CreatedAdminInviteLink, RegistrationMode, SiteSettings } from "../types";
import type { User } from "../types";
import AnchoredMenuPanel from "../components/Common/AnchoredMenuPanel";
import { captureMenuAnchor, type MenuAnchor } from "../utils/menuAnchor";

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

/** A section's load failure: the message and a Retry (the shared error-banner pattern). */
function LoadError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div role="alert" className="flex flex-wrap items-center gap-3 rounded-[10px] border border-danger/40 bg-danger/10 px-4 py-3">
      <p className="text-sm text-danger-on-tint">{message}</p>
      <Button variant="secondary" onClick={onRetry}>Retry</Button>
    </div>
  );
}

const INVITE_STATUS_TONE: Record<AdminInviteLink["status"], StatusTone> = {
  pending: "pending",
  used: "on_track",
  expired: "at_risk",
  // Revoked is struck through as well as red, so the word and the strike carry it, not color alone.
  revoked: "off_track",
};

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
    <ModalWrapper open onClose={onClose} title="Add user" maxWidth="max-w-md">
      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        <Field label="Username" value={form.username} onChange={set("username")} required autoComplete="off" />
        <Field label="Email address" type="email" value={form.email} onChange={set("email")} required autoComplete="off" />
        <Field
          label="Password"
          type="password"
          value={form.password}
          onChange={set("password")}
          required
          minLength={12}
          autoComplete="new-password"
          hint="Minimum 12 characters"
        />

        <label className="flex items-center gap-3 cursor-pointer text-sm text-fg-secondary">
          <input
            type="checkbox"
            checked={form.force_password_reset}
            onChange={set("force_password_reset")}
            className="w-4 h-4 accent-primary"
          />
          Force password reset on first login
        </label>

        {error && <p className="text-sm text-danger">{error}</p>}

        <div className="flex justify-end gap-3 pt-2">
          <Button variant="quiet" onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" disabled={saving}>{saving ? "Creating…" : "Create user"}</Button>
        </div>
      </form>
    </ModalWrapper>
  );
}

// ---------------------------------------------------------------------------
// Invite links section
// ---------------------------------------------------------------------------

const TTL_OPTIONS: { label: string; value: number | null }[] = [
  { label: "1 day", value: 1 },
  { label: "7 days", value: 7 },
  { label: "30 days", value: 30 },
  { label: "Never", value: null },
];

function formatExpiry(link: AdminInviteLink): string {
  if (!link.expires_at) return "Never";
  return new Date(link.expires_at).toLocaleDateString("en-US", {
    month: "short", day: "numeric", year: "numeric",
  });
}

function InviteLinksSection({ onActiveCount }: { onActiveCount: (n: number) => void }) {
  const [links, setLinks] = useState<AdminInviteLink[]>([]);
  // Server cap notice (#2254): older used/expired links are left out of the list.
  const [truncation, setTruncation] = useState<{ total: number } | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [form, setForm] = useState<{ expires_in_days: number | null; single_use: boolean }>({
    expires_in_days: 7,
    single_use: false,
  });
  const [newLink, setNewLink] = useState<CreatedAdminInviteLink | null>(null);
  const [copied, setCopied] = useState(false);
  const [revokeConfirm, setRevokeConfirm] = useState<number | null>(null);
  const [revokingId, setRevokingId] = useState<number | null>(null);
  const revokeTriggerRef = useConfirmFocusReturn(revokeConfirm);
  useConfirmAnnouncement(revokeConfirm === null ? null : "Revoke this invite link? Anyone holding it will no longer be able to join.");

  // Escape cancels an open inline revoke confirm before the page-level
  // Escape-to-navigate handler (priority 0) can leave the page (#1238).
  useEscapeStack(() => {
    if (revokeConfirm !== null) { setRevokeConfirm(null); return; }
    return false;
  }, 40);
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => { if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current); };
  }, []);

  // The nav count is the number of active (pending) links.
  useEffect(() => {
    onActiveCount(links.filter((l) => l.status === "pending").length);
  }, [links, onActiveCount]);

  const applyPage = (page: AdminInviteLinkPage) => {
    setLinks(page.links);
    setTruncation(page.truncated ? { total: page.total } : null);
  };

  const load = useCallback(() => {
    setLoading(true);
    setLoadError(false);
    getAdminInviteLinksPage()
      .then(applyPage)
      .catch(() => setLoadError(true))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

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
    navigator.clipboard
      .writeText(`${window.location.origin}/join/${newLink.raw_token}`)
      .then(() => {
        setCopied(true);
        if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
        copiedTimerRef.current = setTimeout(() => setCopied(false), 2000);
      })
      .catch(() => setError("Failed to copy the link. Copy it manually instead."));
  };

  const handleRevoke = async (id: number) => {
    // Guard against a double click sending two revokes while one is in flight.
    if (revokingId !== null) return;
    setRevokingId(id);
    try {
      const updated = await revokeAdminInviteLink(id);
      setLinks((prev) => prev.map((l) => (l.id === id ? updated : l)));
    } catch {
      setError("Failed to revoke invite link. Please try again.");
    } finally {
      setRevokeConfirm(null);
      setRevokingId(null);
    }
  };

  const heading = (
    <PageHeading
      title="Invite links"
      description="Shareable links that let people join this site."
      actions={<Button variant="primary" onClick={() => setShowForm((v) => !v)} aria-expanded={showForm}>New link</Button>}
    />
  );

  if (loading) return <>{heading}<div className="text-fg-tertiary text-sm">Loading…</div></>;
  if (loadError) return <>{heading}<LoadError message="Failed to load invite links." onRetry={load} /></>;

  const linkUrl = newLink ? `${window.location.origin}/join/${newLink.raw_token}` : "";

  return (
    <>
      {heading}

      {showForm && (
        <SettingsCard title="New invite link">
          <form onSubmit={handleCreate} className="flex flex-col gap-4 max-w-sm">
            <div className="flex flex-col gap-1">
              <label htmlFor="invite-expires" className="text-sm font-medium text-fg-secondary">Expires after</label>
              <select
                id="invite-expires"
                value={form.expires_in_days ?? ""}
                onChange={(e) => setForm((f) => ({ ...f, expires_in_days: e.target.value === "" ? null : Number(e.target.value) }))}
                className="w-full h-9 max-sm:h-11 bg-surface border border-line-strong text-fg rounded px-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
              >
                {TTL_OPTIONS.map((o) => (
                  <option key={String(o.value)} value={o.value ?? ""}>{o.label}</option>
                ))}
              </select>
              {form.expires_in_days === null && (
                <p className="text-xs text-warning-on-tint">Never-expiring links are a security risk — use with caution.</p>
              )}
            </div>

            <SettingSwitchRow
              label="Single-use"
              checked={form.single_use}
              onChange={(checked) => setForm((f) => ({ ...f, single_use: checked }))}
            />

            {createError && <p className="text-sm text-danger">{createError}</p>}

            <div className="flex gap-2">
              <Button variant="primary" type="submit" disabled={creating}>{creating ? "Creating…" : "Create link"}</Button>
              <Button variant="quiet" onClick={() => setShowForm(false)}>Cancel</Button>
            </div>
          </form>
        </SettingsCard>
      )}

      {/* One-time token reveal */}
      {newLink && (
        <div className="flex flex-col gap-2 p-3 rounded-[10px] border border-warning/50 bg-sunken">
          <p className="text-sm text-warning-on-tint">Copy this link now — it won't be shown again.</p>
          <div className="flex items-center gap-2">
            <span
              title={linkUrl}
              className="flex-1 min-w-0 font-mono text-xs text-fg bg-surface border border-line rounded px-2 py-2 truncate"
            >
              {linkUrl}
            </span>
            <Button variant="primary" onClick={handleCopy}>{copied ? "Copied!" : "Copy"}</Button>
            <Button variant="quiet" onClick={() => setNewLink(null)}>Done</Button>
          </div>
        </div>
      )}

      {error && <p role="alert" className="text-sm text-danger">{error}</p>}

      {links.length === 0 ? (
        <EmptyState title="No invite links yet." description="Create one to let people join without an account." />
      ) : (
        <>
          {truncation && (
            <p className="text-xs text-fg-secondary" data-testid="invite-links-truncated">
              Older used, expired, or revoked links are not shown. {truncation.total} links in total.
            </p>
          )}
          <ListWell as="ul" label="Invite links">
            {links.map((link) => (
              <li key={link.id}>
                <ListRow as="div">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-mono text-xs text-fg-secondary">{link.prefix}…</span>
                      {link.delivery === "email" && (
                        <span className="px-2 py-0.5 text-xs rounded-full bg-surface-hover text-fg-secondary">Emailed</span>
                      )}
                      {link.single_use && (
                        <span className="px-2 py-0.5 text-xs rounded-full bg-surface-hover text-fg-secondary">Single-use</span>
                      )}
                    </div>
                    <p className="text-xs text-fg-secondary mt-0.5">
                      Created {formatDate(link.created_at)}
                      {link.created_by_username && ` by ${link.created_by_username}`}
                      {` · Expires ${formatExpiry(link)}`}
                      {` · ${link.use_count} ${link.use_count === 1 ? "use" : "uses"}`}
                    </p>
                  </div>
                  <span className={link.status === "revoked" ? "line-through" : undefined}>
                    <StatusPill tone={INVITE_STATUS_TONE[link.status]} label={link.status.charAt(0).toUpperCase() + link.status.slice(1)} />
                  </span>
                  {link.status === "pending" && revokeConfirm !== link.id && (
                    <Button
                      variant="quiet"
                      buttonRef={revokeTriggerRef(link.id)}
                      onClick={() => setRevokeConfirm(link.id)}
                      aria-label={`Revoke invite link ${link.prefix}`}
                    >
                      Revoke
                    </Button>
                  )}
                </ListRow>
                {revokeConfirm === link.id && (
                  <div className="px-3 pb-2">
                    <InlineConfirm
                      message="Revoke this invite link? Anyone holding it will no longer be able to join."
                      actionLabel={revokingId === link.id ? "Revoking…" : "Revoke link"}
                      busy={revokingId === link.id}
                      onConfirm={() => void handleRevoke(link.id)}
                      onCancel={() => setRevokeConfirm(null)}
                    />
                  </div>
                )}
              </li>
            ))}
          </ListWell>
        </>
      )}
    </>
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

/**
 * Member-search results for the offboarding transfer rows (#1482). A `fixed`
 * panel under the input, in the modal's DOM (no body portal, so the modal's
 * focus trap still contains it): the rows sit in an `overflow-hidden` list,
 * which clipped the old in-flow `absolute` menu on the last board.
 */
function TransferResultsPanel({ anchor, count, onDismiss, children }: {
  anchor: MenuAnchor | null;
  /** Result count: the debounced search changes the list height, so re-measure on it. */
  count: number;
  onDismiss: () => void;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  return (
    <AnchoredMenuPanel
      anchor={anchor}
      panelRef={ref}
      onDismiss={onDismiss}
      mode="inline"
      inputAnchored
      deps={[count]}
      minWidth={anchor ? anchor.right - anchor.left : 0}
    >
      <ul>{children}</ul>
    </AnchoredMenuPanel>
  );
}

function OffboardingModal({ user, onDeactivated, onClose }: OffboardingModalProps) {
  const contentRef = useRef<HTMLDivElement>(null);
  // ModalWrapper owns the Tab trap; this only picks the first focus target.
  useEffect(() => {
    contentRef.current
      ?.querySelector<HTMLElement>('button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')
      ?.focus();
  }, []);
  // Per-board transfer map: board id → selected user id
  const [transfers, setTransfers] = useState<Record<number, number | null>>(
    () => Object.fromEntries(user.owned_boards.map((b) => [b.id, null]))
  );
  const [memberSearch, setMemberSearch] = useState<Record<number, string>>({});
  const [memberResults, setMemberResults] = useState<Record<number, User[]>>({});
  const [memberAnchors, setMemberAnchors] = useState<Record<number, MenuAnchor | null>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const debounceRefs = useRef<Record<number, ReturnType<typeof setTimeout>>>({});

  // #1305 — found via the timer-ref audit: this per-board search debounce
  // had no unmount cleanup, so closing the offboarding modal mid-debounce
  // could run setMemberResults after teardown.
  useEffect(() => {
    const refs = debounceRefs.current;
    return () => {
      Object.values(refs).forEach((t) => clearTimeout(t));
    };
  }, []);

  const handleMemberSearch = (boardId: number, query: string, input: HTMLElement) => {
    // Anchor for the fixed results panel: the list sits inside an
    // `overflow-hidden` container, which clipped an in-flow menu (#1482).
    setMemberAnchors((prev) => ({ ...prev, [boardId]: captureMenuAnchor(input) }));
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
                  onChange={(e) => handleMemberSearch(board.id, e.target.value, e.currentTarget)}
                  className="w-full bg-surface border border-line rounded px-3 py-1.5 text-sm text-fg-secondary focus:outline-none focus:ring-2 focus:ring-primary-emphasis focus:border-transparent placeholder-fg-muted"
                />
                {(memberResults[board.id] ?? []).length > 0 && (
                  <TransferResultsPanel
                    anchor={memberAnchors[board.id] ?? null}
                    count={memberResults[board.id].length}
                    onDismiss={() => setMemberResults((prev) => ({ ...prev, [board.id]: [] }))}
                  >
                    {memberResults[board.id].map((member) => (
                      <li key={member.id}>
                        <button
                          type="button"
                          onClick={() => selectTransfer(board.id, member)}
                          className="w-full text-left px-3 py-2 text-sm text-fg-secondary hover:bg-surface-hover transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
                        >
                          {member.display_name || member.username}
                          <span className="text-fg-muted ml-1">@{member.username}</span>
                        </button>
                      </li>
                    ))}
                  </TransferResultsPanel>
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
            className="px-3 py-1.5 text-sm bg-danger-bg hover:bg-danger-bg-hover disabled:opacity-40 text-on-danger rounded font-medium transition focus:outline-none focus:ring-2 focus:ring-danger-emphasis"
          >
            {saving ? "Processing…" : "Transfer ownership and deactivate"}
          </button>
        </div>
      </div>
    </ModalWrapper>
  );
}

// ---------------------------------------------------------------------------
// General section
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

const MAINTENANCE_MESSAGE_MAX = 1000;
// 90% of the cap, matching the 500/450 precedent in CreateGroupModal.
const MAINTENANCE_MESSAGE_WARN = 900;
const MAINTENANCE_SWITCH_ID = "maintenance-mode-switch";

function GeneralSection() {
  const [settings, setSettings] = useState<SiteSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const savedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Local buffer for the notice so typing does not PATCH on every keystroke;
  // it is written back on blur, like the paired numeric settings fields.
  const [maintenanceMessage, setMaintenanceMessage] = useState("");
  // Turning maintenance mode ON is instance-wide and takes effect instantly for
  // every user, so it goes through the inline-confirmation pattern. Turning it
  // OFF just restores normal service and needs no confirmation.
  const [confirmingEnable, setConfirmingEnable] = useState(false);
  // Cancel returns focus to the switch (#1367). Switch takes an id, not a ref, so look it up.
  const [refocusSwitch, setRefocusSwitch] = useState(0);
  useEffect(() => {
    if (refocusSwitch > 0) document.getElementById(MAINTENANCE_SWITCH_ID)?.focus();
  }, [refocusSwitch]);
  useConfirmAnnouncement(confirmingEnable ? "Turn on maintenance mode? Everyone but admins becomes read-only right away." : null);
  // Escape cancels the open confirm before the page-level Escape-to-navigate handler (#1238).
  useEscapeStack(() => {
    if (confirmingEnable) { setConfirmingEnable(false); setRefocusSwitch((n) => n + 1); return; }
    return false;
  }, 40);

  useEffect(() => {
    return () => { if (savedTimerRef.current) clearTimeout(savedTimerRef.current) };
  }, []);

  const load = useCallback(() => {
    setLoading(true);
    setLoadError(false);
    getAdminSettings()
      .then(setSettings)
      .catch(() => setLoadError(true))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  // Re-seed the local buffer whenever the server's value changes — on first
  // load, and after a save returns the canonical value. Depending on the field
  // rather than the whole settings object keeps an unrelated settings change
  // (a registration mode flip, say) from discarding an in-progress edit.
  //
  // This runs during render (React's "adjust state when a prop changes"
  // pattern), not in a useEffect. An effect only runs after the commit that
  // first shows the textarea, so an edit landing in that window was queued
  // ahead of the late seed and silently overwritten by it (#1319).
  const serverMaintenanceMessage = settings?.maintenance_message;
  const [seededMessage, setSeededMessage] = useState<string | undefined>(undefined);
  if (serverMaintenanceMessage !== undefined && serverMaintenanceMessage !== seededMessage) {
    setSeededMessage(serverMaintenanceMessage);
    setMaintenanceMessage(serverMaintenanceMessage);
  }

  /** One optimistic PATCH: apply `optimistic`, save `patch`, roll back with `rollback` on failure. */
  const saveSetting = async (
    patch: Partial<SiteSettings>,
    rollback: (s: SiteSettings) => SiteSettings,
    failure: string,
    onRollback?: () => void,
  ) => {
    if (!settings || saving) return;
    setSettings((s) => (s ? { ...s, ...patch } : s));
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const updated = await patchAdminSettings(patch);
      setSettings(updated);
      setSaved(true);
      if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
      savedTimerRef.current = setTimeout(() => setSaved(false), 3000);
    } catch {
      setSettings((s) => (s ? rollback(s) : s));
      onRollback?.();
      setError(failure);
    } finally {
      setSaving(false);
    }
  };

  const handleChange = (mode: RegistrationMode) => {
    if (!settings) return;
    const prev = settings.registration_mode;
    void saveSetting({ registration_mode: mode }, (s) => ({ ...s, registration_mode: prev }), "Failed to save settings.");
  };

  const handleUploadsToggle = () => {
    if (!settings) return;
    const prev = settings.uploads_enabled;
    void saveSetting({ uploads_enabled: !prev }, (s) => ({ ...s, uploads_enabled: prev }), "Failed to save settings.");
  };

  const handleMaintenanceToggle = (next: boolean) => {
    if (!settings) return;
    const prev = settings.maintenance_mode;
    void saveSetting(
      { maintenance_mode: next },
      (s) => ({ ...s, maintenance_mode: prev }),
      `Failed to turn ${next ? "on" : "off"} maintenance mode. Please try again.`,
    );
  };

  const handleMaintenanceToggleClick = (next: boolean) => {
    if (!next) {
      handleMaintenanceToggle(false);
      return;
    }
    // Deliberately does NOT flip the switch optimistically first: Cancel then
    // has nothing to revert, so the control never visibly flickers on and back
    // off for a change that was never made.
    setConfirmingEnable(true);
  };

  const handleMaintenanceMessageBlur = () => {
    if (!settings || maintenanceMessage === settings.maintenance_message) return;
    const prev = settings.maintenance_message;
    void saveSetting(
      { maintenance_message: maintenanceMessage },
      (s) => ({ ...s, maintenance_message: prev }),
      "Failed to save settings.",
      () => setMaintenanceMessage(prev),
    );
  };

  const messageCountColor =
    maintenanceMessage.length > MAINTENANCE_MESSAGE_MAX
      ? "text-danger"
      : maintenanceMessage.length >= MAINTENANCE_MESSAGE_WARN
        ? "text-warning-on-tint"
        : "text-fg-secondary";

  const heading = <PageHeading title="General" description="Switches save as soon as you change them." />;

  if (loading) return <>{heading}<div className="text-fg-tertiary text-sm">Loading…</div></>;
  if (loadError) return <>{heading}<LoadError message="Failed to load settings." onRetry={load} /></>;

  return (
    <>
      {heading}

      {settings?.maintenance_mode && (
        <div role="status" className="rounded-[10px] border border-warning/40 bg-warning/10 px-4 py-3 text-sm text-warning-on-tint">
          Maintenance mode is on. Members see the notice and can't make changes.
        </div>
      )}

      <SettingsCard title="Registration">
        <div className="flex flex-col gap-2" role="radiogroup" aria-label="Registration mode">
          {REGISTRATION_MODE_OPTIONS.map(({ value, label, description }) => (
            <label
              key={value}
              className={`flex items-center gap-3 w-full px-4 py-3 rounded-lg border transition-colors duration-150 cursor-pointer focus-within:ring-2 focus-within:ring-primary-emphasis ${
                saving ? "opacity-40 pointer-events-none" : ""
              } ${
                settings?.registration_mode === value
                  ? "border-primary-emphasis bg-primary-emphasis/10"
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
                <span className="block text-xs text-fg-secondary mt-0.5">{description}</span>
              </span>
            </label>
          ))}
        </div>
      </SettingsCard>

      <SettingsCard title="Features">
        <SettingSwitchRow
          label="File uploads"
          description="Allow members to attach files to cards"
          checked={settings?.uploads_enabled ?? true}
          onChange={handleUploadsToggle}
          disabled={saving}
        />
      </SettingsCard>

      <SettingsCard title="Maintenance">
        <div className="flex flex-col gap-3">
          <div className="flex items-center justify-between gap-4">
            <div className="min-w-0">
              <p id="maintenance-mode-label" className="text-sm font-medium text-fg">Maintenance mode</p>
              <p className="mt-0.5 text-sm text-fg-secondary">
                Block writes for all non-admin users; reads keep working. Site admins are exempt and keep full read/write access.
              </p>
            </div>
            <MaintenanceSwitch
              checked={settings?.maintenance_mode ?? false}
              onChange={handleMaintenanceToggleClick}
              disabled={saving}
            />
          </div>
          {confirmingEnable && (
            <InlineConfirm
              message="Turn on maintenance mode? Everyone but admins becomes read-only right away."
              actionLabel="Turn on maintenance mode"
              onConfirm={() => { setConfirmingEnable(false); handleMaintenanceToggle(true); }}
              onCancel={() => { setConfirmingEnable(false); setRefocusSwitch((n) => n + 1); }}
            />
          )}

          <div className="pt-3 border-t border-line-subtle">
            <div className="flex items-center justify-between mb-1">
              <label htmlFor="maintenance-message" className="block text-sm font-medium text-fg-secondary">
                Message <span className="text-fg-secondary font-normal">(optional)</span>
              </label>
              <span className={`text-xs tabular-nums ${messageCountColor}`}>
                {maintenanceMessage.length.toLocaleString("en-US")} / {MAINTENANCE_MESSAGE_MAX.toLocaleString("en-US")}
              </span>
            </div>
            <textarea
              id="maintenance-message"
              rows={3}
              value={maintenanceMessage}
              onChange={(e) => setMaintenanceMessage(e.target.value.slice(0, MAINTENANCE_MESSAGE_MAX))}
              onBlur={handleMaintenanceMessageBlur}
              disabled={saving}
              placeholder="e.g. Upgrading to v1.3 — expect service back by 3:00 PM UTC."
              className="w-full bg-surface border border-line-strong rounded px-3 py-2 text-sm text-fg focus:outline-none focus:ring-2 focus:ring-primary-emphasis placeholder-fg-muted resize-none transition"
            />
            <p className="text-xs text-fg-secondary mt-1">
              Shown to all users while maintenance mode is on. Mentioning when you expect to finish helps people plan around the interruption. Anyone can read it without signing in, so keep internal detail out of it.
            </p>
            <p className="text-xs text-fg-secondary mt-1">
              Leave blank to show the default: &ldquo;Visiban is in maintenance mode. You can still read boards and cards, but changes are temporarily disabled. Please try again shortly.&rdquo;
            </p>
          </div>
        </div>
      </SettingsCard>

      <p className="text-sm min-h-5" role="status">
        {error && <span className="text-danger">{error}</span>}
        {saved && <span className="text-success">Settings saved.</span>}
      </p>
    </>
  );
}

/** The maintenance switch, named by the row's label (the shared Switch has no label of its own). */
function MaintenanceSwitch({ checked, onChange, disabled }: { checked: boolean; onChange: (next: boolean) => void; disabled: boolean }) {
  return (
    <Switch
      id={MAINTENANCE_SWITCH_ID}
      checked={checked}
      onChange={onChange}
      disabled={disabled}
      aria-labelledby="maintenance-mode-label"
    />
  );
}

// ---------------------------------------------------------------------------
// Users section
// ---------------------------------------------------------------------------

/** One open inline confirm, shown under the row it concerns. */
interface ConfirmState {
  userId: number;
  message: string;
  actionLabel: string;
  /** Opens the transfer dialog instead of running a request (a user who owns boards). */
  onConfirm: () => void | Promise<void>;
  /** The control that opened the confirm; it outlives a menu item, so focus goes back to it. */
  returnFocusTo: HTMLElement | null;
}

function UsersSection({ currentUser, onTotal, onOpenEmailSettings }: {
  currentUser: User;
  onTotal: (n: number) => void;
  onOpenEmailSettings: () => void;
}) {
  const isPhone = useIsPhoneViewport();
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [total, setTotal] = useState(0);
  const [pageSize, setPageSize] = useState(50);
  const [offset, setOffset] = useState(0);
  const [search, setSearch] = useState("");
  const [searched, setSearched] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showAddModal, setShowAddModal] = useState(false);
  const [showInvite, setShowInvite] = useState(false);
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);
  const [offboardingUser, setOffboardingUser] = useState<AdminUser | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  // Generic success feedback for row actions that need to confirm they worked
  // (currently only Restart onboarding tour) — auto-clears like the
  // self-service confirmation in SettingsPage's tour-restart handler.
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const actionMessageTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Per-user in-flight guard for the tour-restart action, so a slow request
  // can't be fired twice for the same user from a stray double-click.
  const [restartingTourIds, setRestartingTourIds] = useState<Set<number>>(new Set());
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (actionMessageTimerRef.current) clearTimeout(actionMessageTimerRef.current);
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  // Escape cancels an open inline confirm before the page-level Escape-to-navigate handler (#1238).
  useEscapeStack(() => {
    if (confirm) { closeConfirm(); return; }
    return false;
  }, 40);

  const fetchUsers = useCallback(
    async (searchVal: string, offsetVal: number) => {
      setLoading(true);
      setError(null);
      try {
        const data = await getAdminUsers({ search: searchVal || undefined, offset: offsetVal });
        setUsers(data.results);
        setTotal(data.count);
        setSearched(searchVal);
        // The nav count is the site's total users, not a search's matches.
        if (!searchVal) onTotal(data.count);
        // Use the server-returned page_size so pagination controls stay in sync
        // even if the server-side default changes.
        setPageSize(data.page_size);
      } catch {
        setError("Failed to load users.");
      } finally {
        setLoading(false);
      }
    },
    [onTotal]
  );

  useEffect(() => {
    // void: fetchUsers handles its own errors via setError and never rethrows.
    void fetchUsers(search, offset);
    // search is read from the latest closure intentionally: typing updates
    // `search` without refetching here — handleSearchChange below debounces
    // and fetches directly, so this effect only needs to react to offset
    // (pagination) changes.
  }, [offset]); // eslint-disable-line react-hooks/exhaustive-deps -- search intentionally excluded, see comment above

  const handleSearchChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    setSearch(val);
    setOffset(0);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => fetchUsers(val, 0), 400);
  };

  const closeConfirm = () => {
    const target = confirm?.returnFocusTo;
    setConfirm(null);
    // Return focus to the control that opened the confirm (#1367); a menu item is gone, its kebab is not.
    if (target) setTimeout(() => { if (target.isConnected) target.focus(); }, 0);
  };

  const applyPatch = async (
    userId: number,
    patch: Partial<Pick<AdminUser, "is_active" | "is_site_admin" | "can_access_all_content" | "must_change_password" | "has_completed_tour">>
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

  const confirmAndRun = (user: AdminUser, message: string, actionLabel: string, fn: () => void | Promise<void>) => {
    // Row actions in the menu unmount on select, so the focused opener is gone by the time the
    // confirm closes. Resolve the menu's trigger (aria-controls -> menu id) while it is open;
    // an inline button is its own trigger.
    const active = document.activeElement as HTMLElement | null;
    const menuId = active?.closest('[role="menu"]')?.id;
    const returnFocusTo = menuId
      ? Array.from(document.querySelectorAll<HTMLElement>("[aria-controls]")).find(
          (el) => el.getAttribute("aria-controls") === menuId,
        ) ?? null
      : active;
    setConfirm({
      userId: user.id,
      returnFocusTo,
      message,
      actionLabel,
      onConfirm: async () => {
        setConfirm(null);
        await fn();
      },
    });
  };

  const nameOf = (u: AdminUser) => u.display_name || u.username;

  const handleDeactivate = (user: AdminUser) => {
    if (user.owned_boards.length > 0) {
      // A user who owns boards: the confirm explains and opens the transfer dialog to collect targets.
      const n = user.owned_boards.length;
      confirmAndRun(
        user,
        `${nameOf(user)} owns ${n} ${n === 1 ? "board" : "boards"}. Choose a new owner for each before deactivating.`,
        "Transfer boards…",
        () => setOffboardingUser(user),
      );
      return;
    }
    confirmAndRun(
      user,
      `Deactivate ${nameOf(user)}? They will no longer be able to log in.`,
      "Deactivate",
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

  const handleMakeAdmin = (user: AdminUser) => {
    confirmAndRun(
      user,
      `Grant site admin to ${nameOf(user)}? They will have full access to this admin panel.`,
      "Make admin",
      () => applyPatch(user.id, { is_site_admin: true })
    );
  };

  const handleDemote = (user: AdminUser) => {
    confirmAndRun(
      user,
      `Remove site admin role from ${nameOf(user)}?`,
      "Demote admin",
      () => applyPatch(user.id, { is_site_admin: false })
    );
  };

  const handleGrantContentAccess = (user: AdminUser) => {
    confirmAndRun(
      user,
      `Grant "${nameOf(user)}" access to all boards and groups regardless of membership?`,
      "Grant access",
      () => applyPatch(user.id, { can_access_all_content: true })
    );
  };

  const handleClearLockout = (user: AdminUser) => {
    confirmAndRun(
      user,
      `Clear the login lockout for ${nameOf(user)}? They will be able to log in immediately, even if they are currently locked out.`,
      "Clear lockout",
      async () => {
        setActionError(null);
        try {
          const updated = await clearAdminUserLockout(user.id);
          setUsers((prev) => prev.map((u) => (u.id === user.id ? updated : u)));
        } catch (err: unknown) {
          const data = (err as { response?: { data?: { detail?: string } } }).response?.data;
          setActionError(data?.detail ?? "Action failed. Please try again.");
        }
      }
    );
  };

  const handleRevokeContentAccess = (user: AdminUser) => {
    confirmAndRun(
      user,
      `Revoke all-content access from ${nameOf(user)}? They will only see boards they are a member of.`,
      "Revoke access",
      () => applyPatch(user.id, { can_access_all_content: false })
    );
  };

  const handleRestartTour = async (user: AdminUser) => {
    if (restartingTourIds.has(user.id)) return;
    setActionError(null);
    setActionMessage(null);
    setRestartingTourIds((prev) => new Set(prev).add(user.id));
    try {
      const updated = await patchAdminUser(user.id, { has_completed_tour: false });
      setUsers((prev) => prev.map((u) => (u.id === user.id ? updated : u)));
      setActionMessage(
        `Tour will restart for ${nameOf(user)} on their next visit to a board.`
      );
      if (actionMessageTimerRef.current) clearTimeout(actionMessageTimerRef.current);
      actionMessageTimerRef.current = setTimeout(() => {
        setActionMessage(null);
        actionMessageTimerRef.current = null;
      }, 4000);
    } catch (err: unknown) {
      const data = (err as { response?: { data?: { detail?: string } } }).response?.data;
      setActionError(data?.detail ?? "Action failed. Please try again.");
    } finally {
      setRestartingTourIds((prev) => {
        const next = new Set(prev);
        next.delete(user.id);
        return next;
      });
    }
  };

  // A superuser account's activation, all-content access, forced password
  // change and lockout stay with superusers: the API answers 400 to anyone else
  // (admin_views.superuser_target_refusal, #1620). This only spares the admin
  // the round trip, and the deactivate path's transfer dialog before it; the
  // server check is what enforces the rule. Permission-gated, so the actions are
  // omitted rather than disabled (frontend/CLAUDE.md § "Permission-gated and
  // context-gated"), and the row says why in plain text (#1644). Tests for false,
  // not falsy: an actor whose status is unknown keeps the actions and gets the
  // server's answer, because hiding one the server permits is the worse mistake.
  // Make admin and Restart onboarding tour are not on the refused list and stay.
  const actorIsKnownNonSuperuser = currentUser.is_superuser === false;
  const isSuperuserOnlyRow = (u: AdminUser) =>
    u.is_superuser && actorIsKnownNonSuperuser;

  // The two highest-frequency actions (#1291) stay on the row on wider screens; on a phone they
  // move into the row's ⋯ menu with the rest, so nothing sits beside the row.
  const canToggleActive = (u: AdminUser) => u.id !== currentUser.id && !isSuperuserOnlyRow(u);
  // Demote is omitted on a superuser row: superuser status implies site admin and the API
  // refuses to clear it, so the action is context-gated out.
  const canToggleAdmin = (u: AdminUser) => u.id !== currentUser.id && !(u.is_site_admin && u.is_superuser);

  const buildOverflowItems = (u: AdminUser): OverflowItem[] => {
    const items: OverflowItem[] = [];

    if (isPhone) {
      if (canToggleAdmin(u)) {
        items.push(u.is_site_admin
          ? { id: "demote-admin", label: "Demote admin", onSelect: () => handleDemote(u) }
          : { id: "make-admin", label: "Make admin", onSelect: () => handleMakeAdmin(u) });
      }
      if (canToggleActive(u)) {
        items.push(u.is_active
          ? u.owned_boards.length > 0
            ? { id: "deactivate", label: "Transfer boards and deactivate…", onSelect: () => handleDeactivate(u), danger: true }
            : { id: "deactivate", label: "Deactivate", onSelect: () => handleDeactivate(u), danger: true }
          : { id: "reactivate", label: "Reactivate", onSelect: () => void applyPatch(u.id, { is_active: true }) });
      }
    }

    if (!isSuperuserOnlyRow(u)) {
      // Superuser status implies all-content access and the API refuses to
      // clear it on a superuser, so Revoke is omitted (not disabled) for those
      // rows: a context-gated action is left out of the DOM (frontend/CLAUDE.md
      // § "Permission-gated and context-gated"). A superuser can still Grant.
      //
      // Only a superuser grants all-content, on any row, while a site admin can
      // still revoke it (#1830). The API refuses anyone else; this hides only on
      // a known false, for the reason given above isSuperuserOnlyRow.
      if (!u.can_access_all_content) {
        if (!actorIsKnownNonSuperuser) {
          items.push({
            id: "grant-all-content",
            label: "Grant all-content",
            onSelect: () => handleGrantContentAccess(u),
          });
        }
      } else if (!u.is_superuser) {
        items.push({
          id: "revoke-all-content",
          label: "Revoke all-content",
          onSelect: () => handleRevokeContentAccess(u),
        });
      }

      if (!u.must_change_password) {
        items.push({
          id: "force-reset",
          label: "Force password reset",
          onSelect: () => applyPatch(u.id, { must_change_password: true }),
        });
      }

      items.push({
        id: "clear-lockout",
        label: "Clear lockout",
        onSelect: () => handleClearLockout(u),
      });
    }

    // Restart onboarding tour (#1280) — hidden once the user is already in
    // the target state (tour not completed), since there's nothing left to
    // reset. See handleRestartTour for the shared-copy rule.
    if (u.has_completed_tour) {
      const restarting = restartingTourIds.has(u.id);
      items.push({
        id: "restart-tour",
        label: restarting ? "Restarting…" : "Restart onboarding tour",
        disabled: restarting,
        onSelect: () => handleRestartTour(u),
      });
    }

    return items;
  };

  const totalPages = Math.ceil(total / pageSize);
  const first = total === 0 ? 0 : offset + 1;
  const last = Math.min(offset + users.length, total);

  return (
    <>
      <PageHeading
        title="Users"
        description="Add people, change roles, and deactivate accounts."
        actions={
          <>
            <Button variant="secondary" onClick={() => setShowAddModal(true)}>Add user</Button>
            <Button variant="primary" onClick={() => setShowInvite((v) => !v)} aria-expanded={showInvite}>Invite people</Button>
          </>
        }
      />

      {showInvite && (
        <SettingsCard title="Invite people">
          <div className="max-w-lg">
            <EmailInviteForm
              surface="site"
              send={sendAdminInviteEmail}
              onOpenEmailSettings={onOpenEmailSettings}
            />
          </div>
        </SettingsCard>
      )}

      <div>
        <label htmlFor="admin-user-search" className="sr-only">Search users</label>
        <input
          id="admin-user-search"
          type="search"
          value={search}
          onChange={handleSearchChange}
          placeholder="Search by name, email or username"
          className="w-full max-w-md h-9 max-sm:h-11 bg-surface border border-line-strong text-fg placeholder-fg-muted rounded px-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
        />
      </div>

      <div role="status" aria-live="polite">
        {actionError && <p className="text-sm text-danger">{actionError}</p>}
        {actionMessage && <p className="text-sm text-success">{actionMessage}</p>}
      </div>

      {loading ? (
        <div className="text-fg-tertiary text-sm">Loading…</div>
      ) : error ? (
        <LoadError message={error} onRetry={() => void fetchUsers(search, offset)} />
      ) : (
        <>
          {users.length === 0 ? (
            <EmptyState
              title={searched ? `No users match "${searched}".` : "No users found."}
              description={searched ? "Check the spelling, or clear the filter." : undefined}
              headingLevel="h3"
            />
          ) : (
            <ListWell as="ul" label="Users">
              {users.map((u) => {
                const isYou = u.id === currentUser.id;
                return (
                  <li key={u.id}>
                    <ListRow as="div">
                      <Avatar user={u} size="sm" />
                      <div className="min-w-0 flex-1 flex flex-col md:flex-row md:items-center md:gap-4">
                        <div className="min-w-0 md:w-72">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <span className="text-fg font-medium">
                              {u.display_name || u.first_name || u.username}
                            </span>
                            {isYou && (
                              <span className="px-2 py-0.5 text-xs rounded-full bg-surface-hover text-fg-secondary">You</span>
                            )}
                            {u.is_site_admin && (
                              <span className="px-2 py-0.5 text-xs rounded-full bg-primary-emphasis/20 text-info-on-tint">
                                Admin
                              </span>
                            )}
                            {u.is_superuser && (
                              <span className="px-1.5 py-0.5 text-xs rounded-full bg-surface-hover text-fg-secondary">
                                Superuser
                              </span>
                            )}
                            {u.can_access_all_content && (
                              <span className="px-1.5 py-0.5 text-xs rounded-full bg-accent-violet/20 text-accent-violet">
                                All content
                              </span>
                            )}
                            {u.must_change_password && (
                              <span className="px-1.5 py-0.5 text-xs rounded-full bg-warning/20 text-warning-on-tint">
                                Reset req.
                              </span>
                            )}
                          </div>
                          <span className="text-xs text-fg-secondary">@{u.username}</span>
                        </div>
                        <span className="min-w-0 truncate text-fg-secondary md:flex-1" title={u.email}>{u.email}</span>
                        <span className="text-xs text-fg-secondary md:w-28">{formatDate(u.date_joined)}</span>
                      </div>
                      {u.is_active ? <StatusPill tone="on_track" label="Active" /> : <StatusPill tone="at_risk" label="Deactivated" />}
                      <div className="flex items-center gap-1">
                        {!isPhone && (
                          <>
                            {/* Deactivate / Reactivate and Make / Demote admin stay on the row (#1291). */}
                            {canToggleActive(u) && (
                              u.is_active ? (
                                <Button variant="quiet" aria-label={`Deactivate ${nameOf(u)}`} onClick={() => handleDeactivate(u)}>
                                  Deactivate
                                </Button>
                              ) : (
                                <Button variant="quiet" aria-label={`Reactivate ${nameOf(u)}`} onClick={() => void applyPatch(u.id, { is_active: true })}>
                                  Reactivate
                                </Button>
                              )
                            )}
                            {canToggleAdmin(u) && (
                              u.is_site_admin ? (
                                <Button variant="quiet" aria-label={`Demote admin ${nameOf(u)}`} onClick={() => handleDemote(u)}>
                                  Demote admin
                                </Button>
                              ) : (
                                <Button variant="quiet" aria-label={`Make admin ${nameOf(u)}`} onClick={() => handleMakeAdmin(u)}>
                                  Make admin
                                </Button>
                              )
                            )}
                          </>
                        )}
                        {isSuperuserOnlyRow(u) && (
                          <span
                            id={`superuser-row-note-${u.id}`}
                            className="text-xs text-fg-secondary max-w-xs"
                          >
                            Only a superuser can change this account's access or sign-in.
                          </span>
                        )}
                        {/* The support actions live behind this menu (#1291). OverflowMenu renders
                            nothing when a row has no applicable actions (#1644). */}
                        <OverflowMenu
                          items={buildOverflowItems(u)}
                          ariaLabel={`More actions for ${nameOf(u)}`}
                          triggerDescribedBy={
                            isSuperuserOnlyRow(u) ? `superuser-row-note-${u.id}` : undefined
                          }
                        />
                      </div>
                    </ListRow>
                    {confirm?.userId === u.id && (
                      <div className="px-3 pb-2">
                        <InlineConfirm
                          message={confirm.message}
                          actionLabel={confirm.actionLabel}
                          onConfirm={() => void confirm.onConfirm()}
                          onCancel={closeConfirm}
                        />
                      </div>
                    )}
                  </li>
                );
              })}
            </ListWell>
          )}

          <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-fg-secondary">
            <span>Showing {first}–{last} of {total}</span>
            {totalPages > 1 && (
              <div className="flex items-center gap-2">
                <Button
                  variant="quiet"
                  onClick={() => setOffset((o) => Math.max(0, o - pageSize))}
                  disabled={offset === 0}
                >
                  Previous
                </Button>
                <Button
                  variant="quiet"
                  onClick={() => setOffset((o) => Math.min((totalPages - 1) * pageSize, o + pageSize))}
                  disabled={offset + pageSize >= total}
                >
                  Next
                </Button>
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
            onTotal(total + 1);
            setShowAddModal(false);
          }}
          onClose={() => setShowAddModal(false)}
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
    </>
  );
}

// ---------------------------------------------------------------------------
// AdminPage
// ---------------------------------------------------------------------------

export default function AdminPage({ user, onLogout, onUserUpdated }: Props) {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  // Nav counts: Users = total, Invite links = active links, Board invites = pending. Each starts
  // unknown and is filled by one load here, then kept current by the section that owns it.
  const [counts, setCounts] = useState<{ users?: number; links?: number; boardInvites?: number }>({});
  const setUsersCount = useCallback((n: number) => setCounts((c) => (c.users === n ? c : { ...c, users: n })), []);
  const setLinksCount = useCallback((n: number) => setCounts((c) => (c.links === n ? c : { ...c, links: n })), []);

  // The pre-#2476 "Settings" tab id (`?tab=settings`) is now General.
  useEffect(() => {
    if (searchParams.get("tab") === "settings") {
      const next = new URLSearchParams(searchParams);
      next.set("tab", "general");
      setSearchParams(next, { replace: true });
    }
  }, [searchParams, setSearchParams]);

  useEscapeStack(() => {
    const tag = (document.activeElement as HTMLElement)?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return false;
    // void: navigate() can return a Promise in React Router v7; fire-and-forget,
    // there is nothing to roll back if the navigation itself rejects.
    if (window.history.length > 1) { void navigate(-1); return; }
    void navigate("/");
  }, 0);

  // Redirect non-admins immediately.
  useEffect(() => {
    if (!user.is_site_admin) {
      // void: fire-and-forget redirect, see useEscapeStack above.
      void navigate("/", { replace: true });
    }
  }, [user.is_site_admin, navigate]);

  // Counts for the sections the visitor has not opened yet (the open one reports its own).
  useEffect(() => {
    if (!user.is_site_admin) return;
    let live = true;
    const quiet = <T,>(p: Promise<T> | undefined, apply: (v: T) => void) => {
      void Promise.resolve(p).then((v) => { if (live && v) apply(v); }).catch(() => { /* a missing count just stays hidden */ });
    };
    quiet(getAdminUsers({ offset: 0 }), (d) => setUsersCount(d.count));
    quiet(getAdminInviteLinksPage(), (d) => setLinksCount(d.links.filter((l) => l.status === "pending").length));
    quiet(getAdminBoardInviteLinks({ status: "pending", offset: 0 }), (d) => setCounts((c) => ({ ...c, boardInvites: d.count })));
    return () => { live = false; };
  }, [user.is_site_admin, setUsersCount, setLinksCount]);

  if (!user.is_site_admin) return null;

  const openEmailSettings = () => {
    const next = new URLSearchParams(searchParams);
    next.set("tab", "email");
    setSearchParams(next);
  };

  const sections: SettingsSection[] = [
    {
      id: "general",
      label: "General",
      group: "Instance",
      keywords: ["registration", "uploads", "maintenance", "maintenance mode", "file uploads", "notice"],
      render: () => <GeneralSection />,
    },
    {
      id: "email",
      label: "Email",
      group: "Instance",
      keywords: ["smtp", "mail", "host", "port", "encryption", "from address", "test email"],
      render: () => <EmailSettingsSection currentUser={user} />,
    },
    {
      id: "users",
      label: "Users",
      group: "People",
      count: counts.users,
      keywords: ["accounts", "admins", "deactivate", "password", "lockout", "add user", "invite people"],
      render: () => <UsersSection currentUser={user} onTotal={setUsersCount} onOpenEmailSettings={openEmailSettings} />,
    },
    {
      id: "invite_links",
      label: "Invite links",
      group: "People",
      count: counts.links,
      keywords: ["join", "share", "link", "expires", "single-use"],
      render: () => <InviteLinksSection onActiveCount={setLinksCount} />,
    },
    {
      id: "board_invites",
      label: "Board invites",
      group: "People",
      count: counts.boardInvites,
      keywords: ["board", "revoke", "pending"],
      render: () => <BoardInvitesTab onPendingCount={(n) => setCounts((c) => ({ ...c, boardInvites: n }))} />,
    },
  ];

  return (
    <div className="h-full bg-sunken flex flex-col">
      <Navbar user={user} onLogout={onLogout} onUserUpdated={onUserUpdated} breadcrumb={[{ label: "Site admin" }]} />

      <main className="flex-1 overflow-y-auto">
        {/* h2 under the app shell, whose header owns the h1 (#2473). */}
        <SettingsLayout
          title={<PageHeading title="Site administration" description="Manage this instance and the people who use it." />}
          sections={sections}
          navLabel="Site administration sections"
        />
      </main>
    </div>
  );
}
