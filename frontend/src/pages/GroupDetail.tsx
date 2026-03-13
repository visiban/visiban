import { useEffect, useState } from "react";
import { useParams, useNavigate, useSearchParams, useLocation } from "react-router-dom";
import Avatar from "../components/Common/Avatar";
import {
  getGroup, getGroupMembers, getSubgroups, getGroupBoards,
  createGroupBoard, removeGroupMember, updateGroupMemberRole, deleteGroup,
  transferGroupOwnership, createGroupLabel, deleteGroupLabel, updateGroupBoardDefaults,
} from "../api/groups";
import Navbar from "../components/Layout/Navbar";
import CreateGroupModal from "../components/Group/CreateGroupModal";
import InviteLinkPanel from "../components/Group/InviteLinkPanel";
import MoveBoardModal from "../components/Board/MoveBoardModal";
import CreateBoardModal from "../components/Board/CreateBoardModal";
import ImportBoardModal from "../components/Board/ImportBoardModal";
import { importBoard } from "../api/boards";
import type { Board, Group, GroupLabel, GroupMembership, Priority, User } from "../types";
import SelectDropdown from "../components/Common/SelectDropdown";

interface Props {
  user: User;
  onLogout: () => void;
  onUserUpdated: (user: User) => void;
}

export default function GroupDetail({ user, onLogout, onUserUpdated }: Props) {
  const { id } = useParams<{ id: string }>();
  const groupId = Number(id);
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();

  const joinedGroupName: string | null = (location.state as { joinedGroup?: string } | null)?.joinedGroup ?? null;
  const [joinToast, setJoinToast] = useState(joinedGroupName);

  const [group, setGroup] = useState<Group | null>(null);
  const [subgroups, setSubgroups] = useState<Group[]>([]);
  const [boards, setBoards] = useState<Board[]>([]);
  const [members, setMembers] = useState<GroupMembership[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [movingBoard, setMovingBoard] = useState<Board | null>(null);
  const [showCreateSubgroup, setShowCreateSubgroup] = useState(false);
  const [creatingBoard, setCreatingBoard] = useState(false);
  const [importingBoard, setImportingBoard] = useState(false);
  const [showSubgroupBoards, setShowSubgroupBoards] = useState(false);
  const [subgroupBoards, setSubgroupBoards] = useState<{ board: Board; groupName: string }[]>([]);
  const [loadingSubgroupBoards, setLoadingSubgroupBoards] = useState(false);

  const [showTransferModal, setShowTransferModal] = useState(false);
  const [transferNewOwnerId, setTransferNewOwnerId] = useState<number | "">("");
  const [transferConfirmation, setTransferConfirmation] = useState("");
  const [transferError, setTransferError] = useState<string | null>(null);
  const [transferring, setTransferring] = useState(false);

  // Board defaults state
  const [newLabelName, setNewLabelName] = useState("");
  const [newLabelColor, setNewLabelColor] = useState("#EAB308");
  const [addingLabel, setAddingLabel] = useState(false);
  const [labelError, setLabelError] = useState<string | null>(null);
  const [savingDefaults, setSavingDefaults] = useState(false);
  const [defaultsError, setDefaultsError] = useState<string | null>(null);
  const [defaultsSaved, setDefaultsSaved] = useState(false);

  useEffect(() => {
    setLoading(true);
    Promise.all([
      getGroup(groupId),
      getSubgroups(groupId),
      getGroupBoards(groupId),
      getGroupMembers(groupId),
    ]).then(([g, sg, b, m]) => {
      setGroup(g);
      setSubgroups(sg);
      setBoards(b);
      setMembers(m);
    }).catch(() => setError("Failed to load group"))
      .finally(() => setLoading(false));
  }, [groupId]);

  useEffect(() => {
    if (!showSubgroupBoards || subgroups.length === 0) return;
    setLoadingSubgroupBoards(true);
    Promise.all(
      subgroups.map((sg) => getGroupBoards(sg.id).then((bs) => bs.map((b) => ({ board: b, groupName: sg.name }))))
    ).then((results) => setSubgroupBoards(results.flat()))
      .finally(() => setLoadingSubgroupBoards(false));
  }, [showSubgroupBoards, subgroups]);

  const handleCreateBoard = async (name: string, template: string) => {
    const board = await createGroupBoard(groupId, { name, template });
    setBoards((prev) => [...prev, board]);
    setCreatingBoard(false);
    navigate(`/boards/${board.id}`);
  };

  const handleImportBoard = async (file: File, name?: string) => {
    const board = await importBoard(file, name, groupId);
    setImportingBoard(false);
    navigate(`/boards/${board.id}`);
  };

  const handleRemoveMember = async (userId: number) => {
    if (!confirm("Remove this member?")) return;
    await removeGroupMember(groupId, userId);
    setMembers((prev) => prev.filter((m) => m.user.id !== userId));
  };

  const handleRoleChange = async (userId: number, role: "admin" | "member" | "viewer") => {
    const updated = await updateGroupMemberRole(groupId, userId, role);
    setMembers((prev) => prev.map((m) => m.user.id === userId ? { ...m, role: updated.role } : m));
  };

  const handleDeleteGroup = async () => {
    if (!confirm(`Delete group "${group?.name}"? This cannot be undone.`)) return;
    await deleteGroup(groupId);
    navigate("/");
  };

  const handleTransferOwnership = async () => {
    if (!group || transferNewOwnerId === "") return;
    setTransferError(null);
    setTransferring(true);
    try {
      const updated = await transferGroupOwnership(groupId, transferNewOwnerId, transferConfirmation);
      setGroup(updated);
      setShowTransferModal(false);
      setTransferNewOwnerId("");
      setTransferConfirmation("");
    } catch (err: unknown) {
      const detail = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
      setTransferError(detail ?? "Transfer failed. Please try again.");
    } finally {
      setTransferring(false);
    }
  };

  const handleAddGroupLabel = async () => {
    if (!newLabelName.trim()) return;
    setLabelError(null);
    setAddingLabel(true);
    try {
      const label = await createGroupLabel(groupId, { name: newLabelName.trim(), color: newLabelColor });
      setGroup((prev) => prev ? { ...prev, shared_labels: [...prev.shared_labels, label] } : prev);
      setNewLabelName("");
      setNewLabelColor("#EAB308");
    } catch {
      setLabelError("Failed to add label. The name may already exist.");
    } finally {
      setAddingLabel(false);
    }
  };

  const handleDeleteGroupLabel = async (label: GroupLabel) => {
    if (!confirm(`Remove shared label "${label.name}"?`)) return;
    await deleteGroupLabel(groupId, label.id);
    setGroup((prev) => prev ? { ...prev, shared_labels: prev.shared_labels.filter((l) => l.id !== label.id) } : prev);
  };

  const handleTogglePriority = async (priority: Priority) => {
    if (!group) return;
    const current = group.allowed_priorities.length > 0 ? group.allowed_priorities : (["low", "medium", "high", "urgent"] as Priority[]);
    const next = current.includes(priority)
      ? current.filter((p) => p !== priority)
      : [...current, priority];
    // Keep at least one priority enabled
    if (next.length === 0) return;
    const updated = await updateGroupBoardDefaults(groupId, { allowed_priorities: next });
    setGroup((prev) => prev ? { ...prev, allowed_priorities: updated.allowed_priorities } : prev);
  };

  const handleDefaultRoleChange = async (role: "admin" | "member" | "collaborator" | "viewer") => {
    if (!group) return;
    setDefaultsError(null);
    setSavingDefaults(true);
    try {
      const updated = await updateGroupBoardDefaults(groupId, { default_board_member_role: role });
      setGroup((prev) => prev ? { ...prev, default_board_member_role: updated.default_board_member_role } : prev);
      setDefaultsSaved(true);
      setTimeout(() => setDefaultsSaved(false), 2000);
    } catch {
      setDefaultsError("Failed to save default member role.");
    } finally {
      setSavingDefaults(false);
    }
  };

  const adminMembers = members.filter(
    (m) => m.role === "admin" && m.user.id !== user.id
  );

  const isAdmin = user.is_site_admin ||
    group?.owner.id === user.id ||
    members.find((m) => m.user.id === user.id)?.role === "admin";

  const activeTab = isAdmin && searchParams.get("tab") === "settings" ? "settings" : "boards";

  const breadcrumb = group ? [
    ...(group.parent ? [{ label: group.parent_name ?? "Group", href: `/groups/${group.parent}` }] : []),
    { label: group.name },
  ] : [];

  if (loading) {
    return (
      <div className="h-full bg-gray-900 flex items-center justify-center">
        <span className="text-gray-400">Loading…</span>
      </div>
    );
  }

  if (error || !group) {
    return (
      <div className="h-full bg-gray-900 flex items-center justify-center">
        <span className="text-red-400">{error ?? "Group not found"}</span>
      </div>
    );
  }

  return (
    <div className="h-full bg-gray-900 flex flex-col">
      <Navbar user={user} onLogout={onLogout} onUserUpdated={onUserUpdated} breadcrumb={breadcrumb} />

      {joinToast && (
        <div className="flex items-center justify-between gap-3 px-4 py-2.5 bg-green-900/60 border-b border-green-700/50 text-green-300 text-sm">
          <span>You've joined <strong className="text-green-200">{joinToast}</strong>. Welcome!</span>
          <button onClick={() => setJoinToast(null)} className="text-green-500 hover:text-green-300 transition text-lg leading-none shrink-0">×</button>
        </div>
      )}

      <div className="flex items-center gap-2 px-4 py-2 bg-gray-800 border-b border-gray-700">
        <button onClick={() => navigate(group.parent ? `/groups/${group.parent}` : "/")} className="text-gray-400 hover:text-white text-sm transition">
          ← {group.parent ? (group.parent_name ?? "Group") : "Dashboard"}
        </button>
      </div>

      <main className="flex-1 overflow-y-auto p-8 max-w-5xl mx-auto w-full">
        {/* Header */}
        <div className="flex items-start justify-between mb-6">
          <div>
            <h1 className="text-white text-2xl font-bold">{group.name}</h1>
            <p className="text-gray-500 text-sm mt-1">
              {group.member_count} member{group.member_count !== 1 ? "s" : ""}
              {" · "}
              {group.board_count} board{group.board_count !== 1 ? "s" : ""}
              {group.subgroup_count > 0 && ` · ${group.subgroup_count} subgroup${group.subgroup_count !== 1 ? "s" : ""}`}
            </p>
          </div>
          {isAdmin && (
            <button
              onClick={() => setSearchParams({ tab: "settings" })}
              className="text-sm text-gray-400 hover:text-white transition"
            >
              Settings
            </button>
          )}
        </div>

        {/* Tab bar */}
        <div className="flex gap-1 border-b border-gray-700 mb-8">
          <button
            onClick={() => setSearchParams({})}
            className={`px-4 py-2 text-sm font-medium transition border-b-2 -mb-px ${
              activeTab === "boards"
                ? "text-white border-blue-500"
                : "text-gray-400 hover:text-white border-transparent"
            }`}
          >
            Boards
          </button>
          {isAdmin && (
            <button
              onClick={() => setSearchParams({ tab: "settings" })}
              className={`px-4 py-2 text-sm font-medium transition border-b-2 -mb-px ${
                activeTab === "settings"
                  ? "text-white border-blue-500"
                  : "text-gray-400 hover:text-white border-transparent"
              }`}
            >
              Settings
            </button>
          )}
        </div>

        {activeTab === "boards" && <div className="flex flex-col gap-8">

            {/* Subgroups */}
            <section>
              <div className="flex items-center gap-3 mb-3">
                <h2 className="text-white font-semibold">Subgroups</h2>
                {isAdmin && (
                  <button
                    onClick={() => setShowCreateSubgroup(true)}
                    className="text-sm text-blue-400 hover:text-blue-300 transition"
                  >
                    + Create subgroup
                  </button>
                )}
              </div>
              {subgroups.length === 0 ? (
                <p className="text-gray-500 text-sm">
                  Subgroups let you organize boards and members into nested workspaces.
                </p>
              ) : (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  {subgroups.map((sg) => (
                    <button
                      key={sg.id}
                      onClick={() => navigate(`/groups/${sg.id}`)}
                      className="bg-indigo-950/60 hover:bg-indigo-900/60 border border-indigo-800/50 rounded-xl p-4 text-left transition"
                    >
                      <div className="flex items-center gap-2 mb-1">
                        {/* Group/subgroup icon */}
                        <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4 text-indigo-400 shrink-0" viewBox="0 0 20 20" fill="currentColor">
                          <path d="M2 6a2 2 0 012-2h4l2 2h4a2 2 0 012 2v6a2 2 0 01-2 2H4a2 2 0 01-2-2V6z" />
                        </svg>
                        <p className="text-white font-medium">{sg.name}</p>
                      </div>
                      <p className="text-indigo-400/70 text-xs">
                        {sg.board_count} board{sg.board_count !== 1 ? "s" : ""} · {sg.member_count} member{sg.member_count !== 1 ? "s" : ""}
                      </p>
                    </button>
                  ))}
                </div>
              )}
            </section>

            {/* Boards */}
            <section>
              <div className="flex items-center gap-3 mb-3">
                <h2 className="text-white font-semibold">Boards</h2>
                {isAdmin && (
                  <button
                    onClick={() => setImportingBoard(true)}
                    className="text-sm text-blue-400 hover:text-blue-300 transition"
                  >
                    Import
                  </button>
                )}
                {subgroups.length > 0 && (
                  <label className="ml-auto flex items-center gap-2 cursor-pointer select-none">
                    <span className="text-xs text-gray-500">Show subgroup boards</span>
                    <button
                      role="switch"
                      aria-checked={showSubgroupBoards}
                      onClick={() => setShowSubgroupBoards((v) => !v)}
                      className={`relative w-8 h-4 rounded-full transition-colors ${showSubgroupBoards ? "bg-blue-600" : "bg-gray-600"}`}
                    >
                      <span className={`absolute top-0.5 left-0.5 w-3 h-3 bg-slate-100 rounded-full shadow transition-transform ${showSubgroupBoards ? "translate-x-4" : ""}`} />
                    </button>
                  </label>
                )}
              </div>
              <div className="flex flex-col gap-2">
                {boards.map((b) => (
                  <div key={b.id} className="group/board relative flex items-center">
                    <button
                      onClick={() => navigate(`/boards/${b.id}`)}
                      className="flex-1 bg-gray-800 hover:bg-gray-700 text-white text-left px-4 py-3 rounded-xl transition"
                    >
                      <div className="flex items-center gap-2">
                        {/* Board icon */}
                        <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4 text-gray-400 shrink-0" viewBox="0 0 20 20" fill="currentColor">
                          <path d="M5 3a2 2 0 00-2 2v2a2 2 0 002 2h2a2 2 0 002-2V5a2 2 0 00-2-2H5zM5 11a2 2 0 00-2 2v2a2 2 0 002 2h2a2 2 0 002-2v-2a2 2 0 00-2-2H5zM11 5a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2V5zM11 13a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2v-2z" />
                        </svg>
                        <p className="font-medium">{b.name}</p>
                      </div>
                      {b.description && <p className="text-sm text-gray-400 mt-0.5 ml-6">{b.description}</p>}
                    </button>
                    <button
                      onClick={() => setMovingBoard(b)}
                      title="Move to another group"
                      className="absolute right-3 opacity-0 group-hover/board:opacity-100 transition text-gray-500 hover:text-blue-400 p-1"
                    >
                      <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
                        <path d="M8 5a1 1 0 000 2h5.586l-1.293 1.293a1 1 0 001.414 1.414l3-3a1 1 0 000-1.414l-3-3a1 1 0 10-1.414 1.414L13.586 5H8z" />
                        <path d="M12 15a1 1 0 100-2H6.414l1.293-1.293a1 1 0 10-1.414-1.414l-3 3a1 1 0 000 1.414l3 3a1 1 0 001.414-1.414L6.414 15H12z" />
                      </svg>
                    </button>
                  </div>
                ))}
                {isAdmin && (
                  <button
                    onClick={() => setCreatingBoard(true)}
                    className="w-full border-2 border-dashed border-gray-700 hover:border-gray-500 hover:bg-gray-800/50 rounded-xl px-4 py-3 text-left transition group"
                  >
                    <p className="text-gray-500 group-hover:text-gray-300 font-medium transition">+ New board</p>
                  </button>
                )}
                {!isAdmin && boards.length === 0 && !showSubgroupBoards && (
                  <p className="text-gray-600 text-sm">No boards yet.</p>
                )}

                {/* Subgroup boards */}
                {showSubgroupBoards && (
                  loadingSubgroupBoards ? (
                    <p className="text-gray-500 text-sm px-1">Loading subgroup boards…</p>
                  ) : subgroupBoards.length === 0 ? (
                    <p className="text-gray-600 text-sm px-1">No boards in subgroups.</p>
                  ) : (
                    subgroupBoards.map(({ board: b, groupName }) => (
                      <button
                        key={b.id}
                        onClick={() => navigate(`/boards/${b.id}`)}
                        className="w-full bg-gray-800 hover:bg-gray-700 text-white text-left px-4 py-3 rounded-xl transition"
                      >
                        <div className="flex items-center gap-2">
                          <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4 text-gray-400 shrink-0" viewBox="0 0 20 20" fill="currentColor">
                            <path d="M5 3a2 2 0 00-2 2v2a2 2 0 002 2h2a2 2 0 002-2V5a2 2 0 00-2-2H5zM5 11a2 2 0 00-2 2v2a2 2 0 002 2h2a2 2 0 002-2v-2a2 2 0 00-2-2H5zM11 5a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2V5zM11 13a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2v-2z" />
                          </svg>
                          <p className="font-medium flex-1">{b.name}</p>
                          <span className="text-xs text-gray-500 ml-2 shrink-0">{groupName}</span>
                        </div>
                        {b.description && <p className="text-sm text-gray-400 mt-0.5 ml-6">{b.description}</p>}
                      </button>
                    ))
                  )
                )}
              </div>
            </section>
          </div>}

        {activeTab === "settings" && (
          <div className="max-w-2xl flex flex-col gap-8">

            {/* Members */}
            <section>
              <h2 className="text-white font-semibold mb-1">Members</h2>
              <p className="text-gray-500 text-sm mb-4">Manage who has access to this group and their roles.</p>
              <div className="flex flex-col gap-2">
                {members.map((m) => (
                  <div key={m.user.id} className={`flex items-center justify-between rounded-lg px-3 py-2 ${m.is_inherited ? "bg-gray-800/50" : "bg-gray-800"}`}>
                    <div className="flex items-center gap-2 min-w-0">
                      <Avatar user={m.user} size="sm" />
                      <p className={`text-sm truncate ${m.is_inherited ? "text-gray-400" : "text-white"}`}>{m.user.display_name || m.user.username}</p>
                    </div>
                    {m.is_inherited ? (
                      <div className="flex items-center gap-2 shrink-0">
                        <span className="text-xs text-gray-500 capitalize">{m.role}</span>
                        <span className="text-[10px] bg-slate-700 text-slate-400 px-1.5 py-0.5 rounded whitespace-nowrap">
                          ↑ {m.inherited_from}
                        </span>
                      </div>
                    ) : isAdmin && m.user.id !== user.id && !m.user.is_site_admin ? (
                      <div className="flex items-center gap-2 shrink-0">
                        <SelectDropdown
                          value={m.role}
                          onChange={(v) => handleRoleChange(m.user.id, v as "admin" | "member" | "viewer")}
                          options={[
                            { value: "admin", label: "Admin" },
                            { value: "member", label: "Member" },
                            { value: "viewer", label: "Viewer" },
                          ]}
                          size="xs"
                        />
                        <button
                          onClick={() => handleRemoveMember(m.user.id)}
                          className="text-gray-600 hover:text-red-400 transition text-xs"
                        >
                          Remove
                        </button>
                      </div>
                    ) : (
                      <div className="flex items-center gap-2 shrink-0">
                        <p className="text-gray-500 text-xs capitalize">{m.role}</p>
                        {m.user.is_site_admin && (
                          <span className="text-xs bg-purple-900 text-purple-300 px-1.5 py-0.5 rounded">site admin</span>
                        )}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </section>

            {/* Invite links */}
            <InviteLinkPanel groupId={groupId} />

            {/* Board defaults */}
            <section>
              <h2 className="text-white font-semibold mb-1">Board defaults</h2>
              <p className="text-gray-500 text-sm mb-4">
                These settings apply to new boards created in this group. Existing boards are not affected.
              </p>

              {/* Default member role */}
              <div className="mb-5">
                <label className="text-gray-400 text-sm block mb-2">Default member role for new boards</label>
                <div className="flex items-center gap-3">
                  <SelectDropdown
                    value={group.default_board_member_role ?? "member"}
                    onChange={(v) => handleDefaultRoleChange(v as "admin" | "member" | "collaborator" | "viewer")}
                    disabled={savingDefaults}
                    options={[
                      { value: "admin", label: "Admin" },
                      { value: "member", label: "Member" },
                      { value: "collaborator", label: "Collaborator" },
                      { value: "viewer", label: "Viewer" },
                    ]}
                  />
                  {defaultsSaved && <span className="text-green-400 text-xs">Saved</span>}
                  {defaultsError && <span className="text-red-400 text-xs">{defaultsError}</span>}
                </div>
              </div>

              {/* Allowed priorities */}
              <div className="mb-5">
                <label className="text-gray-400 text-sm block mb-2">Allowed priorities on new boards</label>
                <div className="flex flex-wrap gap-2">
                  {(["low", "medium", "high", "urgent"] as Priority[]).map((p) => {
                    const effectivePriorities = group.allowed_priorities.length > 0 ? group.allowed_priorities : (["low", "medium", "high", "urgent"] as Priority[]);
                    const active = effectivePriorities.includes(p);
                    const colorMap: Record<Priority, string> = {
                      low: "bg-green-900/60 border-green-700 text-green-300",
                      medium: "bg-yellow-900/60 border-yellow-700 text-yellow-300",
                      high: "bg-orange-900/60 border-orange-700 text-orange-300",
                      urgent: "bg-red-900/60 border-red-700 text-red-300",
                    };
                    return (
                      <button
                        key={p}
                        onClick={() => handleTogglePriority(p)}
                        className={`px-3 py-1 rounded-lg border text-xs font-medium transition capitalize ${
                          active
                            ? colorMap[p]
                            : "bg-gray-800 border-gray-600 text-gray-500 hover:border-gray-400 hover:text-gray-400"
                        }`}
                        title={active ? `Disable ${p} priority` : `Enable ${p} priority`}
                      >
                        {p}
                      </button>
                    );
                  })}
                </div>
                <p className="text-gray-600 text-xs mt-2">Click to toggle. At least one priority must remain enabled.</p>
              </div>

              {/* Shared label library */}
              <div>
                <label className="text-gray-400 text-sm block mb-2">Shared label library</label>
                <p className="text-gray-600 text-xs mb-3">Labels added here are copied to every new board created in this group.</p>
                <div className="flex flex-col gap-1.5 mb-3">
                  {(group.shared_labels ?? []).map((label) => (
                    <div key={label.id} className="flex items-center gap-2 bg-gray-800 rounded-lg px-3 py-2">
                      <span
                        className="w-3 h-3 rounded-full shrink-0"
                        style={{ backgroundColor: label.color }}
                      />
                      <span className="text-white text-sm flex-1">{label.name}</span>
                      <button
                        onClick={() => handleDeleteGroupLabel(label)}
                        className="text-gray-600 hover:text-red-400 transition text-xs"
                      >
                        Remove
                      </button>
                    </div>
                  ))}
                  {(group.shared_labels ?? []).length === 0 && (
                    <p className="text-gray-600 text-sm">No shared labels yet.</p>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <input
                    type="color"
                    value={newLabelColor}
                    onChange={(e) => setNewLabelColor(e.target.value)}
                    className="w-8 h-8 rounded cursor-pointer bg-transparent border border-gray-600"
                    title="Label color"
                  />
                  <input
                    type="text"
                    value={newLabelName}
                    onChange={(e) => setNewLabelName(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") handleAddGroupLabel(); }}
                    placeholder="Label name…"
                    className="flex-1 bg-gray-700 text-gray-200 text-sm rounded-lg px-3 py-2 border border-gray-600 focus:outline-none focus:border-blue-500"
                  />
                  <button
                    onClick={handleAddGroupLabel}
                    disabled={addingLabel || !newLabelName.trim()}
                    className="text-sm text-white bg-blue-700 hover:bg-blue-600 disabled:opacity-40 disabled:cursor-not-allowed px-3 py-2 rounded-lg transition"
                  >
                    Add
                  </button>
                </div>
                {labelError && <p className="text-red-400 text-xs mt-1">{labelError}</p>}
              </div>
            </section>

            {/* Danger zone */}
            <section className="border border-red-900/50 rounded-xl p-5">
              <h2 className="text-red-400 font-semibold mb-1">Danger zone</h2>
              <p className="text-gray-500 text-sm mb-4">These actions are permanent and cannot be undone.</p>
              <div className="flex flex-wrap gap-3">
                {group.owner.id === user.id && (
                  <button
                    onClick={() => { setTransferError(null); setShowTransferModal(true); }}
                    className="text-sm text-red-500 border border-red-800 hover:bg-red-900/30 px-4 py-2 rounded-lg transition"
                  >
                    Transfer ownership
                  </button>
                )}
                <button
                  onClick={handleDeleteGroup}
                  className="text-sm text-red-500 border border-red-800 hover:bg-red-900/30 px-4 py-2 rounded-lg transition"
                >
                  Delete group
                </button>
              </div>
            </section>
          </div>
        )}
      </main>

      {creatingBoard && (
        <CreateBoardModal
          onConfirm={handleCreateBoard}
          onCancel={() => setCreatingBoard(false)}
        />
      )}

      {movingBoard && (
        <MoveBoardModal
          board={movingBoard}
          onMoved={(updated) => {
            // Remove from this group's list if moved elsewhere
            if (updated.group !== groupId) {
              setBoards((prev) => prev.filter((b) => b.id !== updated.id));
            }
            setMovingBoard(null);
          }}
          onClose={() => setMovingBoard(null)}
        />
      )}

      {importingBoard && (
        <ImportBoardModal
          onImport={handleImportBoard}
          onCancel={() => setImportingBoard(false)}
        />
      )}

      {showCreateSubgroup && (
        <CreateGroupModal
          parentGroup={group}
          onCreated={(sg) => { setSubgroups((prev) => [...prev, sg]); navigate(`/groups/${sg.id}`); }}
          onClose={() => setShowCreateSubgroup(false)}
        />
      )}

      {showTransferModal && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
          <div className="bg-gray-800 rounded-2xl p-6 w-full max-w-md shadow-xl">
            <h2 className="text-white font-semibold text-lg mb-1">Transfer ownership</h2>
            <p className="text-gray-400 text-sm mb-5">
              Transfer ownership of <span className="text-white font-medium">{group.name}</span> to another admin.
              You will remain as an admin after the transfer.
            </p>

            <div className="flex flex-col gap-4">
              <div>
                <label className="text-gray-400 text-sm block mb-1">New owner</label>
                {adminMembers.length === 0 ? (
                  <p className="text-gray-500 text-sm">No other admins found. Promote a member to admin first.</p>
                ) : (
                  <SelectDropdown
                    value={String(transferNewOwnerId)}
                    onChange={(v) => setTransferNewOwnerId(v === "" ? "" : Number(v))}
                    options={[
                      { value: "", label: "Select an admin…" },
                      ...adminMembers.map((m) => ({
                        value: String(m.user.id),
                        label: m.user.display_name || m.user.username,
                      })),
                    ]}
                    className="w-full"
                  />
                )}
              </div>

              <div>
                <label className="text-gray-400 text-sm block mb-1">
                  Type the group name to confirm: <span className="text-white font-medium">{group.name}</span>
                </label>
                <input
                  type="text"
                  value={transferConfirmation}
                  onChange={(e) => setTransferConfirmation(e.target.value)}
                  placeholder={group.name}
                  className="w-full bg-gray-700 text-gray-200 text-sm rounded-lg px-3 py-2 border border-gray-600 focus:outline-none focus:border-blue-500"
                />
              </div>

              {transferError && (
                <p className="text-red-400 text-sm">{transferError}</p>
              )}

              <div className="flex gap-3 justify-end pt-1">
                <button
                  onClick={() => { setShowTransferModal(false); setTransferConfirmation(""); setTransferNewOwnerId(""); setTransferError(null); }}
                  className="text-sm text-gray-400 hover:text-white px-4 py-2 rounded-lg transition"
                >
                  Cancel
                </button>
                <button
                  onClick={handleTransferOwnership}
                  disabled={transferring || transferNewOwnerId === "" || transferConfirmation !== group.name}
                  className="text-sm text-white bg-red-700 hover:bg-red-600 disabled:opacity-40 disabled:cursor-not-allowed px-4 py-2 rounded-lg transition"
                >
                  {transferring ? "Transferring…" : "Transfer ownership"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
