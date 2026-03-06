import { useEffect, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import {
  getGroup, getGroupMembers, getSubgroups, getGroupBoards,
  createGroupBoard, removeGroupMember, deleteGroup,
} from "../api/groups";
import Navbar from "../components/Layout/Navbar";
import CreateGroupModal from "../components/Group/CreateGroupModal";
import InviteLinkPanel from "../components/Group/InviteLinkPanel";
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

  const [group, setGroup] = useState<Group | null>(null);
  const [subgroups, setSubgroups] = useState<Group[]>([]);
  const [boards, setBoards] = useState<Board[]>([]);
  const [members, setMembers] = useState<GroupMembership[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [showCreateSubgroup, setShowCreateSubgroup] = useState(false);
  const [creatingBoard, setCreatingBoard] = useState(false);
  const [boardName, setBoardName] = useState("");

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

  const handleCreateBoard = async () => {
    if (!boardName.trim()) return;
    const board = await createGroupBoard(groupId, { name: boardName.trim() });
    setBoards((prev) => [...prev, board]);
    setBoardName("");
    setCreatingBoard(false);
    navigate(`/boards/${board.id}`);
  };

  const handleRemoveMember = async (userId: number) => {
    if (!confirm("Remove this member?")) return;
    await removeGroupMember(groupId, userId);
    setMembers((prev) => prev.filter((m) => m.user.id !== userId));
  };

  const handleDeleteGroup = async () => {
    if (!confirm(`Delete group "${group?.name}"? This cannot be undone.`)) return;
    await deleteGroup(groupId);
    navigate("/");
  };

  const isAdmin = group?.owner.id === user.id ||
    members.find((m) => m.user.id === user.id)?.role === "admin";

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

      <div className="flex items-center gap-2 px-4 py-2 bg-gray-800 border-b border-gray-700">
        <button onClick={() => navigate(group.parent ? `/groups/${group.parent}` : "/")} className="text-gray-400 hover:text-white text-sm transition">
          ← {group.parent ? (group.parent_name ?? "Group") : "Dashboard"}
        </button>
      </div>

      <main className="flex-1 p-8 max-w-5xl mx-auto w-full">
        {/* Header */}
        <div className="flex items-start justify-between mb-8">
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
            <div className="flex gap-2">
              <button
                onClick={handleDeleteGroup}
                className="text-sm text-red-500 hover:text-red-400 transition"
              >
                Delete group
              </button>
            </div>
          )}
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
          <div className="lg:col-span-2 flex flex-col gap-8">

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
              <div className="flex items-center justify-between mb-3">
                <h2 className="text-white font-semibold">Boards</h2>
                {isAdmin && (
                  <button onClick={() => setCreatingBoard(true)} className="text-sm text-blue-400 hover:text-blue-300 transition">
                    + New board
                  </button>
                )}
              </div>
              <div className="flex flex-col gap-2">
                {boards.map((b) => (
                  <button
                    key={b.id}
                    onClick={() => navigate(`/boards/${b.id}`)}
                    className="w-full bg-gray-800 hover:bg-gray-700 text-white text-left px-4 py-3 rounded-xl transition"
                  >
                    <p className="font-medium">{b.name}</p>
                    {b.description && <p className="text-sm text-gray-400 mt-0.5">{b.description}</p>}
                  </button>
                ))}
                {boards.length === 0 && !creatingBoard && (
                  <p className="text-gray-600 text-sm">No boards yet.</p>
                )}
                {creatingBoard && (
                  <div className="bg-gray-800 rounded-xl p-4">
                    <input
                      autoFocus
                      value={boardName}
                      onChange={(e) => setBoardName(e.target.value)}
                      onKeyDown={(e) => { if (e.key === "Enter") handleCreateBoard(); if (e.key === "Escape") setCreatingBoard(false); }}
                      placeholder="Board name…"
                      className="w-full bg-gray-700 text-white rounded-lg px-3 py-2 outline-none text-sm mb-3"
                    />
                    <div className="flex gap-2">
                      <button onClick={handleCreateBoard} className="bg-blue-600 text-white text-sm px-3 py-1.5 rounded-lg hover:bg-blue-700">Create</button>
                      <button onClick={() => setCreatingBoard(false)} className="text-gray-400 text-sm hover:text-white">Cancel</button>
                    </div>
                  </div>
                )}
              </div>
            </section>
          </div>

          {/* Sidebar */}
          <div className="flex flex-col gap-6">
            {/* Invite link — admins only */}
            {isAdmin && <InviteLinkPanel groupId={groupId} />}

            {/* Members */}
            <section>
              <h2 className="text-white font-semibold mb-3">Members</h2>
              <div className="flex flex-col gap-2">
                {members.map((m) => (
                  <div key={m.user.id} className="flex items-center justify-between bg-gray-800 rounded-lg px-3 py-2">
                    <div>
                      <p className="text-white text-sm">{m.user.display_name || m.user.username}</p>
                      <p className="text-gray-500 text-xs capitalize">{m.role}</p>
                    </div>
                    {isAdmin && m.user.id !== user.id && (
                      <button
                        onClick={() => handleRemoveMember(m.user.id)}
                        className="text-gray-600 hover:text-red-400 transition text-xs"
                      >
                        Remove
                      </button>
                    )}
                  </div>
                ))}
              </div>
            </section>
          </div>
        </div>
      </main>

      {showCreateSubgroup && (
        <CreateGroupModal
          parentGroup={group}
          onCreated={(sg) => { setSubgroups((prev) => [...prev, sg]); navigate(`/groups/${sg.id}`); }}
          onClose={() => setShowCreateSubgroup(false)}
        />
      )}
    </div>
  );
}
