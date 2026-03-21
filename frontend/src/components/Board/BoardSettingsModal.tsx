import { useState, useEffect, useRef } from "react";
import { useEscapeStack } from "../../hooks/useEscapeStack";
import SelectDropdown from "../Common/SelectDropdown";
import RoleInfoTooltip from "../Common/RoleInfoTooltip";
import type { BoardFull, BoardMembership, User } from "../../types";
import { userDisplayName } from "../../types";
import { exportBoardCsv, exportBoardJson, setBoardMember, removeBoardMember, deleteBoard, patchBoard } from "../../api/boards";
import type { BoardRole } from "../../api/boards";
import { searchUsers } from "../../api/auth";
import type { ViewPrefs } from "../../hooks/useViewPrefs";

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
  initialTab?: "members" | "display" | "analytics" | "data";
  onBoardDeleted?: () => void;
  viewPrefs?: ViewPrefs;
  onToggleHiddenColumn?: (columnId: number) => void;
  onToggleHiddenSwimlane?: (swimlaneId: number) => void;
  onSetCardFieldPref?: (field: "hideLabels" | "hideDueDate" | "hideAssignee" | "hidePriority", value: boolean) => void;
  onUpdateBoardSettings?: (patch: Record<string, unknown>) => void;
}

type Tab = "members" | "display" | "analytics" | "data";

interface StagedInvite {
  user: User;
  role: BoardRole;
}

