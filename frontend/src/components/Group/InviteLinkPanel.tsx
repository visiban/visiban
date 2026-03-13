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
  viewer: "Viewer",
};

const ROLE_COLORS: Record<string, string> = {
  admin: "bg-purple-600 text-purple-100",
  member: "bg-blue-600 text-blue-100",
  viewer: "bg-slate-600 text-slate-200",
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

export default function InviteLinkPanel({ groupId }: Props) {
  const [links, setLinks] = useState<GroupInviteLink[]>([]);
  const [loading, setLoading] = useState(true);
  const [copiedId, setCopiedId] = useState<number | null>(null);

  // New link form state
  const [showForm, setShowForm] = useState(false);
  const [formName, setFormName] = useState("");
  const [formRole, setFormRole] = useState<"member" | "viewer">("member");
  const [formExpiry, setFormExpiry] = useState<number | null>(7);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

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
    const url = `${window.location.origin}/join/${link.token}`;
    navigator.clipboard.writeText(url);
    setCopiedId(link.id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  const handleRevoke = async (link: GroupInviteLink) => {
    const displayName = link.name || "this link";
    if (!confirm(`Revoke "${displayName}"? Anyone who has it will no longer be able to join.`)) return;
    await revokeInviteLink(groupId, link.id);
    setLinks((prev) => prev.filter((l) => l.id !== link.id));
  };

  const handleCreate = async () => {
    setCreateError(null);
    setCreating(true);
    try {
      const newLink = await createInviteLink(groupId, {
        name: formName.trim() || undefined,
        role: formRole,
        expiry_days: formExpiry,
      });
      setLinks((prev) => [...prev, newLink]);
      setShowForm(false);
      setFormName("");
      setFormRole("member");
      setFormExpiry(7);
    } catch (err: unknown) {
      const detail =
        (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
      setCreateError(detail ?? "Failed to create invite link.");
    } finally {
      setCreating(false);
    }
  };

  const atLimit = links.length >= MAX_LINKS;

  return (
    <div className="bg-slate-800 border border-slate-700 rounded-xl p-4 flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-slate-300">Invite links</h3>
        {!atLimit && !showForm && (
          <button
            onClick={() => setShowForm(true)}
            className="text-xs bg-blue-600 text-white px-3 py-1.5 rounded-lg hover:bg-blue-700 transition"
          >
            New link
          </button>
        )}
      </div>

      {loading ? (
        <p className="text-xs text-slate-500">Loading…</p>
      ) : links.length === 0 ? (
        <p className="text-xs text-slate-500">No active invite links.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {links.map((link) => (
            <li
              key={link.id}
              className={`flex flex-col gap-1.5 p-3 rounded-lg border ${
                link.is_expired
                  ? "border-red-800 bg-slate-900/50 opacity-70"
                  : "border-slate-700 bg-slate-900"
              }`}
            >
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-xs font-medium text-slate-200 truncate flex-1">
                  {link.name || "Default"}
                </span>
                <span
                  className={`text-[10px] font-semibold px-1.5 py-0.5 rounded ${ROLE_COLORS[link.role] ?? ROLE_COLORS.member}`}
                >
                  {ROLE_LABELS[link.role] ?? link.role}
                </span>
                <span
                  className={`text-[10px] ${link.is_expired ? "text-red-400 font-semibold" : "text-slate-500"}`}
                >
                  {formatExpiry(link)}
                </span>
              </div>
              <div className="flex gap-2">
                <input
                  readOnly
                  value={`${window.location.origin}/join/${link.token}`}
                  className="flex-1 text-[11px] bg-slate-800 border border-slate-700 rounded px-2 py-1 text-slate-400 outline-none"
                />
                <button
                  onClick={() => handleCopy(link)}
                  disabled={link.is_expired}
                  className="text-[11px] bg-blue-600 text-white px-2 py-1 rounded hover:bg-blue-700 disabled:opacity-40 transition whitespace-nowrap"
                >
                  {copiedId === link.id ? "Copied!" : "Copy"}
                </button>
                <button
                  onClick={() => handleRevoke(link)}
                  className="text-[11px] text-red-400 hover:text-red-300 transition whitespace-nowrap"
                >
                  Revoke
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {atLimit && !showForm && (
        <p className="text-xs text-amber-400">
          Maximum of {MAX_LINKS} active invite links reached. Revoke a link to create a new one.
        </p>
      )}

      {showForm && (
        <div className="flex flex-col gap-3 border border-slate-700 rounded-lg p-3 bg-slate-900">
          <p className="text-xs font-semibold text-slate-300">New invite link</p>

          <div className="flex flex-col gap-1">
            <label className="text-[11px] text-slate-400">Name (optional)</label>
            <input
              type="text"
              value={formName}
              onChange={(e) => setFormName(e.target.value)}
              placeholder="e.g. Engineering onboarding"
              maxLength={100}
              className="text-xs bg-slate-800 border border-slate-700 rounded px-2 py-1.5 text-slate-200 outline-none placeholder:text-slate-600"
            />
          </div>

          <div className="flex gap-3">
            <div className="flex flex-col gap-1 flex-1">
              <label className="text-[11px] text-slate-400">Role</label>
              <SelectDropdown
                value={formRole}
                onChange={(v) => setFormRole(v as "member" | "viewer")}
                options={[
                  { value: "member", label: "Member" },
                  { value: "viewer", label: "Viewer" },
                ]}
                size="xs"
              />
            </div>

            <div className="flex flex-col gap-1 flex-1">
              <label className="text-[11px] text-slate-400">Expires</label>
              <SelectDropdown
                value={formExpiry === null ? "null" : String(formExpiry)}
                onChange={(v) => setFormExpiry(v === "null" ? null : Number(v))}
                options={EXPIRY_OPTIONS.map((opt) => ({
                  value: String(opt.value),
                  label: opt.label,
                  separatorBefore: opt.value === null,
                }))}
                size="xs"
              />
            </div>
          </div>

          {createError && <p className="text-[11px] text-red-400">{createError}</p>}

          <div className="flex gap-2 justify-end">
            <button
              onClick={() => {
                setShowForm(false);
                setCreateError(null);
              }}
              className="text-xs text-slate-400 hover:text-slate-300 px-3 py-1.5 transition"
            >
              Cancel
            </button>
            <button
              onClick={handleCreate}
              disabled={creating}
              className="text-xs bg-blue-600 text-white px-4 py-1.5 rounded-lg hover:bg-blue-700 disabled:opacity-50 transition"
            >
              {creating ? "Creating…" : "Create link"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
