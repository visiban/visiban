import { useState } from "react";
import type { BoardFull, BoardMembership } from "../../types";
import { userDisplayName } from "../../types";
import { setBoardMember, removeBoardMember } from "../../api/boards";
import type { BoardRole } from "../../api/boards";

interface Props {
  board: BoardFull;
  onClose: () => void;
  onMembersChanged: (members: BoardMembership[]) => void;
}

const ROLES: { value: BoardRole; label: string; description: string }[] = [
  { value: "admin",        label: "Admin",        description: "Full access — manage members, columns, swimlanes" },
  { value: "member",       label: "Member",        description: "Create, edit and move cards" },
  { value: "collaborator", label: "Collaborator",  description: "Comment on cards only" },
  { value: "viewer",       label: "Viewer",        description: "Read-only access" },
];

export default function BoardMembersModal({ board, onClose, onMembersChanged }: Props) {
  const [members, setMembers] = useState<BoardMembership[]>(board.members);
  const [saving, setSaving] = useState<number | null>(null);

  const handleRoleChange = async (userId: number, role: BoardRole) => {
    setSaving(userId);
    try {
      const updated = await setBoardMember(board.id, userId, role);
      const next = members.map((m) =>
        m.user.id === userId ? { ...m, role: updated.role } : m
      );
      // If user wasn't a direct member yet, add them
      if (!next.find((m) => m.user.id === userId)) {
        next.push(updated);
      }
      setMembers(next);
      onMembersChanged(next);
    } finally {
      setSaving(null);
    }
  };

  const handleRemove = async (userId: number) => {
    if (!confirm("Remove this member's direct board role? They may still have access via group membership.")) return;
    setSaving(userId);
    try {
      await removeBoardMember(board.id, userId);
      const next = members.filter((m) => m.user.id !== userId);
      setMembers(next);
      onMembersChanged(next);
    } finally {
      setSaving(null);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg mx-4 flex flex-col max-h-[80vh]">
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
          <h2 className="text-base font-semibold text-gray-800">Board Members</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 transition text-xl leading-none">×</button>
        </div>

        <div className="overflow-y-auto flex-1 px-6 py-4">
          {/* Role legend */}
          <div className="mb-4 bg-gray-50 rounded-lg p-3 grid grid-cols-2 gap-x-4 gap-y-1">
            {ROLES.map((r) => (
              <div key={r.value} className="text-xs text-gray-500">
                <span className="font-medium text-gray-700 capitalize">{r.label}</span> — {r.description}
              </div>
            ))}
          </div>

          <div className="flex flex-col gap-2">
            {members.map((m) => {
              const isSelf = m.user.id === board.members.find(() => true)?.user.id; // can't remove yourself
              const isDisabled = saving === m.user.id;
              return (
                <div key={m.user.id} className="flex items-center justify-between gap-3 py-2 border-b border-gray-50 last:border-0">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-gray-800 truncate">{userDisplayName(m.user)}</p>
                    <p className="text-xs text-gray-400 truncate">{m.user.email}</p>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <select
                      value={m.role}
                      disabled={isDisabled}
                      onChange={(e) => handleRoleChange(m.user.id, e.target.value as BoardRole)}
                      className="text-xs border border-gray-200 rounded-lg px-2 py-1.5 outline-none focus:border-blue-400 disabled:opacity-50"
                    >
                      {ROLES.map((r) => (
                        <option key={r.value} value={r.value}>{r.label}</option>
                      ))}
                    </select>
                    {!isSelf && m.id !== null && (
                      <button
                        onClick={() => handleRemove(m.user.id)}
                        disabled={isDisabled}
                        className="text-xs text-gray-400 hover:text-red-500 transition disabled:opacity-50"
                        title="Remove direct board role"
                      >
                        ✕
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        <div className="px-6 py-3 border-t border-gray-100 text-xs text-gray-400">
          Members inherited from group membership are shown here. Assigning a role creates a direct override.
        </div>
      </div>
    </div>
  );
}
