import { useState, useEffect, useCallback } from "react";
import { listInviteLinks, createInviteLink, revokeInviteLink } from "../../api/groups";
import type { GroupInviteLink } from "../../types";
import SelectDropdown from "../Common/SelectDropdown";

interface Props {
  groupId: number;
}

const ROLE_LABELS: Record<string, string> = {
  admin: "Admin",
  member: "Member",
  collaborator: "Collaborator",
  viewer: "Viewer",
};

const ROLE_COLORS: Record<string, string> = {
  admin: "bg-purple-600 text-purple-100",
  member: "bg-blue-600 text-blue-100",
  collaborator: "bg-teal-600 text-teal-100",
  viewer: "bg-surface-active text-fg",
};

const STATUS_LABELS: Record<string, string> = {
  used: "Used",
  expired: "Expired",
  revoked: "Revoked",
};

const STATUS_COLORS: Record<string, string> = {
  used: "bg-surface-hover text-fg-tertiary",
  expired: "bg-red-900/60 text-danger",
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

export default function InviteLinkPanel({ groupId }: Props) {
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

  const fetchLinks = useCallback(async () => {
    setLoading(true);
    try {
      const data = await listInviteLinks(groupId);
      setLinks(data);
    } finally {
      setLoading(false);
    }
  }, [groupId]);

  useEffect(() => {
    fetchLinks();
  }, [fetchLinks]);

  const handleCopy = (link: GroupInviteLink) => {
    // For just-created links with raw token, copy the full join URL
    if (link.token) {
      const url = `${window.location.origin}/join/${link.token}`;
      navigator.clipboard.writeText(url);
    }
    setCopiedId(link.id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  const handleDismissReveal = (linkId: number) => {
    // Clear the raw token from client-side state
    setLinks((prev) =>
      prev.map((l) => (l.id === linkId ? { ...l, token: undefined } : l))
    );
    setRevealId(null);
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

  // Active links exclude consumed single-use links (they're dead weight against the cap).
  const activeCount = links.filter(
    (l) => l.is_active && !l.used_at
  ).length;
  const atLimit = activeCount >= MAX_LINKS;

  return (
    <div className="bg-surface border border-line rounded-xl p-4 flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-fg-secondary">Invite links</h3>
        {!atLimit && !showForm && (
          <button
            onClick={() => setShowForm(true)}
            className="text-xs bg-blue-600 text-white px-3 py-1.5 rounded hover:bg-blue-700 transition focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            New link
          </button>
        )}
      </div>

      {loading ? (
        <p className="text-xs text-fg-muted">Loading…</p>
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
              if (linkStatus === "expired") return "border-red-800 bg-sunken/50 opacity-70";
              // pending
              if (link.single_use ?? false) return "border-amber-700/40 bg-sunken";
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
                    className={`text-[10px] font-semibold px-1.5 py-0.5 rounded ${ROLE_COLORS[link.role] ?? ROLE_COLORS.member}`}
                  >
                    {ROLE_LABELS[link.role] ?? link.role}
                  </span>

                  {/* Status badge — shown for non-pending states */}
                  {linkStatus !== "pending" && (
                    <span
                      className={`text-[10px] font-semibold px-1.5 py-0.5 rounded ${STATUS_COLORS[linkStatus]}`}
                    >
                      {STATUS_LABELS[linkStatus]}
                    </span>
                  )}

                  {/* Expiry text — replaced by used_at when consumed */}
                  {linkStatus !== "used" && (
                    <span
                      className={`text-[10px] ${link.is_expired ? "text-danger font-semibold" : "text-fg-muted"}`}
                    >
                      {formatExpiry(link)}
                    </span>
                  )}

                  {/* Used-at date — only when consumed */}
                  {linkStatus === "used" && link.used_at && (
                    <span className="text-[10px] text-fg-muted">
                      Used {formatUsedAt(link.used_at)}
                    </span>
                  )}

                  {/* 1-use indicator — only for live single-use links */}
                  {linkStatus === "pending" && (link.single_use ?? false) && (
                    <span className="text-[10px] text-amber-500">1-use</span>
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
                        onClick={() => handleCopy(link)}
                        className="text-xs bg-blue-600 text-white px-3 py-1.5 rounded hover:bg-blue-700 transition focus:outline-none focus:ring-2 focus:ring-blue-500"
                      >
                        {copiedId === link.id ? "Copied!" : "Copy"}
                      </button>
                      <button
                        onClick={() => handleDismissReveal(link.id)}
                        className="text-xs text-fg-tertiary hover:text-fg-secondary px-3 py-1.5 transition"
                      >
                        Done
                      </button>
                    </div>
                  </div>
                ) : !isTerminal ? (
                  /* Normal display — prefix only + revoke */
                  <div className="flex gap-2">
                    <div className="flex-1 text-[11px] bg-surface border border-line rounded px-2 py-1 text-fg-tertiary truncate font-mono">
                      {link.prefix}…
                    </div>
                    {confirmRevokeId === link.id ? (
                      <div className="flex items-center gap-1 shrink-0">
                        <button onClick={() => handleRevoke(link.id)} className="text-[11px] text-danger hover:text-danger transition whitespace-nowrap focus:outline-none focus:ring-1 focus:ring-red-500 rounded px-1">Revoke</button>
                        <button onClick={() => setConfirmRevokeId(null)} className="text-[11px] text-fg-muted hover:text-fg-secondary transition whitespace-nowrap focus:outline-none focus:ring-1 focus:ring-fg-muted rounded px-1">Cancel</button>
                      </div>
                    ) : (
                      <button
                        onClick={() => setConfirmRevokeId(link.id)}
                        className="text-[11px] text-danger hover:text-danger transition whitespace-nowrap"
                      >
                        Revoke
                      </button>
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
            <label className="text-[11px] text-fg-tertiary">Name (optional)</label>
            <input
              type="text"
              value={formName}
              onChange={(e) => setFormName(e.target.value)}
              placeholder="e.g. Engineering onboarding"
              maxLength={100}
              className="text-xs bg-surface border border-line rounded px-2 py-1.5 text-fg-secondary focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent placeholder:text-fg-muted"
            />
          </div>

          <div className="flex gap-3">
            <div className="flex flex-col gap-1 flex-1">
              <label className="text-[11px] text-fg-tertiary">Role</label>
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
              <label className="text-[11px] text-fg-tertiary">Expires</label>
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
          <label className="flex items-center justify-between cursor-pointer">
            <div className="min-w-0 pr-4">
              <span className="text-xs text-fg-secondary">Single use</span>
              <p className="text-xs text-fg-muted mt-0.5">Link expires after one person joins.</p>
            </div>
            <input
              type="checkbox"
              checked={formSingleUse}
              onChange={(e) => setFormSingleUse(e.target.checked)}
              className="w-4 h-4 rounded accent-blue-500 shrink-0"
            />
          </label>

          {/* Reserved error slot — always rendered to prevent layout shift */}
          <p className="text-[11px] h-4">
            {createError && <span className="text-danger">{createError}</span>}
          </p>

          <div className="flex gap-2 justify-end">
            <button
              onClick={() => {
                setShowForm(false);
                setCreateError(null);
                setFormSingleUse(false);
              }}
              className="text-xs text-fg-tertiary hover:text-fg-secondary px-3 py-1.5 transition"
            >
              Cancel
            </button>
            <button
              onClick={handleCreate}
              disabled={creating}
              className="text-xs bg-blue-600 text-white px-4 py-1.5 rounded hover:bg-blue-700 disabled:opacity-40 transition focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              {creating ? "Creating…" : "Create link"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
