import { useState, useEffect, useCallback, useRef } from "react";
import { useEscapeStack } from "../../hooks/useEscapeStack";
import { useConfirmFocusReturn } from "../../hooks/useConfirmFocusReturn";
import { listInviteLinks, createInviteLink, revokeInviteLink } from "../../api/groups";
import type { GroupInviteLink } from "../../types";
import SelectDropdown from "../Common/SelectDropdown";
import { ToggleField } from "../Common/Toggle";
import Spinner from "../Common/Spinner";

interface Props {
  groupId: number;
  /** Bumped by the parent on an invite_link.revoked socket event to trigger a
   *  refetch so another admin's revoke converges here in real time (#1051). */
  reloadSignal?: number;
}

const ROLE_LABELS: Record<string, string> = {
  admin: "Admin",
  member: "Member",
  collaborator: "Collaborator",
  viewer: "Viewer",
};

const ROLE_COLORS: Record<string, string> = {
  admin: "bg-palette-purple text-palette-purple-pale",
  member: "bg-primary text-info",
  collaborator: "bg-palette-teal text-palette-teal-pale",
  viewer: "bg-surface-active text-fg",
};

const STATUS_LABELS: Record<string, string> = {
  used: "Used",
  expired: "Expired",
  revoked: "Revoked",
};

const STATUS_COLORS: Record<string, string> = {
  used: "bg-surface-hover text-fg-tertiary",
  expired: "bg-danger/60 text-danger",
  revoked: "bg-surface-hover text-fg-muted",
};

const EXPIRY_OPTIONS = [
  { label: "1 day", value: 1 },
  { label: "7 days", value: 7 },
  { label: "30 days", value: 30 },
  { label: "Never", value: null },
];

const MAX_LINKS = 5;

