import { useState } from "react";
import { useEscapeStack } from "../../hooks/useEscapeStack";
import type { BoardFull, BoardMembership } from "../../types";
import { userDisplayName } from "../../types";
import { setBoardMember, removeBoardMember } from "../../api/boards";
import type { BoardRole } from "../../api/boards";
import SelectDropdown from "../Common/SelectDropdown";

interface Props {
  board: BoardFull;
  onClose: () => void;
  onMembersChanged: (members: BoardMembership[]) => void;
}

const ROLES: { value: BoardRole; label: string; description: string }[] = [
  { value: "admin",        label: "Admin",        description: "Full access — manage members, columns, swimlanes" },
  { value: "member",       label: "Member",        description: "Create, edit and move cards" },
  { value: "collaborator", label: "Collaborator",  description: "Can comment and upload files — cannot create or move cards" },
  { value: "viewer",       label: "Viewer",        description: "Read-only — cannot comment or upload" },
];

const ROLE_OPTIONS = ROLES.map((r) => ({
  value: r.value,
  label: r.label,
}));

export default function BoardMembersModal({ board, onClose, onMembersChanged }: Props) {
  const [members, setMembers] = useState<BoardMembership[]>(board.members);
  const [saving, setSaving] = useState<number | null>(null);
  const [confirmRemoveUserId, setConfirmRemoveUserId] = useState<number | null>(null);

  const handleRoleChange = async (userId: number, role: BoardRole) => {
    setSaving(userId);
    try {
      const updated = await setBoardMember(board.id, userId, role);
      const next = members.map((m) =>
        m.user.id === userId ? { ...m, role: updated.role } : m
      );
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
    setConfirmRemoveUserId(null);
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

  useEscapeStack(onClose, 40);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="bg-slate-800 rounded-2xl shadow-2xl w-full max-w-lg mx-4 flex flex-col max-h-[80vh]">
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-700">
          <h2 className="text-base font-semibold text-white">Board Members</h2>
          <button onClick={onClose} className="text-slate-400 hover:text-white transition text-xl leading-none">×</button>
        </div>

        <div className="overflow-y-auto flex-1 px-6 py-4">
          <div className="mb-4 bg-slate-700 rounded-lg p-3 grid grid-cols-2 gap-x-4 gap-y-1">
            {ROLES.map((r) => (
              <div key={r.value} className="text-xs text-slate-400">
                <span className="font-medium text-slate-200 capitalize">{r.label}</span> — {r.description}
              </div>
            ))}
          </div>

          <div className="flex flex-col gap-2">
            {members.map((m) => {
              const isSelf = m.user.id === board.members.find(() => true)?.user.id;
              const isDisabled = saving === m.user.id;
              return (
                <div key={m.user.id} className="flex items-center justify-between gap-3 py-2 border-b border-slate-700 last:border-0">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-white truncate">{userDisplayName(m.user)}</p>
                    <p className="text-xs text-slate-500 truncate">{m.user.email}</p>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <SelectDropdown
                      value={m.role}
                      disabled={isDisabled}
                      onChange={(v) => handleRoleChange(m.user.id, v)}
                      options={ROLE_OPTIONS}
                      size="xs"
                    />
                    {!isSelf && m.id !== null && (
                      confirmRemoveUserId === m.user.id ? (
                        <div className="flex items-center gap-1.5 shrink-0">
                          <span className="text-[11px] text-slate-400">Remove?</span>
                          <button onClick={() => handleRemove(m.user.id)} className="text-[11px] text-red-400 hover:text-red-300 transition focus:outline-none focus:ring-1 focus:ring-red-500 rounded px-1">Yes</button>
                          <button onClick={() => setConfirmRemoveUserId(null)} className="text-[11px] text-slate-500 hover:text-slate-300 transition focus:outline-none focus:ring-1 focus:ring-slate-500 rounded px-1">No</button>
                        </div>
                      ) : (
                        <button
                          onClick={() => setConfirmRemoveUserId(m.user.id)}
                          disabled={isDisabled}
                          className="text-xs text-slate-500 hover:text-red-400 transition disabled:opacity-50"
                          title="Remove direct board role"
                        >
                          ✕
                        </button>
                      )
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        <div className="px-6 py-3 border-t border-slate-700 text-xs text-slate-500">
          Members inherited from group membership are shown here. Assigning a role creates a direct override.
        </div>
      </div>
    </div>
  );
}
