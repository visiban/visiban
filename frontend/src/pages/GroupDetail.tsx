import { useEffect, useState } from "react";
import { useParams, useNavigate, useSearchParams, useLocation } from "react-router-dom";
import Avatar from "../components/Common/Avatar";
import {
  getGroup, getGroupMembers, getSubgroups, getGroupBoards,
  createGroupBoard, removeGroupMember, updateGroupMemberRole, deleteGroup,
  transferGroupOwnership,
} from "../api/groups";
import Navbar from "../components/Layout/Navbar";
import CreateGroupModal from "../components/Group/CreateGroupModal";
import InviteLinkPanel from "../components/Group/InviteLinkPanel";
import MoveBoardModal from "../components/Board/MoveBoardModal";
import CreateBoardModal from "../components/Board/CreateBoardModal";
import ImportBoardModal from "../components/Board/ImportBoardModal";
import { importBoard } from "../api/boards";
import type { Board, Group, GroupMembership, User } from "../types";

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

  const adminMembers = members.filter(
    (m) => m.role === "admin" && m.user.id !== user.id
  );

  const isAdmin = group?.owner.id === user.id ||
    members.find((m) => m.user.id === user.id)?.role === "admin";

  const activeTab = isAdmin && searchParams.get("tab") === "settings" ? "settings" : "boards";

  const breadcrumb = group ? [
    ...(group.parent ? [{ label: group.parent_name ?? "Group", href: `/groups/${group.parent}` }] : []),
    { label: group.name },
  ] : [];

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-900 flex items-center justify-center">
        <span className="text-gray-400">Loading…</span>
      </div>
    );
  }

  if (error || !group) {
    return (
      <div className="min-h-screen bg-gray-900 flex items-center justify-center">
        <span className="text-red-400">{error ?? "Group not found"}</span>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-900 flex flex-col">
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

      <main className="flex-1 p-8 max-w-5xl mx-auto w-full">
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
              <h2 className="text-white font-semibold mb-3">Subgroups</h2>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {subgroups.map((sg) => (
                  <button
                    key={sg.id}
                    onClick={() => navigate(`/groups/${sg.id}`)}
                    className="bg-gray-800 hover:bg-gray-700 rounded-xl p-4 text-left transition"
                  >
                    <p className="text-white font-medium">{sg.name}</p>
                    <p className="text-gray-500 text-xs mt-1">
                      {sg.board_count} board{sg.board_count !== 1 ? "s" : ""} · {sg.member_count} member{sg.member_count !== 1 ? "s" : ""}
                    </p>
                  </button>
                ))}
                {isAdmin && (
                  <button
                    onClick={() => setShowCreateSubgroup(true)}
                    className="border-2 border-dashed border-gray-700 hover:border-gray-500 hover:bg-gray-800/50 rounded-xl p-4 text-left transition group"
                  >
                    <p className="text-gray-500 group-hover:text-gray-300 font-medium transition">+ New subgroup</p>
                    <p className="text-gray-600 text-xs mt-1">Create a nested group inside {group.name}</p>
                  </button>
                )}
                {!isAdmin && subgroups.length === 0 && (
                  <p className="text-gray-600 text-sm col-span-2">No subgroups.</p>
                )}
              </div>
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
                      <p className="font-medium">{b.name}</p>
                      {b.description && <p className="text-sm text-gray-400 mt-0.5">{b.description}</p>}
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
                        <div className="flex items-center justify-between">
                          <p className="font-medium">{b.name}</p>
                          <span className="text-xs text-gray-500 ml-2 shrink-0">{groupName}</span>
                        </div>
                        {b.description && <p className="text-sm text-gray-400 mt-0.5">{b.description}</p>}
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
                  <div key={m.user.id} className="flex items-center justify-between bg-gray-800 rounded-lg px-3 py-2">
                    <div className="flex items-center gap-2">
                      <Avatar user={m.user} size="sm" />
                      <p className="text-white text-sm">{m.user.display_name || m.user.username}</p>
                    </div>
                    {isAdmin && m.user.id !== user.id && !m.user.is_site_admin ? (
                      <div className="flex items-center gap-2">
                        <select
                          value={m.role}
                          onChange={(e) => handleRoleChange(m.user.id, e.target.value as "admin" | "member" | "viewer")}
                          className="bg-gray-700 text-gray-300 text-xs rounded px-2 py-1 border border-gray-600 focus:outline-none"
                        >
                          <option value="viewer">Viewer</option>
                          <option value="member">Member</option>
                          <option value="admin">Admin</option>
                        </select>
                        <button
                          onClick={() => handleRemoveMember(m.user.id)}
                          className="text-gray-600 hover:text-red-400 transition text-xs"
                        >
                          Remove
                        </button>
                      </div>
                    ) : (
                      <div className="flex items-center gap-2">
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
                  <select
                    value={transferNewOwnerId}
                    onChange={(e) => setTransferNewOwnerId(e.target.value === "" ? "" : Number(e.target.value))}
                    className="w-full bg-gray-700 text-gray-200 text-sm rounded-lg px-3 py-2 border border-gray-600 focus:outline-none focus:border-blue-500"
                  >
                    <option value="">Select an admin…</option>
                    {adminMembers.map((m) => (
                      <option key={m.user.id} value={m.user.id}>
                        {m.user.display_name || m.user.username}
                      </option>
                    ))}
                  </select>
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