function formatExpiry(link: GroupInviteLink): string {
  if (link.is_expired) return "Expired";
  if (!link.expires_at) return "Never";
  const d = new Date(link.expires_at);
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function formatUsedAt(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/** Derive effective status for backward compatibility with older API responses. */
function effectiveStatus(link: GroupInviteLink): GroupInviteLink["status"] {
  return link.status ?? (link.is_expired ? "expired" : "pending");
}

export default function InviteLinkPanel({ groupId, reloadSignal }: Props) {
  const [links, setLinks] = useState<GroupInviteLink[]>([]);
  const [loading, setLoading] = useState(true);
  const [copiedId, setCopiedId] = useState<number | null>(null);

  // Track which link was just created and has its raw token available
  const [revealId, setRevealId] = useState<number | null>(null);

  // New link form state
  const [showForm, setShowForm] = useState(false);
  const [formName, setFormName] = useState("");
  const [formRole, setFormRole] = useState<"admin" | "member" | "collaborator" | "viewer">("member");
  const [formExpiry, setFormExpiry] = useState<number | null>(7);
  const [formSingleUse, setFormSingleUse] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [confirmRevokeId, setConfirmRevokeId] = useState<number | null>(null);
  const revokeTriggerRef = useConfirmFocusReturn(confirmRevokeId);
  const [loadError, setLoadError] = useState(false);
  const [copyErrorId, setCopyErrorId] = useState<number | null>(null);

  // Escape cancels the open revoke prompt before the host page's priority-0
  // Escape-to-navigate handler (GroupDetail, its only host) can leave the page (#1238).
  useEscapeStack(() => {
    if (confirmRevokeId !== null) { setConfirmRevokeId(null); return; }
    return false;
  }, 40);

  // Clear the "Copied!" feedback timer on unmount so setCopiedId(null) never
  // runs after teardown (#870).
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    return () => {
      if (copiedTimerRef.current !== null) {
        clearTimeout(copiedTimerRef.current);
        copiedTimerRef.current = null;
      }
    };
  }, []);

  const fetchLinks = useCallback(async () => {
    setLoading(true);
    setLoadError(false);
    try {
      const data = await listInviteLinks(groupId);
      setLinks(data);
    } catch {
      // Previously unhandled: a failed load left `links` at its prior value
      // (empty on first mount) with no indication anything went wrong — the
      // empty state silently read as "no invite links" (#1375).
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, [groupId]);

  useEffect(() => {
    // void: fetchLinks catches its own rejection above and surfaces it via loadError.
    void fetchLinks();
  }, [fetchLinks]);

  // Refetch when the parent signals an invite_link.revoked socket event so the
  // panel converges with another admin's revoke without a manual reload (#1051).
  const didMountRef = useRef(false);
  useEffect(() => {
    if (!didMountRef.current) {
      didMountRef.current = true;
      return;
    }
    void fetchLinks();
  }, [reloadSignal, fetchLinks]);

  const handleCopy = async (link: GroupInviteLink) => {
    // For just-created links with raw token, copy the full join URL
    if (link.token) {
      const url = `${window.location.origin}/join/${link.token}`;
      try {
        await navigator.clipboard.writeText(url);
      } catch {
        // Previously: the "Copied!" confirmation showed unconditionally even
        // when the write itself failed (clipboard permission denied, insecure
        // context, etc.), telling the user the wrong thing (#1375).
        setCopyErrorId(link.id);
        return;
      }
    }
    setCopyErrorId(null);
    setCopiedId(link.id);
    if (copiedTimerRef.current !== null) {
      clearTimeout(copiedTimerRef.current);
    }
    copiedTimerRef.current = setTimeout(() => {
      setCopiedId(null);
      copiedTimerRef.current = null;
    }, 2000);
  };

  const handleDismissReveal = (linkId: number) => {
    // Clear the raw token from client-side state
    setLinks((prev) =>
      prev.map((l) => (l.id === linkId ? { ...l, token: undefined } : l))
    );
    setRevealId(null);
    setCopyErrorId((prev) => (prev === linkId ? null : prev));
  };

  const handleRevoke = async (linkId: number) => {
    setConfirmRevokeId(null);
    await revokeInviteLink(groupId, linkId);
    // Keep the revoked link visible with status="revoked" rather than removing it.
    setLinks((prev) =>
      prev.map((l) => (l.id === linkId ? { ...l, is_active: false, status: "revoked" as const } : l))
    );
    if (revealId === linkId) setRevealId(null);
  };

  const handleCreate = async () => {
    setCreateError(null);
    setCreating(true);
    try {
      const newLink = await createInviteLink(groupId, {
        name: formName.trim() || undefined,
        role: formRole,
        expiry_days: formExpiry,
        single_use: formSingleUse,
      });
      setLinks((prev) => [...prev, newLink]);
      setRevealId(newLink.id);
      setShowForm(false);
      setFormName("");
      setFormRole("member");
      setFormExpiry(7);
      setFormSingleUse(false);
    } catch (err: unknown) {
      const detail =
        (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
      setCreateError(detail ?? "Failed to create invite link.");
    } finally {
      setCreating(false);
    }
  };

  // Active links exclude consumed single-use links (they're dead weight against the cap)
  // and emailed links (#731), which the backend caps separately.
  const activeCount = links.filter(
    (l) => l.is_active && !l.used_at && l.delivery !== "email"
  ).length;
  const atLimit = activeCount >= MAX_LINKS;

  return (
    <div className="bg-surface border border-line rounded-lg p-4 flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-fg-secondary">Invite links</h3>
        {!atLimit && !showForm && (
          <button
            onClick={() => setShowForm(true)}
            className="text-xs bg-button-primary text-on-primary px-3 py-1.5 rounded hover:bg-button-primary-hover transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis font-medium"
          >
            New link
          </button>
        )}
      </div>

      {loading ? (
        <Spinner />
      ) : loadError ? (
        <div className="text-center py-2">
          <p role="alert" className="text-xs text-danger mb-2">Failed to load invite links.</p>
          <button
            onClick={() => void fetchLinks()}
            className="text-xs text-fg-secondary hover:text-fg hover:bg-surface-hover px-2 py-1 rounded focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
          >
            Try again
          </button>
        </div>
      ) : links.length === 0 ? (
        <p className="text-xs text-fg-muted">No invite links.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {links.map((link) => {
            const isRevealing = revealId === link.id && link.token;
            const linkStatus = effectiveStatus(link);
            const isTerminal = linkStatus === "used" || linkStatus === "revoked";

            const rowClasses = (() => {
              if (isRevealing) return "border-warning/50 bg-sunken";
              if (linkStatus === "revoked") return "border-line bg-sunken/50 opacity-60";
              if (linkStatus === "used") return "border-line bg-sunken/50 opacity-75";
              if (linkStatus === "expired") return "border-danger/40 bg-sunken/50 opacity-70";
              // pending
              if (link.single_use ?? false) return "border-warning/40 bg-sunken";
              return "border-line bg-sunken";
            })();

            return (
              <li
                key={link.id}
                className={`flex flex-col gap-1.5 p-3 rounded-lg border transition-all duration-150 ${rowClasses}`}
              >
                {/* Row 1 — name + badges */}
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-xs font-medium text-fg truncate flex-1">
                    {link.name || "Default"}
                  </span>
                  <span
                    className={`text-xs font-semibold px-1.5 py-0.5 rounded ${ROLE_COLORS[link.role] ?? ROLE_COLORS.member}`}
                  >
                    {ROLE_LABELS[link.role] ?? link.role}
                  </span>

                  {/* Status badge — shown for non-pending states */}
                  {linkStatus !== "pending" && (
                    <span
                      className={`text-xs font-semibold px-1.5 py-0.5 rounded ${STATUS_COLORS[linkStatus]}`}
                    >
                      {STATUS_LABELS[linkStatus]}
                    </span>
                  )}

                  {/* Expiry text — replaced by used_at when consumed */}
                  {linkStatus !== "used" && (
                    <span
                      className={`text-xs ${link.is_expired ? "text-danger font-semibold" : "text-fg-muted"}`}
                    >
                      {formatExpiry(link)}
                    </span>
                  )}

                  {/* Used-at date — only when consumed */}
                  {linkStatus === "used" && link.used_at && (
                    <span className="text-xs text-fg-muted">
                      Used {formatUsedAt(link.used_at)}
                    </span>
                  )}

                  {/* 1-use indicator — only for live single-use links */}
                  {linkStatus === "pending" && (link.single_use ?? false) && (
                    <span className="text-xs text-warning">1-use</span>
                  )}
                </div>

                {/* Row 2 — token reveal or prefix + revoke (hidden for terminal states) */}
                {isRevealing ? (
                  /* One-time token reveal */
                  <div className="flex flex-col gap-2">
                    <p className="text-xs text-warning">
                      Copy this link now — it won't be shown again.
                    </p>
                    <div
                      className="font-mono text-xs bg-sunken border border-warning/50 rounded px-2 py-1.5 text-fg truncate"
                      title={`${window.location.origin}/join/${link.token}`}
                    >
                      {`${window.location.origin}/join/${link.token}`}
                    </div>
                    <div className="flex gap-2">
                      <button
                        // void: handleCopy now catches its own rejection and surfaces it via copyErrorId.
                        onClick={() => void handleCopy(link)}
                        className="text-xs bg-button-primary text-on-primary px-3 py-1.5 rounded hover:bg-button-primary-hover transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis font-medium"
                      >
                        {copyErrorId === link.id ? "Failed — try again" : copiedId === link.id ? "Copied!" : "Copy"}
                      </button>
                      <button
                        onClick={() => handleDismissReveal(link.id)}
                        className="text-xs text-fg-tertiary hover:text-fg-secondary px-3 py-1.5 rounded transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
                      >
                        Done
                      </button>
                    </div>
                  </div>
                ) : !isTerminal ? (
                  /* Normal display — prefix only + revoke */
                  <div className="flex flex-wrap gap-2">
                    <div className="flex-1 text-xs bg-surface border border-line rounded px-2 py-1 text-fg-tertiary truncate font-mono">
                      {link.prefix}…
                    </div>
                    {confirmRevokeId !== link.id && (
                      <button
                        ref={revokeTriggerRef(link.id)}
                        onClick={() => setConfirmRevokeId(link.id)}
                        className="text-xs text-danger hover:text-danger transition whitespace-nowrap focus:outline-none focus:ring-2 focus:ring-danger-emphasis rounded px-1"
                      >
                        Revoke
                      </button>
                    )}
                    {confirmRevokeId === link.id && (
                      /* BoardSettingsModal inline-confirm pattern (frontend/CLAUDE.md § Modals and dialogs) */
                      <div className="basis-full flex flex-wrap items-center gap-2 text-xs">
                        <span className="text-fg-tertiary">
                          Revoke this invite link? Anyone holding it will no longer be able to join.
                        </span>
                        <button
                          onClick={() => handleRevoke(link.id)}
                          className="text-danger hover:text-danger font-medium transition rounded focus:outline-none focus:ring-2 focus:ring-danger-emphasis"
                        >
                          Confirm
                        </button>
                        <button
                          onClick={() => setConfirmRevokeId(null)}
                          className="text-fg-tertiary hover:text-fg transition rounded focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
                        >
                          Cancel
                        </button>
                      </div>
                    )}
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}

      {atLimit && !showForm && (
        <p className="text-xs text-warning">
          Maximum of {MAX_LINKS} active invite links reached. Revoke a link to create a new one.
        </p>
      )}

      {showForm && (
        <div className="flex flex-col gap-3 border border-line rounded-lg p-3 bg-sunken">
          <p className="text-xs font-semibold text-fg-secondary">New invite link</p>

          <div className="flex flex-col gap-1">
            <label className="text-xs text-fg-tertiary">Name (optional)</label>
            <input
              type="text"
              value={formName}
              onChange={(e) => setFormName(e.target.value)}
              placeholder="e.g. Engineering onboarding"
              maxLength={100}
              className="text-xs bg-surface border border-line rounded px-2 py-1.5 text-fg-secondary focus:outline-none focus:ring-2 focus:ring-primary-emphasis focus:border-transparent placeholder:text-fg-muted"
            />
          </div>

          <div className="flex gap-3">
            <div className="flex flex-col gap-1 flex-1">
              <label className="text-xs text-fg-tertiary">Role</label>
              <SelectDropdown
                value={formRole}
                onChange={(v) => setFormRole(v as "admin" | "member" | "collaborator" | "viewer")}
                options={[
                  { value: "admin", label: "Admin" },
                  { value: "member", label: "Member" },
                  { value: "collaborator", label: "Collaborator" },
                  { value: "viewer", label: "Viewer" },
                ]}
                size="xs"
              />
            </div>

            <div className="flex flex-col gap-1 flex-1">
              <label className="text-xs text-fg-tertiary">Expires</label>
              <SelectDropdown
                value={formExpiry === null ? "null" : String(formExpiry)}
                onChange={(v) => setFormExpiry(v === "null" ? null : Number(v))}
                options={EXPIRY_OPTIONS.map((opt) => ({
                  value: String(opt.value),
                  label: opt.label,
                }))}
                size="xs"
              />
            </div>
          </div>

          {/* Single-use toggle */}
          <ToggleField
            label="Single use"
            description="Link expires after one person joins."
            labelSize="xs"
            checked={formSingleUse}
            onChange={setFormSingleUse}
          />

          {/* Reserved error slot — always rendered to prevent layout shift.
              h-4 matches text-xs's 1rem line-height so the slot doesn't clip. */}
          <p className="text-xs h-4">
            {createError && <span className="text-danger">{createError}</span>}
          </p>

          <div className="flex gap-3 items-center justify-end">
            <button
              onClick={() => {
                setShowForm(false);
                setCreateError(null);
                setFormSingleUse(false);
              }}
              className="text-xs text-fg-tertiary hover:text-fg-secondary px-3 py-1.5 rounded transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
            >
              Cancel
            </button>
            <button
              onClick={handleCreate}
              disabled={creating}
              className="text-xs bg-button-primary text-on-primary px-4 py-1.5 rounded hover:bg-button-primary-hover disabled:opacity-40 transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis font-medium"
            >
              {creating ? "Creating…" : "Create link"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
