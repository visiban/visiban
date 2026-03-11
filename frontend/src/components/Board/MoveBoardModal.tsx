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
  const [selected, setSelected] = useState<number | null>(board.group);

  useEffect(() => {
    listGroups().then(setGroups).finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  const handleMove = async () => {
    if (selected === board.group) { onClose(); return; }
    setSaving(true);
    try {
      const updated = await moveBoardToGroup(board.id, selected);
      onMoved(updated);
      onClose();
    } finally {
      setSaving(false);
    }
  };

  const roots = buildGroupTree(groups);
  const hasChanged = selected !== board.group;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="bg-slate-800 rounded-2xl shadow-2xl w-full max-w-sm p-6">
        <h2 className="text-lg font-semibold text-white mb-1">Move board</h2>
        <p className="text-sm text-slate-400 mb-4">
          Moving <span className="font-medium text-slate-200">"{board.name}"</span> to:
        </p>

        {loading ? (
          <p className="text-sm text-slate-500 py-4 text-center">Loading groups…</p>
        ) : (
          <div className="flex flex-col max-h-72 overflow-y-auto -mx-2 px-2">
            <PickerRow
              label="Personal (no group)"
              icon="🏠"
              selected={selected === null}
              onSelect={() => setSelected(null)}
            />

            {roots.length > 0 && <div className="my-1 h-px bg-slate-700" />}

            {roots.map((node) => (
              <GroupPickerNode
                key={node.group.id}
                node={node}
                selected={selected}
                onSelect={setSelected}
              />
            ))}

            {groups.length === 0 && (
              <p className="text-sm text-slate-500 px-3 py-2">No groups available.</p>
            )}
          </div>
        )}

        <div className="flex justify-end gap-2 mt-5">
          <button
            onClick={onClose}
            className="text-sm text-slate-400 hover:text-white px-3 py-1.5 transition"
          >
            Cancel
          </button>
          <button
            onClick={handleMove}
            disabled={!hasChanged || saving}
            className="text-sm bg-blue-600 text-white px-4 py-1.5 rounded-lg hover:bg-blue-700 disabled:opacity-40 transition"
          >
            {saving ? "Moving…" : "Move"}
          </button>
        </div>
      </div>
    </div>
  );
}

function GroupPickerNode({
  node, selected, onSelect, depth = 0,
}: {
  node: TreeNode;
  selected: number | null;
  onSelect: (id: number | null) => void;
  depth?: number;
}) {
  const [expanded, setExpanded] = useState(false);
  const hasChildren = node.children.length > 0;

  return (
    <div>
      <div className="flex items-center gap-1">
        <button
          onClick={() => setExpanded((v) => !v)}
          className={`shrink-0 w-5 h-5 flex items-center justify-center text-slate-500 hover:text-slate-300 transition-transform duration-150 ${expanded ? "rotate-90" : ""} ${!hasChildren ? "opacity-0 pointer-events-none" : ""}`}
        >
          <svg className="w-2.5 h-2.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
          </svg>
        </button>

        <PickerRow
          label={node.group.name}
          icon="👥"
          selected={selected === node.group.id}
          onSelect={() => onSelect(node.group.id)}
        />
      </div>

      {hasChildren && expanded && (
        <div className="relative ml-[22px]">
          <div className="absolute left-0 top-0 bottom-0 w-px bg-slate-600" />
          {node.children.map((child, i) => {
            const isLast = i === node.children.length - 1;
            return (
              <div key={child.group.id} className="relative pl-3">
                <div className="absolute left-0 top-[50%] w-3 h-px bg-slate-600 -translate-y-px" />
                {isLast && (
                  <div className="absolute left-[-1px] w-px bg-slate-800" style={{ top: "50%", bottom: 0 }} />
                )}
                <GroupPickerNode
                  node={child}
                  selected={selected}
                  onSelect={onSelect}
                  depth={depth + 1}
                />
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function PickerRow({
  label, icon, selected, onSelect,
}: {
  label: string;
  icon: string;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      onClick={onSelect}
      className={`flex items-center gap-2 flex-1 px-3 py-2 rounded-lg text-left transition text-sm ${
        selected ? "bg-blue-900/50 text-blue-300" : "hover:bg-slate-700 text-slate-300"
      }`}
    >
      <span className={`shrink-0 w-3.5 h-3.5 rounded-full border-2 flex items-center justify-center transition ${
        selected ? "border-blue-400" : "border-slate-500"
      }`}>
        {selected && <span className="w-1.5 h-1.5 rounded-full bg-blue-400" />}
      </span>
      <span>{icon}</span>
      <span className="flex-1 truncate font-medium">{label}</span>
    </button>
  );
}
