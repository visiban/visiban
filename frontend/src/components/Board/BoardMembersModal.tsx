import { useState } from "react";
import { useConfirmFocusReturn } from "../../hooks/useConfirmFocusReturn";
import type { BoardFull, EffectiveBoardMember } from "../../types";
import { userDisplayName } from "../../types";
import { setBoardMember, removeBoardMember } from "../../api/boards";
import type { BoardRole } from "../../api/boards";
import SelectDropdown from "../Common/SelectDropdown";
import ModalWrapper from "../shared/ModalWrapper";

interface Props {
  board: BoardFull;
  onClose: () => void;
  onMembersChanged: (members: EffectiveBoardMember[]) => void;
  /** The requesting user's own `is_site_admin` (#1290) — only a site admin may
   *  change or remove a member who is a site admin. */
  currentUserIsSiteAdmin?: boolean;
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

export default function BoardMembersModal({ board, onClose, onMembersChanged, currentUserIsSiteAdmin = false }: Props) {
  const [members, setMembers] = useState<EffectiveBoardMember[]>(board.members);
  const [saving, setSaving] = useState<number | null>(null);
  const [confirmRemoveUserId, setConfirmRemoveUserId] = useState<number | null>(null);
  const removeTriggerRef = useConfirmFocusReturn(confirmRemoveUserId);

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

  return (
    <ModalWrapper open={true} onClose={onClose} title="Board Members">
      <div className="mb-4 bg-surface-hover rounded-lg p-3 grid grid-cols-2 gap-x-4 gap-y-1">
        {ROLES.map((r) => (
          <div key={r.value} className="text-xs text-fg-tertiary">
            <span className="font-medium text-fg capitalize">{r.label}</span> — {r.description}
          </div>
        ))}
      </div>

      <div className="flex flex-col gap-2 max-h-[50vh] overflow-y-auto">
        {members.map((m) => {
          const isSelf = m.user.id === board.members.find(() => true)?.user.id;
          const isDisabled = saving === m.user.id;
          // Keyed on the member's real site-admin flag, as the server is — not
          // on `role`, whose "site_admin" value reflects all-content access (#1290).
          // A row without the field falls back to the role, failing closed.
          const isLocked = (m.is_site_admin ?? m.role === "site_admin") && !currentUserIsSiteAdmin;
          return (
            <div key={m.user.id} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 py-2 border-b border-line last:border-0">
              <div className="min-w-0">
                <p className="text-sm font-medium text-fg truncate">{userDisplayName(m.user)}</p>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                {isLocked ? (
                  <span className="text-xs text-fg-secondary capitalize px-2 py-1 bg-surface-hover rounded" title="Site administrator — role managed at the instance level">
                    {m.role === "site_admin" ? "site admin" : m.role}
                  </span>
                ) : (
                <SelectDropdown
                  value={m.role as BoardRole}
                  disabled={isDisabled}
                  onChange={(v) => handleRoleChange(m.user.id, v)}
                  options={ROLE_OPTIONS}
                  placeholder={m.role === "site_admin" ? "Site admin" : undefined}
                  size="xs"
                />
                )}
                {!isSelf && !isLocked && m.id !== null && (
                  <button
                    ref={removeTriggerRef(m.user.id)}
                    onClick={() => setConfirmRemoveUserId(m.user.id)}
                    disabled={isDisabled}
                    className="text-xs text-fg-muted hover:text-danger transition disabled:opacity-40 focus:outline-none focus:ring-2 focus:ring-danger-emphasis rounded"
                    title="Remove direct board role"
                  >
                    &#10005;
                  </button>
                )}
              </div>
              {/* Inline confirm follows the BoardSettingsModal member-removal pattern
                  (frontend/CLAUDE.md § Modals and dialogs): full sentence, Confirm/Cancel. */}
              {!isSelf && !isLocked && m.id !== null && confirmRemoveUserId === m.user.id && (
                <div className="basis-full flex flex-wrap items-center gap-2 text-xs">
                  <span className="text-fg-tertiary">
                    Remove <span className="text-fg font-medium">{userDisplayName(m.user)}</span> from this board?
                  </span>
                  <button
                    onClick={() => handleRemove(m.user.id)}
                    className="text-danger hover:text-danger font-medium transition rounded focus:outline-none focus:ring-2 focus:ring-danger-emphasis"
                  >
                    Confirm
                  </button>
                  <button
                    onClick={() => setConfirmRemoveUserId(null)}
                    className="text-fg-tertiary hover:text-fg transition rounded focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
                  >
                    Cancel
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div className="border-t border-line mt-4 pt-3 text-xs text-fg-muted">
        Members inherited from group membership are shown here. Assigning a role creates a direct override.
      </div>
    </ModalWrapper>
  );
}
