import { useEffect, useState } from "react";
import { listGroups } from "../../api/groups";
import { moveBoardToGroup } from "../../api/boards";
import { buildGroupTree } from "../Group/GroupTree";
import type { Board, Group } from "../../types";

interface TreeNode {
  group: Group;
  children: TreeNode[];
}

interface Props {
  board: Board;
  onMoved: (updated: Board) => void;
  onClose: () => void;
}

export default function MoveBoardModal({ board, onMoved, onClose }: Props) {
  const [groups, setGroups] = useState<Group[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    listGroups().then(setGroups).finally(() => setLoading(false));
  }, []);

  const handleMove = async (groupId: number | null) => {
    if (groupId === board.group) { onClose(); return; }
    setSaving(true);
    try {
      const updated = await moveBoardToGroup(board.id, groupId);
      onMoved(updated);
      onClose();
    } finally {
      setSaving(false);
    }
  };

  const roots = buildGroupTree(groups);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-sm p-6">
        <h2 className="text-lg font-semibold text-gray-900 mb-1">Move board</h2>
        <p className="text-sm text-gray-500 mb-4">
          Moving <span className="font-medium text-gray-700">"{board.name}"</span> to:
        </p>

        {loading ? (
          <p className="text-sm text-gray-400 py-4 text-center">Loading groups…</p>
        ) : (
          <div className="flex flex-col max-h-72 overflow-y-auto -mx-2 px-2">
            {/* Personal */}
            <PickerRow
              label="Personal (no group)"
              isCurrent={board.group === null}
              disabled={saving}
              depth={0}
              isLast={roots.length === 0}
              icon="🏠"
              onSelect={() => handleMove(null)}
            />

            {roots.length > 0 && <div className="my-1 h-px bg-gray-100" />}

            {/* Nested groups */}
            {roots.map((node, i) => (
              <GroupPickerNode
                key={node.group.id}
                node={node}
                currentGroupId={board.group}
                disabled={saving}
                onSelect={handleMove}
                isLast={i === roots.length - 1}
                depth={0}
              />
            ))}

            {groups.length === 0 && (
              <p className="text-sm text-gray-400 px-3 py-2">No groups available.</p>
            )}
          </div>
        )}

        <div className="flex justify-end mt-5">
          <button onClick={onClose} className="text-sm text-gray-500 hover:text-gray-700 px-3 py-1.5">
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

function GroupPickerNode({
  node, currentGroupId, disabled, onSelect, isLast, depth,
}: {
  node: TreeNode;
  currentGroupId: number | null;
  disabled: boolean;
  onSelect: (id: number) => void;
  isLast: boolean;
  depth: number;
}) {
  return (
    <div>
      <PickerRow
        label={node.group.name}
        isCurrent={currentGroupId === node.group.id}
        disabled={disabled}
        depth={depth}
        isLast={isLast && node.children.length === 0}
        onSelect={() => onSelect(node.group.id)}
      />
      {node.children.length > 0 && (
        <div className="relative" style={{ marginLeft: `${0.75 + depth * 1.25}rem` }}>
          {/* Vertical guide */}
          <div className="absolute left-0 top-0 bottom-0 w-px bg-gray-200" />
          {node.children.map((child, i) => (
            <div key={child.group.id} className="relative pl-3">
              {/* Horizontal connector */}
              <div className="absolute left-0 top-[50%] w-3 h-px bg-gray-200 -translate-y-px" />
              {/* Cut vertical line at midpoint of last child */}
              {i === node.children.length - 1 && (
                <div className="absolute left-[-1px] top-0 h-[50%] w-px bg-white" style={{ top: "50%" }} />
              )}
              <GroupPickerNode
                node={child}
                currentGroupId={currentGroupId}
                disabled={disabled}
                onSelect={onSelect}
                isLast={i === node.children.length - 1}
                depth={depth + 1}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function PickerRow({
  label, isCurrent, disabled, depth, isLast, icon = "👥", onSelect,
}: {
  label: string;
  isCurrent: boolean;
  disabled: boolean;
  depth: number;
  isLast: boolean;
  icon?: string;
  onSelect: () => void;
}) {
  return (
    <button
      onClick={onSelect}
      disabled={disabled}
      className={`flex items-center gap-2 w-full px-3 py-2 rounded-lg text-left transition text-sm ${
        isCurrent
          ? "bg-blue-50 text-blue-700 font-medium"
          : "hover:bg-gray-50 text-gray-700"
      } disabled:opacity-50`}
    >
      <span>{icon}</span>
      <span className="flex-1 truncate">{label}</span>
      {isCurrent && <span className="text-xs text-blue-400 shrink-0">current</span>}
    </button>
  );
}
