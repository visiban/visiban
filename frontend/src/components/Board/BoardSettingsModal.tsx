import { useState, useEffect, useRef, Fragment } from "react";
import ModalWrapper from "../shared/ModalWrapper";
import SelectDropdown from "../Common/SelectDropdown";
import RoleInfoTooltip from "../Common/RoleInfoTooltip";
import type { BoardFull, BoardMembership, User } from "../../types";
import { userDisplayName } from "../../types";
import { exportBoardCsv, exportBoardJson, setBoardMember, removeBoardMember, deleteBoard, patchBoard, enableBoardSharing, disableBoardSharing, getBoardExportHistory } from "../../api/boards";
import type { BoardExportLogEntry, BoardExportMinRole } from "../../types";
import type { BoardRole } from "../../api/boards";
import { searchUsers } from "../../api/auth";
import type { ViewPrefs } from "../../hooks/useViewPrefs";
import Avatar from "../Common/Avatar";
import { Toggle } from "../Common/Toggle";

const ROLES: { value: BoardRole; label: string; description: string }[] = [
  { value: "admin",        label: "Admin",        description: "Full access — manage members, columns, swimlanes, and board settings" },
  { value: "member",       label: "Member",        description: "Create, edit, and move cards" },
  { value: "collaborator", label: "Collaborator",  description: "Can comment and upload files — cannot create or move cards" },
  { value: "viewer",       label: "Viewer",        description: "Read-only — cannot comment or upload" },
];

const ROLE_OPTIONS = ROLES.map((r) => ({
  value: r.value,
  label: r.label,
}));

interface Props {
  board: BoardFull;
  isAdmin: boolean;
  onClose: () => void;
  initialTab?: "members" | "display" | "rules" | "sharing" | "data";
  onBoardDeleted?: () => void;
  viewPrefs?: ViewPrefs;
  onToggleHiddenColumn?: (columnId: number) => void;
  onToggleHiddenSwimlane?: (swimlaneId: number) => void;
  onSetCardFieldPref?: (field: "hideLabels" | "hideDueDate" | "hideAssignee" | "hidePriority" | "hideLastMoved", value: boolean) => void;
  onUpdateBoardSettings?: (patch: Record<string, unknown>) => void;
}

type Tab = "members" | "display" | "rules" | "sharing" | "data";

interface StagedInvite {
  user: User;
  role: BoardRole;
}

function RoleTooltip() {
  return (
    <RoleInfoTooltip label="Role descriptions">
      <p className="text-[10px] font-semibold text-fg-muted uppercase tracking-wide mb-2">Role permissions</p>
      {ROLES.map((r) => (
        <Fragment key={r.value}>
          <div className={`py-1 ${r.value !== 'viewer' && r.value !== 'member' ? 'border-b border-line' : ''}`}>
            <span className="text-xs font-semibold text-fg capitalize">{r.label}</span>
            <span className="text-xs text-fg-tertiary"> — {r.description}</span>
          </div>
          {r.value === 'member' && (
            <div className="py-1 pl-3 border-l-2 border-line border-b border-line">
              <span className="text-xs font-semibold text-fg-secondary">Member (moderator flag)</span>
              <span className="text-xs text-fg-muted"> — Assign, edit, delete, and archive others' cards — ask an admin to enable</span>
            </div>
          )}
        </Fragment>
      ))}
    </RoleInfoTooltip>
  );
}