function RoleTooltip() {
  return (
    <RoleInfoTooltip label="Role descriptions">
      <p className="text-[10px] font-semibold text-slate-500 uppercase tracking-wide mb-2">Role permissions</p>
      {ROLES.map((r) => (
        <div key={r.value} className="py-1 border-b border-slate-700 last:border-0">
          <span className="text-xs font-semibold text-slate-100 capitalize">{r.label}</span>
          <span className="text-xs text-slate-400"> — {r.description}</span>
        </div>
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
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [inviteSuccess, setInviteSuccess] = useState<string | null>(null);

  const [dropdownAnchor, setDropdownAnchor] = useState<{ top: number; left: number; width: number } | null>(null);

  const [stalenessThreshold, setStalenessThreshold] = useState(board.staleness_threshold_days ?? 14);

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  useEscapeStack(onClose, 40);

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
        const next = prev.map((m) => m.user.id === userId ? { ...m, role: updated.role } : m);
        if (!next.find((m) => m.user.id === userId)) next.push(updated);
        return next;
      });
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

  const initials = (user: User) => userDisplayName(user).slice(0, 1).toUpperCase();

  const handleStalenessBlur = () => {
    patchBoard(board.id, { staleness_threshold_days: stalenessThreshold });
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div role="dialog" aria-modal="true" aria-labelledby="board-settings-title" className="bg-slate-800 rounded-2xl shadow-2xl w-full max-w-lg mx-4 flex flex-col max-h-[85vh]">

        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-700">
          <h2 id="board-settings-title" className="text-base font-semibold text-white">Board Settings</h2>
          <button onClick={onClose} className="text-slate-400 hover:text-white transition text-xl leading-none">×</button>
        </div>

        {/* Tabs */}
        <div className="flex border-b border-slate-700 px-6 gap-1">
          {(["members", "display", "analytics", "data"] as Tab[]).map((t) => {
            const label =
              t === "members" ? `Members (${members.length})`
              : t === "display" ? "Display"
              : t === "analytics" ? "Analytics"
              : "Data";
            return (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={`py-2.5 px-1 mr-3 text-sm font-medium border-b-2 transition -mb-px ${
                  tab === t ? "border-blue-500 text-white" : "border-transparent text-slate-400 hover:text-slate-200"
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
              <div className="flex items-center justify-between text-[10px] font-semibold text-slate-500 uppercase tracking-wide pb-2 mb-1 border-b border-slate-700">
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
                  <div key={m.user.id} className="py-2.5 border-b border-slate-700/60 last:border-0">
                    <div className="flex items-center justify-between gap-3">
                      <div className="flex items-center gap-2.5 min-w-0">
                        <div className="w-7 h-7 rounded-full bg-blue-700 flex items-center justify-center text-xs font-semibold text-white shrink-0">
                          {initials(m.user)}
                        </div>
                        <div className="min-w-0">
                          <p className="text-sm font-medium text-white truncate">{userDisplayName(m.user)}</p>
                          <p className="text-xs text-slate-500 truncate">{m.user.email}</p>
                        </div>
                      </div>

                      <div className="flex items-center gap-2 shrink-0">
                        {isAdmin ? (
                          <SelectDropdown
                            value={m.role}
                            disabled={isDisabled}
                            onChange={(v) => handleRoleChange(m.user.id, v)}
                            options={ROLE_OPTIONS}
                            size="xs"
                          />
                        ) : (
                          <span
                            className="text-xs text-slate-300 capitalize px-2 py-1 bg-slate-700 rounded-lg"
                            title={ROLES.find((r) => r.value === m.role)?.description}
                          >
                            {m.role}
                          </span>
                        )}
                        {canRemove && !isRemoving && (
                          <button
                            onClick={() => setPendingRemove(m.user.id)}
                            disabled={isDisabled}
                            className="text-xs text-slate-500 hover:text-red-400 transition disabled:opacity-50 w-5 text-center"
                            title="Remove direct board role"
                          >
                            ✕
                          </button>
                        )}
                        {(!canRemove || isRemoving) && <span className="w-5" />}
                      </div>
                    </div>

                    {isRemoving && (
                      <div className="mt-1.5 pl-9 flex items-center gap-2 text-xs">
                        <span className="text-slate-400">
                          Remove <span className="text-white font-medium">{userDisplayName(m.user)}</span>?
                        </span>
                        <button
                          onClick={() => handleRemoveConfirm(m.user.id)}
                          disabled={isDisabled}
                          className="text-red-400 hover:text-red-300 font-medium transition disabled:opacity-50"
                        >
                          Confirm
                        </button>
                        <button
                          onClick={() => setPendingRemove(null)}
                          className="text-slate-400 hover:text-slate-200 transition"
                        >
                          Cancel
                        </button>
                      </div>
                    )}
                  </div>
                );
              })}

              {members.length === 0 && (
                <p className="text-sm text-slate-500 py-4 text-center">No members yet.</p>
              )}

              {isAdmin && (
                <div className="border-t border-slate-700 pt-4 mt-2">
                  <p className="text-[10px] font-semibold text-slate-500 uppercase tracking-wide mb-3">Add member</p>
                  <div className="flex flex-col gap-4">
                    <div className="relative">
                      <input
                        ref={searchInputRef}
                        value={inviteQuery}
                        onChange={(e) => { setInviteQuery(e.target.value); setInviteSuccess(null); }}
                        onKeyDown={(e) => { if (e.key === "Escape") { setSuggestions([]); setDropdownAnchor(null); setInviteQuery(""); } }}
                        placeholder="Search by name or email…"
                        className="w-full bg-slate-900 border border-slate-600 text-slate-200 text-sm rounded-xl px-3 py-2.5 outline-none focus:border-blue-400 placeholder-slate-500"
                      />
                      {suggestions.length > 0 && dropdownAnchor && (
                        <div
                          style={{ position: "fixed", top: dropdownAnchor.top, left: dropdownAnchor.left, width: dropdownAnchor.width }}
                          className="bg-slate-800 border border-slate-600 rounded-xl shadow-xl z-[60] overflow-hidden"
                        >
                          {suggestions.map((u) => (
                            <button
                              key={u.id}
                              type="button"
                              onMouseDown={(e) => { e.preventDefault(); addToStaged(u); }}
                              className="w-full text-left px-3 py-2.5 hover:bg-slate-700 transition flex items-center gap-2.5"
                            >
                              <div className="w-7 h-7 rounded-full bg-blue-700 flex items-center justify-center text-xs font-semibold text-white shrink-0">
                                {initials(u)}
                              </div>
                              <div className="min-w-0">
                                <p className="text-sm font-medium text-slate-200 truncate">{userDisplayName(u)}</p>
                                <p className="text-xs text-slate-500 truncate">{u.email}</p>
                              </div>
                            </button>
                          ))}
                        </div>
                      )}
                    </div>

                    {staged.length > 0 && (
                      <div>
                        <p className="text-[10px] font-semibold text-slate-500 uppercase tracking-wide mb-2">To be added</p>
                        <div className="flex flex-col gap-0">
                          {staged.map((s) => (
                            <div key={s.user.id} className="flex items-center justify-between gap-2 py-2.5 border-b border-slate-700/60 last:border-0">
                              <div className="flex items-center gap-2 min-w-0">
                                <div className="w-7 h-7 rounded-full bg-blue-700 flex items-center justify-center text-[10px] font-semibold text-white shrink-0">
                                  {initials(s.user)}
                                </div>
                                <p className="text-sm text-white truncate">{userDisplayName(s.user)}</p>
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
                                  className="text-xs text-slate-500 hover:text-red-400 transition w-5 text-center"
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

                    {inviteError && <p className="text-xs text-red-400">{inviteError}</p>}
                    {inviteSuccess && <p className="text-xs text-green-400">{inviteSuccess}</p>}

                    <button
                      onClick={handleInviteSubmit}
                      disabled={staged.length === 0 || inviting}
                      className="w-full py-2 rounded-xl bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium transition disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      {inviting ? "Adding…" : staged.length > 0 ? `Add ${staged.length} member${staged.length !== 1 ? "s" : ""} to board` : "Add to board"}
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* ── Analytics tab ── */}
          {tab === "analytics" && (
            <div className="flex flex-col gap-5">
              <p className="text-xs text-slate-500">
                Analytics settings affect all board members. Only admins can change these.
              </p>

              {/* WIP and weight limit enforcement */}
              {isAdmin && onUpdateBoardSettings ? (
                <section>
                  <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-2">Limit enforcement</h3>
                  <label className="flex items-center justify-between py-2 border-b border-slate-700/60 cursor-pointer">
                    <div className="min-w-0 pr-4">
                      <span className="text-sm text-slate-200">Enforce WIP limits</span>
                      <p className="text-xs text-slate-500 mt-0.5">
                        When enabled, moving a card into a column that is at or over its WIP limit is blocked. Admins can override.
                      </p>
                    </div>
                    <input
                      type="checkbox"
                      checked={board.enforce_wip_limits}
                      onChange={(e) => onUpdateBoardSettings({ enforce_wip_limits: e.target.checked })}
                      className="w-4 h-4 rounded accent-blue-500 shrink-0"
                    />
                  </label>
                  <label className="flex items-center justify-between py-2 border-b border-slate-700/60 cursor-pointer">
                    <div className="min-w-0 pr-4">
                      <span className="text-sm text-slate-200">Enforce weight limits</span>
                      <p className="text-xs text-slate-500 mt-0.5">
                        When enabled, moving a card into a column that would exceed its weight budget is blocked. Admins can override. Columns must have a weight limit set for this to take effect.
                      </p>
                    </div>
                    <input
                      type="checkbox"
                      checked={board.enforce_weight_limits}
                      onChange={(e) => onUpdateBoardSettings({ enforce_weight_limits: e.target.checked })}
                      className="w-4 h-4 rounded accent-blue-500 shrink-0"
                    />
                  </label>
                </section>
              ) : (
                <section>
                  <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-2">Limit enforcement</h3>
                  <div className="flex flex-col gap-1 py-1">
                    <p className="text-sm text-slate-300">WIP limits: {board.enforce_wip_limits ? "enforced" : "informational only"}</p>
                    <p className="text-sm text-slate-300">Weight limits: {board.enforce_weight_limits ? "enforced" : "informational only"}</p>
                  </div>
                </section>
              )}

              {/* Stale card threshold */}
              <section>
                <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-2">Stale card threshold</h3>
                {isAdmin ? (
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
                        className="bg-slate-800 border border-slate-700 text-slate-300 text-sm rounded px-3 py-1.5 w-20 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                      />
                      <span className="text-sm text-slate-400">days</span>
                    </div>
                    <p className="text-xs text-slate-500">Cards with no movement after this many days are flagged as stalled.</p>
                  </div>
                ) : (
                  <p className="text-sm text-slate-300">{board.staleness_threshold_days ?? 14} days</p>
                )}
              </section>
            </div>
          )}

          {/* ── Data tab ── */}
          {tab === "data" && (
            <div className="flex flex-col gap-6">
              <section>
                <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-3">Export</h3>
                <div className="flex gap-3">
                  <button
                    onClick={() => { exportBoardCsv(board.id); onClose(); }}
                    className="flex-1 bg-slate-700 hover:bg-slate-600 text-slate-200 text-sm font-medium py-2 px-4 rounded-lg transition"
                  >
                    Export CSV
                  </button>
                  <button
                    onClick={() => { exportBoardJson(board.id); onClose(); }}
                    className="flex-1 bg-slate-700 hover:bg-slate-600 text-slate-200 text-sm font-medium py-2 px-4 rounded-lg transition"
                  >
                    Export JSON
                  </button>
                </div>
              </section>

              {isAdmin && onBoardDeleted && (
                <section className="border-t border-slate-700 pt-5">
                  <h3 className="text-xs font-semibold text-red-400 uppercase tracking-wide mb-3">Danger Zone</h3>
                  <p className="text-sm text-slate-400 mb-3">
                    Permanently delete <span className="text-slate-200 font-medium">{board.name}</span> and all its cards, columns, and history. This cannot be undone.
                  </p>
                  {board.cards.length > 0 ? (
                    <div className="flex flex-col gap-2">
                      <p className="text-xs text-slate-500">
                        Type <span className="text-slate-300 font-mono">{board.name}</span> to confirm deletion.
                      </p>
                      <input
                        type="text"
                        value={deleteInput}
                        onChange={(e) => setDeleteInput(e.target.value)}
                        placeholder={board.name}
                        className="w-full bg-slate-700 text-white text-sm rounded-lg px-3 py-2 border border-slate-600 focus:outline-none focus:border-red-500"
                      />
                      <button
                        disabled={deleteInput !== board.name}
                        onClick={async () => { await deleteBoard(board.id); onBoardDeleted(); }}
                        className="w-full bg-red-700 hover:bg-red-600 disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm font-medium py-2 px-4 rounded-lg transition"
                      >
                        Delete board
                      </button>
                    </div>
                  ) : (
                    <button
                      onClick={async () => { await deleteBoard(board.id); onBoardDeleted(); }}
                      className="w-full bg-red-700 hover:bg-red-600 text-white text-sm font-medium py-2 px-4 rounded-lg transition"
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
                  <p className="text-xs text-slate-500">
                    These preferences are personal and stored in your browser. They do not affect what other users see.
                  </p>

                  {/* Columns */}
                  {board.columns.length > 0 && (
                    <section>
                      <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-2">Columns</h3>
                      <div className="flex flex-col gap-0">
                        {board.columns.map((col) => {
                          const isHidden = viewPrefs.hiddenColumnIds.includes(col.id);
                          return (
                            <label
                              key={col.id}
                              className="flex items-center justify-between py-2 border-b border-slate-700/60 last:border-0 cursor-pointer group"
                            >
                              <div className="flex items-center gap-2 min-w-0">
                                <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: col.color }} />
                                <span className={`text-sm truncate ${isHidden ? "text-slate-500 line-through" : "text-slate-200"}`}>
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
                      <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-2">Swimlanes</h3>
                      <div className="flex flex-col gap-0">
                        {board.swimlanes.map((lane) => {
                          const isHidden = viewPrefs.hiddenSwimlaneIds.includes(lane.id);
                          return (
                            <label
                              key={lane.id}
                              className="flex items-center justify-between py-2 border-b border-slate-700/60 last:border-0 cursor-pointer group"
                            >
                              <div className="flex items-center gap-2 min-w-0">
                                <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: lane.color }} />
                                <span className={`text-sm truncate ${isHidden ? "text-slate-500 line-through" : "text-slate-200"}`}>
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
                    <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-2">Card fields</h3>
                    <div className="flex flex-col gap-0">
                      {(
                        [
                          { field: "hideLabels",   label: "Labels" },
                          { field: "hideDueDate",  label: "Due date" },
                          { field: "hideAssignee", label: "Assignee" },
                          { field: "hidePriority", label: "Priority badge" },
                        ] as { field: "hideLabels" | "hideDueDate" | "hideAssignee" | "hidePriority"; label: string }[]
                      ).map(({ field, label }) => {
                        const hidden = viewPrefs[field];
                        return (
                          <label
                            key={field}
                            className="flex items-center justify-between py-2 border-b border-slate-700/60 last:border-0 cursor-pointer"
                          >
                            <span className={`text-sm ${hidden ? "text-slate-500 line-through" : "text-slate-200"}`}>
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
          <div className="px-6 py-3 border-t border-slate-700 text-xs text-slate-500">
            Members inherited from group membership are shown here. Assigning a direct role overrides group access.
          </div>
        )}
      </div>
    </div>
  );
}