export default function BoardSettingsModal({ board, isAdmin, onClose, initialTab = "members", onBoardDeleted, viewPrefs, onToggleHiddenColumn, onToggleHiddenSwimlane, onSetCardFieldPref, onUpdateBoardSettings }: Props) {
  const [tab, setTab] = useState<Tab>(initialTab);
  const [members, setMembers] = useState<BoardMembership[]>(board.members);
  const [saving, setSaving] = useState<number | null>(null);
  const [pendingRemove, setPendingRemove] = useState<number | null>(null);
  const [deleteInput, setDeleteInput] = useState("");

  const [inviteQuery, setInviteQuery] = useState("");
  const [suggestions, setSuggestions] = useState<User[]>([]);
  const [staged, setStaged] = useState<StagedInvite[]>([]);
  const [inviting, setInviting] = useState(false);
  const [exportFormat, setExportFormat] = useState<"json" | "csv">("json");
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [inviteSuccess, setInviteSuccess] = useState<string | null>(null);

  const [dropdownAnchor, setDropdownAnchor] = useState<{ top: number; left: number; width: number } | null>(null);

  const [stalenessThreshold, setStalenessThreshold] = useState(board.staleness_threshold_days ?? 14);
  const [stalenessWarningPct, setStalenessWarningPct] = useState(board.stale_warning_pct ?? 50);
  // Inline confirmation before enabling hard WIP mode — mirrors the member-removal confirm pattern.
  const [pendingHardWip, setPendingHardWip] = useState(false);

  // #843 — per-board export threshold. Plain-English labels per UX spec; the
  // server validates on write and may reject unknown values.
  const [exportMinRole, setExportMinRole] = useState<BoardExportMinRole>(
    (board.export_min_role as BoardExportMinRole) ?? "viewer",
  );
  const [exportRoleError, setExportRoleError] = useState<string | null>(null);

  // #842 — export audit history. Lazy-loaded when an admin opens the Data tab
  // for the first time so viewers and collaborators never pay the request.
  const [exportHistory, setExportHistory] = useState<BoardExportLogEntry[] | null>(null);
  const [exportHistoryLoading, setExportHistoryLoading] = useState(false);
  const [exportHistoryError, setExportHistoryError] = useState<string | null>(null);

  // #843 — client-side mirror of the backend threshold gate for UI hiding.
  // Owner and site_admin always bypass (captured through current_user_role).
  const EXPORT_ROLE_RANK: Record<string, number> = { viewer: 0, collaborator: 1, member: 2, admin: 3 };
  const currentRole = board.current_user_role;
  const canExport =
    currentRole === "site_admin" ||
    currentRole === "admin" ||
    (currentRole != null &&
      EXPORT_ROLE_RANK[currentRole] >= (EXPORT_ROLE_RANK[exportMinRole] ?? 0));

  // Sharing tab state — token is initialized from the board payload (admin-only field).
  const [shareToken, setShareToken] = useState<string | null>(board.share_token ?? null);
  const [shareExpiresAt, setShareExpiresAt] = useState<string | null>(board.share_token_expires_at ?? null);
  // Selected TTL for the *next* enable action. Null = "never expires".
  const [shareTtl, setShareTtl] = useState<7 | 30 | 90 | null>(null);
  const [shareLoading, setShareLoading] = useState(false);
  const [shareCopied, setShareCopied] = useState(false);
  const [shareStatus, setShareStatus] = useState<string | null>(null);

  const shareUrl = shareToken ? `${window.location.origin}/share/${shareToken}` : null;

  const handleEnableShare = async () => {
    setShareLoading(true);
    setShareStatus(null);
    try {
      const data = await enableBoardSharing(board.id, shareTtl);
      setShareToken(data.share_token);
      setShareExpiresAt(data.share_token_expires_at);
      setShareStatus(null);
    } catch {
      setShareStatus("Failed to enable sharing. Please try again.");
    } finally {
      setShareLoading(false);
    }
  };

  const handleDisableShare = async () => {
    setShareLoading(true);
    setShareStatus(null);
    try {
      await disableBoardSharing(board.id);
      setShareToken(null);
      setShareExpiresAt(null);
      setShareStatus(null);
    } catch {
      setShareStatus("Failed to disable sharing. Please try again.");
    } finally {
      setShareLoading(false);
    }
  };

  const handleCopyShareUrl = () => {
    if (!shareUrl) return;
    navigator.clipboard.writeText(shareUrl);
    setShareCopied(true);
    setTimeout(() => setShareCopied(false), 2000);
  };

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    // Strip a leading @ so users can type "@alice" and get the same results as "alice"
    const q = inviteQuery.trim().replace(/^@/, "");
    if (q.length < 2) { setSuggestions([]); return; }
    debounceRef.current = setTimeout(async () => {
      try {
        const results = await searchUsers(q);
        const memberIds = new Set(members.map((m) => m.user.id));
        const stagedIds = new Set(staged.map((s) => s.user.id));
        const filtered = results.filter((u) => !memberIds.has(u.id) && !stagedIds.has(u.id));
        if (filtered.length > 0 && searchInputRef.current) {
          const rect = searchInputRef.current.getBoundingClientRect();
          setDropdownAnchor({ top: rect.bottom + 4, left: rect.left, width: rect.width });
        } else {
          setDropdownAnchor(null);
        }
        setSuggestions(filtered);
      } catch {
        setSuggestions([]);
        setDropdownAnchor(null);
      }
    }, 300);
  }, [inviteQuery, members, staged]);

  const handleRoleChange = async (userId: number, role: BoardRole) => {
    setSaving(userId);
    try {
      const updated = await setBoardMember(board.id, userId, role);
      setMembers((prev) => {
        const next = prev.map((m) => m.user.id === userId ? { ...m, role: updated.role, is_moderator: updated.is_moderator } : m);
        if (!next.find((m) => m.user.id === userId)) next.push(updated);
        return next;
      });
    } finally {
      setSaving(null);
    }
  };

  const handleModeratorToggle = async (userId: number, currentRole: BoardRole, isModerator: boolean) => {
    setSaving(userId);
    try {
      const updated = await setBoardMember(board.id, userId, currentRole, !isModerator);
      setMembers((prev) => prev.map((m) => m.user.id === userId ? { ...m, is_moderator: updated.is_moderator } : m));
    } finally {
      setSaving(null);
    }
  };

  const handleRemoveConfirm = async (userId: number) => {
    setSaving(userId);
    try {
      await removeBoardMember(board.id, userId);
      setMembers((prev) => prev.filter((m) => m.user.id !== userId));
    } finally {
      setSaving(null);
      setPendingRemove(null);
    }
  };

  const addToStaged = (user: User) => {
    setStaged((prev) => [...prev, { user, role: "member" }]);
    setSuggestions([]);
    setDropdownAnchor(null);
    setInviteQuery("");
    searchInputRef.current?.focus();
  };

  const handleInviteSubmit = async () => {
    if (staged.length === 0) return;
    setInviting(true);
    setInviteError(null);
    setInviteSuccess(null);
    try {
      const results = await Promise.all(staged.map((s) => setBoardMember(board.id, s.user.id, s.role)));
      setMembers((prev) => {
        const next = [...prev];
        for (const updated of results) {
          const idx = next.findIndex((m) => m.user.id === updated.user.id);
          if (idx >= 0) next[idx] = { ...next[idx], role: updated.role };
          else next.push(updated);
        }
        return next;
      });
      setStaged([]);
      setInviteSuccess(`Added ${results.length} member${results.length !== 1 ? "s" : ""} to the board.`);
    } catch {
      setInviteError("Failed to add some members. Please try again.");
    } finally {
      setInviting(false);
    }
  };


  const handleStalenessBlur = () => {
    patchBoard(board.id, { staleness_threshold_days: stalenessThreshold });
  };

  const handleStalenessWarningPctBlur = () => {
    const clamped = Math.max(0, Math.min(100, stalenessWarningPct));
    setStalenessWarningPct(clamped);
    patchBoard(board.id, { stale_warning_pct: clamped });
  };

  // #843 — save export_min_role immediately on change. Admins only; non-admins
  // never see the control (see Data tab render). On a server rejection we
  // revert the local state so the UI does not drift from persisted state.
  const handleExportMinRoleChange = async (value: BoardExportMinRole) => {
    const previous = exportMinRole;
    setExportMinRole(value);
    setExportRoleError(null);
    try {
      await patchBoard(board.id, { export_min_role: value });
    } catch {
      setExportMinRole(previous);
      setExportRoleError("Failed to update export permission. Please try again.");
    }
  };

  // #842 — load the audit history the first time an admin opens the Data tab.
  // The endpoint is admin-only server-side; we mirror that gate here so we
  // don't issue a request that would 403 for viewers/collaborators.
  useEffect(() => {
    if (tab !== "data" || !isAdmin) return;
    if (exportHistory !== null || exportHistoryLoading) return;
    setExportHistoryLoading(true);
    setExportHistoryError(null);
    getBoardExportHistory(board.id, { page_size: 10 })
      .then((resp) => setExportHistory(resp.results))
      .catch(() => setExportHistoryError("Could not load export history."))
      .finally(() => setExportHistoryLoading(false));
  }, [tab, isAdmin, board.id, exportHistory, exportHistoryLoading]);

  return (
    <ModalWrapper
      open={true}
      onClose={onClose}
      title="Board Settings"
      maxWidth="max-w-lg"
      noPadding
      labelId="board-settings-title"
      panelClassName="h-[85vh] max-h-[640px] min-h-0"
      headerBorder
    >

        {/* Tabs */}
        <div className="flex border-b border-line px-6 gap-1">
          {(["members", "display", "rules", ...(isAdmin ? ["sharing"] : []), "data"] as Tab[]).map((t) => {
            const label =
              t === "members" ? `Members (${members.length})`
              : t === "display" ? "Display"
              : t === "rules" ? "Rules"
              : t === "sharing" ? "Sharing"
              : "Data";
            return (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={`py-2.5 px-1 mr-3 text-sm font-medium border-b-2 transition -mb-px ${
                  tab === t ? "border-primary-emphasis text-fg" : "border-transparent text-fg-tertiary hover:text-fg"
                }`}
              >
                {label}
              </button>
            );
          })}
        </div>

        {/* Content */}
        <div className="overflow-y-auto flex-1 px-6 py-4">

          {/* ── Members tab ── */}
          {tab === "members" && (
            <div className="flex flex-col gap-0">
              <div className="flex items-center justify-between text-[10px] font-semibold text-fg-muted uppercase tracking-wide pb-2 mb-1 border-b border-line">
                <span>Member</span>
                <div className="flex items-center gap-1.5">
                  <span>Role</span>
                  <RoleTooltip />
                </div>
              </div>

              {members.map((m) => {
                const isRemoving = pendingRemove === m.user.id;
                const isDisabled = saving === m.user.id;
                const canRemove = isAdmin && m.id !== null;

                return (
                  <div key={m.user.id} className="py-2.5 border-b border-line/60 last:border-0">
                    <div className="flex items-center justify-between gap-3">
                      <div className="flex items-center gap-2.5 min-w-0">
                        <Avatar user={m.user} size="sm" />
                        <div className="min-w-0">
                          <p className="text-sm font-medium text-fg truncate">{userDisplayName(m.user)}</p>
                        </div>
                      </div>

                      <div className="flex items-center gap-2 shrink-0">
                        {m.role === "site_admin" ? (
                          <span className="text-xs text-fg-secondary capitalize px-2 py-1 bg-surface-hover rounded" title="Site administrator — role managed at the instance level">
                            site admin
                          </span>
                        ) : isAdmin ? (
                          <SelectDropdown
                            value={m.role as BoardRole}
                            disabled={isDisabled}
                            onChange={(v) => handleRoleChange(m.user.id, v)}
                            options={ROLE_OPTIONS}
                            size="xs"
                          />
                        ) : (
                          <span
                            className="text-xs text-fg-secondary capitalize px-2 py-1 bg-surface-hover rounded"
                            title={ROLES.find((r) => r.value === m.role)?.description}
                          >
                            {m.role}
                          </span>
                        )}
                        {canRemove && !isRemoving && (
                          <button
                            onClick={() => setPendingRemove(m.user.id)}
                            disabled={isDisabled}
                            className="text-xs text-fg-muted hover:text-danger transition disabled:opacity-40 w-5 text-center"
                            title="Remove direct board role"
                          >
                            ✕
                          </button>
                        )}
                        {(!canRemove || isRemoving) && <span className="w-5" />}
                      </div>
                    </div>

                    {isAdmin && m.role !== "site_admin" && (
                      <div className="mt-1 pl-9 flex items-center gap-2">
                        {m.role === "admin" ? (
                          // Admins implicitly have full moderator rights — show as checked+disabled
                          // so the UI accurately reflects their capabilities (#574).
                          <label className="flex items-center gap-1.5 select-none cursor-default" title="Admins have full moderator rights">
                            <input
                              type="checkbox"
                              checked
                              disabled
                              readOnly
                              className="rounded border-line-strong bg-surface-hover text-info focus:ring-primary-emphasis focus:ring-offset-0 w-3.5 h-3.5 opacity-60 cursor-not-allowed"
                            />
                            <span className="text-xs text-fg-muted">Moderator</span>
                          </label>
                        ) : m.role === "member" ? (
                          <label className="flex items-center gap-1.5 cursor-pointer select-none">
                            <input
                              type="checkbox"
                              checked={m.is_moderator}
                              disabled={isDisabled}
                              onChange={() => handleModeratorToggle(m.user.id, m.role as BoardRole, m.is_moderator)}
                              className="rounded border-line-strong bg-surface-hover text-info focus:ring-primary-emphasis focus:ring-offset-0 w-3.5 h-3.5"
                            />
                            <span className="text-xs text-fg-tertiary">Moderator</span>
                          </label>
                        ) : (
                          // Collaborator / Viewer — moderator entitlement is not available (#574).
                          <label className="flex items-center gap-1.5 select-none cursor-default" title="Moderator entitlement requires Member role or above">
                            <input
                              type="checkbox"
                              checked={false}
                              disabled
                              readOnly
                              className="rounded border-line-strong bg-surface-hover text-info focus:ring-primary-emphasis focus:ring-offset-0 w-3.5 h-3.5 opacity-40 cursor-not-allowed"
                            />
                            <span className="text-xs text-fg-muted">Moderator</span>
                          </label>
                        )}
                        <span className="relative group/mod-info">
                          <span className="text-xs text-fg-tertiary cursor-default select-none" tabIndex={0} aria-label="What Moderator can do">ⓘ</span>
                          <div className="pointer-events-none absolute bottom-full left-0 mb-1.5 w-64 bg-sunken text-fg text-xs rounded px-2 py-1.5 shadow-lg opacity-0 group-hover/mod-info:opacity-100 focus-within:opacity-100 transition-opacity delay-300 z-10">
                            Can assign, edit, delete, and archive cards created by other members.
                          </div>
                        </span>
                      </div>
                    )}

                    {isRemoving && (
                      <div className="mt-1.5 pl-9 flex items-center gap-2 text-xs">
                        <span className="text-fg-tertiary">
                          Remove <span className="text-fg font-medium">{userDisplayName(m.user)}</span>?
                        </span>
                        <button
                          onClick={() => handleRemoveConfirm(m.user.id)}
                          disabled={isDisabled}
                          className="text-danger hover:text-danger font-medium transition disabled:opacity-40"
                        >
                          Confirm
                        </button>
                        <button
                          onClick={() => setPendingRemove(null)}
                          className="text-fg-tertiary hover:text-fg transition"
                        >
                          Cancel
                        </button>
                      </div>
                    )}
                  </div>
                );
              })}

              {members.length === 0 && (
                <p className="text-sm text-fg-muted py-4 text-center">No members yet.</p>
              )}

              {isAdmin && (
                <div className="border-t border-line pt-4 mt-2">
                  <p className="text-[10px] font-semibold text-fg-muted uppercase tracking-wide mb-3">Add member</p>
                  <div className="flex flex-col gap-4">
                    <div className="relative">
                      <input
                        ref={searchInputRef}
                        value={inviteQuery}
                        onChange={(e) => { setInviteQuery(e.target.value); setInviteSuccess(null); }}
                        onKeyDown={(e) => { if (e.key === "Escape") { setSuggestions([]); setDropdownAnchor(null); setInviteQuery(""); } }}
                        placeholder="Search by name or email…"
                        className="w-full bg-surface border border-line text-fg-secondary text-sm rounded px-3 py-1.5 focus:outline-none focus:ring-2 focus:ring-primary-emphasis focus:border-transparent placeholder-fg-muted"
                      />
                      {suggestions.length > 0 && dropdownAnchor && (
                        <div
                          style={{ position: "fixed", top: dropdownAnchor.top, left: dropdownAnchor.left, width: dropdownAnchor.width }}
                          className="bg-surface border border-line-strong rounded-xl shadow-xl z-[60] overflow-hidden"
                        >
                          {suggestions.map((u) => (
                            <button
                              key={u.id}
                              type="button"
                              onMouseDown={(e) => { e.preventDefault(); addToStaged(u); }}
                              className="w-full text-left px-3 py-2.5 hover:bg-surface-hover transition flex items-center gap-2.5"
                            >
                              <Avatar user={u} size="sm" />
                              <div className="min-w-0">
                                <p className="text-sm font-medium text-fg truncate">{userDisplayName(u)}</p>
                                <p className="text-xs text-fg-muted truncate">{u.email}</p>
                              </div>
                            </button>
                          ))}
                        </div>
                      )}
                    </div>

                    {staged.length > 0 && (
                      <div>
                        <p className="text-[10px] font-semibold text-fg-muted uppercase tracking-wide mb-2">To be added</p>
                        <div className="flex flex-col gap-0">
                          {staged.map((s) => (
                            <div key={s.user.id} className="flex items-center justify-between gap-2 py-2.5 border-b border-line/60 last:border-0">
                              <div className="flex items-center gap-2 min-w-0">
                                <Avatar user={s.user} size="sm" />
                                <p className="text-sm text-fg truncate">{userDisplayName(s.user)}</p>
                              </div>
                              <div className="flex items-center gap-2 shrink-0">
                                <SelectDropdown
                                  value={s.role}
                                  onChange={(v) =>
                                    setStaged((prev) =>
                                      prev.map((x) => x.user.id === s.user.id ? { ...x, role: v } : x)
                                    )
                                  }
                                  options={ROLE_OPTIONS}
                                  size="xs"
                                />
                                <button
                                  onClick={() => setStaged((prev) => prev.filter((x) => x.user.id !== s.user.id))}
                                  className="text-xs text-fg-muted hover:text-danger transition w-5 text-center"
                                  title="Remove from invite list"
                                >
                                  ✕
                                </button>
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {inviteError && <p className="text-xs text-danger">{inviteError}</p>}
                    {inviteSuccess && <p className="text-xs text-success">{inviteSuccess}</p>}

                    <button
                      onClick={handleInviteSubmit}
                      disabled={staged.length === 0 || inviting}
                      className="w-full py-2 rounded bg-primary hover:bg-primary-hover text-fg text-sm font-medium transition disabled:opacity-40 disabled:cursor-not-allowed focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
                    >
                      {inviting ? "Adding…" : staged.length > 0 ? `Add ${staged.length} member${staged.length !== 1 ? "s" : ""} to board` : "Add to board"}
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* ── Rules tab ── */}
          {tab === "rules" && (
            <div className="flex flex-col gap-5">
              <p className="text-xs text-fg-muted">
                Rules affect all board members. Only admins can change these.
              </p>

              {/* WIP and weight limit enforcement */}
              {isAdmin && onUpdateBoardSettings ? (
                <section>
                  <h3 className="text-xs font-semibold text-fg-tertiary uppercase tracking-wide mb-2">Limit enforcement</h3>
                  <div className="flex items-center justify-between py-2 border-b border-line/60">
                    <div className="min-w-0 pr-4">
                      <span className="text-sm text-fg">Enforce WIP limits</span>
                      <p className="text-xs text-fg-muted mt-0.5">
                        When enabled, moving a card into a column that is at or over its WIP limit is blocked. Admins can override.
                      </p>
                    </div>
                    <Toggle
                      checked={board.enforce_wip_limits}
                      onChange={(v) => onUpdateBoardSettings({ enforce_wip_limits: v })}
                      aria-label="Enforce WIP limits"
                    />
                  </div>
                  {/* Hard WIP mode — visually subordinated under the soft enforcement toggle */}
                  <div className="ml-6 border-l-2 border-line pl-4 py-2 border-b border-line/60">
                    <div className="flex items-center justify-between">
                      <div className="min-w-0 pr-4">
                        <span className="text-sm text-fg-secondary">Hard mode (no admin override)</span>
                        <p className="text-xs text-fg-muted mt-0.5">
                          Hard mode is active regardless of whether soft enforcement is on. When enabled, no one — including admins — can override a WIP block.
                        </p>
                      </div>
                      <Toggle
                        checked={board.enforce_wip_hard}
                        onChange={(v) => {
                          if (v) {
                            setPendingHardWip(true);
                          } else {
                            onUpdateBoardSettings({ enforce_wip_hard: false });
                          }
                        }}
                        aria-label="Hard mode (no admin override)"
                      />
                    </div>
                    {pendingHardWip && (
                      <div className="mt-1.5 flex items-center gap-2 text-xs">
                        <span className="text-fg-tertiary">Enable hard mode? No one — including admins — will be able to bypass WIP limits.</span>
                        <button
                          onClick={() => {
                            onUpdateBoardSettings({ enforce_wip_hard: true });
                            setPendingHardWip(false);
                          }}
                          className="text-danger hover:text-danger font-medium transition"
                        >
                          Confirm
                        </button>
                        <button
                          onClick={() => setPendingHardWip(false)}
                          className="text-fg-tertiary hover:text-fg transition"
                        >
                          Cancel
                        </button>
                      </div>
                    )}
                  </div>
                  <div className="flex items-center justify-between py-2 border-b border-line/60">
                    <div className="min-w-0 pr-4">
                      <span className="text-sm text-fg">Enforce weight limits</span>
                      <p className="text-xs text-fg-muted mt-0.5">
                        When enabled, moving a card into a column that would exceed its weight budget is blocked. Admins can override. Columns must have a weight limit set for this to take effect.
                      </p>
                    </div>
                    <Toggle
                      checked={board.enforce_weight_limits}
                      onChange={(v) => onUpdateBoardSettings({ enforce_weight_limits: v })}
                      aria-label="Enforce weight limits"
                    />
                  </div>
                </section>
              ) : (
                <section>
                  <h3 className="text-xs font-semibold text-fg-tertiary uppercase tracking-wide mb-2">Limit enforcement</h3>
                  <div className="flex flex-col gap-1 py-1">
                    <p className="text-sm text-fg-secondary">
                      WIP limits:{" "}
                      {board.enforce_wip_hard
                        ? "enforced (no override)"
                        : board.enforce_wip_limits
                          ? "enforced"
                          : "informational only"}
                    </p>
                    <p className="text-sm text-fg-secondary">Weight limits: {board.enforce_weight_limits ? "enforced" : "informational only"}</p>
                  </div>
                </section>
              )}

              {/* Card aging settings */}
              <section aria-labelledby="card-aging-heading">
                <h3 id="card-aging-heading" className="text-xs font-semibold text-fg-tertiary uppercase tracking-wide mb-2">Card aging settings</h3>
                {isAdmin ? (
                  <div className="flex flex-col gap-3">
                    <div className="flex flex-col gap-1.5">
                      <div className="flex items-center gap-2">
                        <input
                          id="staleness-threshold"
                          aria-label="Stale card threshold"
                          type="number"
                          min="1"
                          value={stalenessThreshold}
                          onChange={(e) => setStalenessThreshold(Number(e.target.value))}
                          onBlur={handleStalenessBlur}
                          className="bg-surface border border-line text-fg-secondary text-sm rounded px-3 py-1.5 w-20 focus:outline-none focus:ring-2 focus:ring-primary-emphasis focus:border-transparent"
                        />
                        <span className="text-sm text-fg-tertiary">days threshold</span>
                      </div>
                      <p className="text-xs text-fg-muted">Cards idle beyond this threshold are shown with a stale tint on the board. Warning tint appears earlier (controlled by the % setting below).</p>
                    </div>
                    <div className="flex flex-col gap-1.5">
                      <div className="flex items-center gap-2">
                        <input
                          id="staleness-warning-pct"
                          aria-label="Heatmap warning percentage"
                          type="number"
                          min="0"
                          max="100"
                          value={stalenessWarningPct}
                          onChange={(e) => setStalenessWarningPct(Number(e.target.value))}
                          onBlur={handleStalenessWarningPctBlur}
                          className="bg-surface border border-line text-fg-secondary text-sm rounded px-3 py-1.5 w-20 focus:outline-none focus:ring-2 focus:ring-primary-emphasis focus:border-transparent"
                        />
                        <span className="text-sm text-fg-tertiary">% warning</span>
                      </div>
                      <p className="text-xs text-fg-muted">
                        Warning tint appears when a card has used this percentage of the threshold. Example: 14 days threshold, 50% warning → warning tint after 7 days, stale tint at 14 days.
                      </p>
                    </div>
                  </div>
                ) : (
                  <p className="text-sm text-fg-secondary">{board.staleness_threshold_days ?? 14} days · {board.stale_warning_pct ?? 50}% warning</p>
                )}
              </section>
            </div>
          )}

          {/* ── Sharing tab (admin-only) ── */}
          {tab === "sharing" && isAdmin && (
            <div className="flex flex-col gap-5">
              <section>
                <h3 className="text-xs font-semibold text-fg-tertiary uppercase tracking-wide mb-2">Public sharing</h3>
                <p className="text-xs text-fg-muted mb-4">
                  Anyone with this link can view this board without signing in. They cannot edit, comment, or see member details.
                </p>

                {/* Toggle row */}
                <div className="flex items-center justify-between py-2 border-b border-line/60 mb-3">
                  <span className="text-sm text-fg">Enable public share link</span>
                  <Toggle
                    checked={shareToken !== null}
                    disabled={shareLoading}
                    onChange={() => {
                      if (shareToken !== null) {
                        handleDisableShare();
                      } else {
                        handleEnableShare();
                      }
                    }}
                    aria-label="Enable public share link"
                  />
                </div>

                {/* TTL selector — only shown while sharing is OFF, so admins choose
                    expiry up-front. Once enabled, the chosen expiry is locked in
                    until the link is disabled and re-enabled. */}
                {shareToken === null && (
                  <div className="flex items-center justify-between py-2 mb-3">
                    <label htmlFor="share-ttl-select" className="text-sm text-fg-secondary">
                      Expires in
                    </label>
                    <SelectDropdown
                      value={shareTtl === null ? "never" : String(shareTtl)}
                      onChange={(v) => setShareTtl(v === "never" ? null : (Number(v) as 7 | 30 | 90))}
                      options={[
                        { value: "never", label: "Never" },
                        { value: "7",     label: "7 days" },
                        { value: "30",    label: "30 days" },
                        { value: "90",    label: "90 days" },
                      ]}
                      disabled={shareLoading}
                    />
                  </div>
                )}

                {/* URL field — shown when enabled */}
                {shareToken !== null && shareUrl && (
                  <>
                    <div className="flex items-center gap-2">
                      <div
                        className="flex-1 text-[11px] bg-sunken border border-line rounded px-2 py-1.5 text-fg-tertiary truncate"
                        title={shareUrl}
                      >
                        {shareUrl}
                      </div>
                      <button
                        onClick={handleCopyShareUrl}
                        className="text-xs text-fg-secondary hover:text-fg hover:bg-surface-hover px-2 py-1.5 rounded transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis shrink-0"
                      >
                        {shareCopied ? "Copied!" : "Copy"}
                      </button>
                    </div>
                    {/* Expiry indicator — surfaces the TTL the admin chose at enable time
                        so they don't have to remember it. */}
                    <p className="text-xs text-fg-muted mt-2" data-testid="share-expiry-line">
                      {shareExpiresAt
                        ? `Expires ${new Date(shareExpiresAt).toLocaleString()}`
                        : "Never expires"}
                    </p>
                  </>
                )}

                {/* Status row — always reserve height */}
                <p className="text-xs h-4 mt-2">
                  {shareStatus && <span className="text-danger">{shareStatus}</span>}
                </p>
              </section>
            </div>
          )}

          {/* ── Data tab ── */}
          {tab === "data" && (
            <div className="flex flex-col gap-6">
              <section>
                <h3 className="text-xs font-semibold text-fg-tertiary uppercase tracking-wide mb-2">Export permission</h3>
                {isAdmin ? (
                  <>
                    <p className="text-xs text-fg-muted mb-2">
                      Choose who can export this board. Owners and site admins always bypass this threshold.
                    </p>
                    <SelectDropdown
                      value={exportMinRole}
                      onChange={(v) => handleExportMinRoleChange(v as BoardExportMinRole)}
                      options={[
                        { value: "viewer", label: "Anyone with read access (default)" },
                        { value: "collaborator", label: "Collaborators and above" },
                        { value: "member", label: "Members and above" },
                        { value: "admin", label: "Admins only" },
                      ]}
                    />
                    <p className="text-xs h-4 mt-1">
                      {exportRoleError && <span className="text-danger">{exportRoleError}</span>}
                    </p>
                  </>
                ) : (
                  <p className="text-sm text-fg-secondary">
                    {exportMinRole === "viewer" && "Anyone with read access can export this board."}
                    {exportMinRole === "collaborator" && "Collaborators and above can export this board."}
                    {exportMinRole === "member" && "Members and above can export this board."}
                    {exportMinRole === "admin" && "Only admins can export this board."}
                  </p>
                )}
              </section>

              {canExport && (
              <section>
                <h3 className="text-xs font-semibold text-fg-tertiary uppercase tracking-wide mb-2">Export</h3>
                <div className="flex flex-col gap-2">
                  {(["json", "csv"] as const).map((fmt) => (
                    <label
                      key={fmt}
                      className={`flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-colors duration-150 focus-within:ring-2 focus-within:ring-primary-emphasis ${
                        exportFormat === fmt
                          ? "border-primary-emphasis bg-info/10"
                          : "border-line-strong hover:bg-surface-hover/40"
                      }`}
                    >
                      <input
                        type="radio"
                        name="export-format"
                        value={fmt}
                        checked={exportFormat === fmt}
                        onChange={() => setExportFormat(fmt)}
                        className="sr-only"
                      />
                      <div>
                        <span className="text-sm text-fg font-medium">{fmt.toUpperCase()}</span>
                        <p className="text-xs text-fg-muted mt-0.5">
                          {fmt === "json"
                            ? "Full history: movements, activity log, and assignees"
                            : "Card data only, no history"}
                        </p>
                      </div>
                    </label>
                  ))}
                </div>
                <button
                  onClick={() => { if (exportFormat === "json") { exportBoardJson(board.id); } else { exportBoardCsv(board.id); } onClose(); }}
                  className="w-full mt-3 bg-primary hover:bg-primary-hover text-fg text-sm font-medium py-2 px-4 rounded transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
                >
                  Export {exportFormat.toUpperCase()}
                </button>
              </section>
              )}

              {isAdmin && (
                <section>
                  <h3 className="text-xs font-semibold text-fg-tertiary uppercase tracking-wide mb-2">Export history</h3>
                  {exportHistoryLoading && (
                    <div className="flex items-center gap-2 text-sm text-fg-tertiary">
                      <span className="inline-block w-5 h-5 border-2 border-primary border-t-transparent rounded-full animate-spin" />
                      Loading export history…
                    </div>
                  )}
                  <p className="text-sm h-5 mt-1">
                    {exportHistoryError && <span className="text-danger">{exportHistoryError}</span>}
                  </p>
                  {!exportHistoryLoading && !exportHistoryError && exportHistory && exportHistory.length === 0 && (
                    <p className="text-sm text-fg-muted">No exports have been recorded for this board yet.</p>
                  )}
                  {!exportHistoryLoading && exportHistory && exportHistory.length > 0 && (
                    <ul className="flex flex-col divide-y divide-line">
                      {exportHistory.map((entry) => (
                        <li key={entry.id} className="py-2 flex flex-col gap-0.5">
                          <div className="flex items-center justify-between text-sm text-fg">
                            <span className="truncate">
                              {entry.actor ? userDisplayName(entry.actor) : "(deactivated user)"}
                            </span>
                            <span className="font-mono text-xs text-fg-muted">
                              {new Date(entry.created_at).toLocaleString()}
                            </span>
                          </div>
                          <div className="text-xs text-fg-muted">
                            {entry.role_at_export} — {entry.export_format.toUpperCase()} · {entry.row_count} card{entry.row_count === 1 ? "" : "s"}
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
                </section>
              )}

              {isAdmin && onBoardDeleted && (
                <section className="border-t border-line pt-5">
                  <h3 className="text-xs font-semibold text-danger uppercase tracking-wide mb-3">Danger Zone</h3>
                  <p className="text-sm text-fg-tertiary mb-3">
                    Permanently delete <span className="text-fg font-medium">{board.name}</span> and all its cards, columns, and history. This cannot be undone.
                  </p>
                  {board.cards.length > 0 ? (
                    <div className="flex flex-col gap-2">
                      <p className="text-xs text-fg-muted">
                        Type <span className="text-fg-secondary font-mono">{board.name}</span> to confirm deletion.
                      </p>
                      <input
                        type="text"
                        value={deleteInput}
                        onChange={(e) => setDeleteInput(e.target.value)}
                        placeholder={board.name}
                        className="w-full bg-surface border border-line text-fg-secondary text-sm rounded px-3 py-1.5 focus:outline-none focus:ring-2 focus:ring-primary-emphasis focus:border-transparent placeholder-fg-muted"
                      />
                      <button
                        disabled={deleteInput !== board.name}
                        onClick={async () => { await deleteBoard(board.id); onBoardDeleted(); }}
                        className="w-full bg-danger-bg hover:bg-danger-bg-hover disabled:opacity-40 disabled:cursor-not-allowed text-fg text-sm font-medium py-2 px-4 rounded transition focus:outline-none focus:ring-2 focus:ring-danger-emphasis"
                      >
                        Delete board
                      </button>
                    </div>
                  ) : (
                    <button
                      onClick={async () => { await deleteBoard(board.id); onBoardDeleted(); }}
                      className="w-full bg-danger-bg hover:bg-danger-bg-hover text-fg text-sm font-medium py-2 px-4 rounded transition focus:outline-none focus:ring-2 focus:ring-danger-emphasis"
                    >
                      Delete board
                    </button>
                  )}
                </section>
              )}
            </div>
          )}

          {/* ── Display tab ── */}
          {tab === "display" && (
            <div className="flex flex-col gap-5">
              {viewPrefs && onToggleHiddenColumn && onToggleHiddenSwimlane && onSetCardFieldPref && (
                <>
                  <p className="text-xs text-fg-muted">
                    These preferences are personal and stored in your browser. They do not affect what other users see.
                  </p>

                  {/* Columns */}
                  {board.columns.length > 0 && (
                    <section>
                      <h3 className="text-xs font-semibold text-fg-tertiary uppercase tracking-wide mb-2">Columns</h3>
                      <div className="flex flex-col gap-0">
                        {board.columns.map((col) => {
                          const isHidden = viewPrefs.hiddenColumnIds.includes(col.id);
                          return (
                            <label
                              key={col.id}
                              className="flex items-center justify-between py-2 border-b border-line/60 last:border-0 cursor-pointer group"
                            >
                              <div className="flex items-center gap-2 min-w-0">
                                <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: col.color }} />
                                <span className={`text-sm truncate ${isHidden ? "text-fg-muted line-through" : "text-fg"}`}>
                                  {col.name}
                                </span>
                              </div>
                              <input
                                type="checkbox"
                                checked={!isHidden}
                                onChange={() => onToggleHiddenColumn(col.id)}
                                className="w-4 h-4 rounded accent-blue-500 shrink-0"
                              />
                            </label>
                          );
                        })}
                      </div>
                    </section>
                  )}

                  {/* Swimlanes */}
                  {board.swimlanes.length > 0 && (
                    <section>
                      <h3 className="text-xs font-semibold text-fg-tertiary uppercase tracking-wide mb-2">Swimlanes</h3>
                      <div className="flex flex-col gap-0">
                        {board.swimlanes.map((lane) => {
                          const isHidden = viewPrefs.hiddenSwimlaneIds.includes(lane.id);
                          return (
                            <label
                              key={lane.id}
                              className="flex items-center justify-between py-2 border-b border-line/60 last:border-0 cursor-pointer group"
                            >
                              <div className="flex items-center gap-2 min-w-0">
                                <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: lane.color }} />
                                <span className={`text-sm truncate ${isHidden ? "text-fg-muted line-through" : "text-fg"}`}>
                                  {lane.name}
                                </span>
                              </div>
                              <input
                                type="checkbox"
                                checked={!isHidden}
                                onChange={() => onToggleHiddenSwimlane(lane.id)}
                                className="w-4 h-4 rounded accent-blue-500 shrink-0"
                              />
                            </label>
                          );
                        })}
                      </div>
                    </section>
                  )}

                  {/* Card fields */}
                  <section>
                    <h3 className="text-xs font-semibold text-fg-tertiary uppercase tracking-wide mb-2">Card fields</h3>
                    <div className="flex flex-col gap-0">
                      {(
                        [
                          { field: "hideLabels",    label: "Labels" },
                          { field: "hideDueDate",   label: "Due date" },
                          { field: "hideAssignee",  label: "Assignee" },
                          { field: "hidePriority",  label: "Priority badge" },
                          { field: "hideLastMoved", label: "Last moved" },
                        ] as { field: "hideLabels" | "hideDueDate" | "hideAssignee" | "hidePriority" | "hideLastMoved"; label: string }[]
                      ).map(({ field, label }) => {
                        const hidden = viewPrefs[field];
                        return (
                          <label
                            key={field}
                            className="flex items-center justify-between py-2 border-b border-line/60 last:border-0 cursor-pointer"
                          >
                            <span className={`text-sm ${hidden ? "text-fg-muted line-through" : "text-fg"}`}>
                              {label}
                            </span>
                            <input
                              type="checkbox"
                              checked={!hidden}
                              onChange={(e) => onSetCardFieldPref(field, !e.target.checked)}
                              className="w-4 h-4 rounded accent-blue-500 shrink-0"
                            />
                          </label>
                        );
                      })}
                    </div>
                  </section>
                </>
              )}

            </div>
          )}
        </div>

        {tab === "members" && (
          <div className="px-6 py-3 border-t border-line text-xs text-fg-muted">
            Members inherited from group membership are shown here. Assigning a direct role overrides group access.
          </div>
        )}
    </ModalWrapper>
  );
}
