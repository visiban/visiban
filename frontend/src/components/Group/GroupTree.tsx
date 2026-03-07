import { useState } from "react";
import { useNavigate } from "react-router-dom";
import type { Group } from "../../types";
import CreateGroupModal from "./CreateGroupModal";

interface TreeNode {
  group: Group;
  children: TreeNode[];
}

export function buildGroupTree(groups: Group[]): TreeNode[] {
  const ids = new Set(groups.map((g) => g.id));
  const map = new Map<number, TreeNode>();
  groups.forEach((g) => map.set(g.id, { group: g, children: [] }));

  const roots: TreeNode[] = [];
  groups.forEach((g) => {
    if (g.parent !== null && ids.has(g.parent)) {
      map.get(g.parent)!.children.push(map.get(g.id)!);
    } else {
      roots.push(map.get(g.id)!);
    }
  });
  return roots;
}

interface GroupTreeProps {
  nodes: TreeNode[];
  onGroupCreated: (group: Group) => void;
}

export default function GroupTree({ nodes, onGroupCreated }: GroupTreeProps) {
  return (
    <div className="flex flex-col py-1">
      {nodes.map((node) => (
        <GroupNode key={node.group.id} node={node} onGroupCreated={onGroupCreated} />
      ))}
    </div>
  );
}

function GroupNode({
  node,
  onGroupCreated,
  depth = 0,
}: {
  node: TreeNode;
  onGroupCreated: (group: Group) => void;
  depth?: number;
}) {
  const navigate = useNavigate();
  const [expanded, setExpanded] = useState(false);
  const [addingSubgroup, setAddingSubgroup] = useState(false);
  const hasChildren = node.children.length > 0;
  const { group } = node;

  return (
    <div className="relative">
      {/* Row */}
      <div
        className="flex items-center gap-2 rounded-lg px-2 py-2 hover:bg-gray-700/50 transition cursor-pointer group/row"
        onClick={() => navigate(`/groups/${group.id}`)}
      >
        {/* Chevron — reserves space for leaf nodes to keep alignment */}
        <button
          onClick={(e) => { e.stopPropagation(); if (hasChildren) setExpanded((v) => !v); }}
          className={`shrink-0 w-4 h-4 flex items-center justify-center rounded text-gray-500 hover:text-gray-300 transition-transform duration-150 ${expanded && hasChildren ? "rotate-90" : ""} ${!hasChildren ? "opacity-0 pointer-events-none" : ""}`}
        >
          <svg className="w-2.5 h-2.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
          </svg>
        </button>

        {/* Name */}
        <span className="text-white text-sm font-medium flex-1 min-w-0 truncate">{group.name}</span>

        {/* Stats */}
        <span className="text-gray-500 text-xs shrink-0 tabular-nums">
          {group.board_count} board{group.board_count !== 1 ? "s" : ""}
          {" · "}
          {group.member_count} member{group.member_count !== 1 ? "s" : ""}
        </span>

        {/* Add subgroup button — visible on hover */}
        <button
          onClick={(e) => { e.stopPropagation(); setAddingSubgroup(true); }}
          title={`Add subgroup to ${group.name}`}
          className="shrink-0 w-5 h-5 flex items-center justify-center rounded text-gray-600 hover:text-blue-400 hover:bg-gray-600 opacity-0 group-hover/row:opacity-100 transition"
        >
          <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
          </svg>
        </button>

        {/* Navigate arrow */}
        <svg className="w-3.5 h-3.5 text-gray-600 group-hover/row:text-gray-400 shrink-0 transition" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
        </svg>
      </div>

      {/* Children with ├── / └── connectors */}
      {hasChildren && expanded && (
        <div className="ml-[18px]">
          {node.children.map((child, i) => {
            const childIsLast = i === node.children.length - 1;
            return (
              <div key={child.group.id} className="relative pl-[16px]">
                {/* Vertical line — full height for non-last, half height for last */}
                <div
                  className="absolute left-0 w-px bg-gray-600"
                  style={{ top: 0, height: childIsLast ? "50%" : "100%" }}
                />
                {/* Horizontal connector at row midpoint */}
                <div className="absolute left-0 top-[50%] h-px w-[16px] bg-gray-600 -translate-y-px" />

                <GroupNode
                  node={child}
                  onGroupCreated={onGroupCreated}
                  depth={depth + 1}
                />
              </div>
            );
          })}
        </div>
      )}

      {addingSubgroup && (
        <CreateGroupModal
          parentGroup={group}
          onCreated={(newGroup) => {
            onGroupCreated(newGroup);
            setAddingSubgroup(false);
          }}
          onClose={() => setAddingSubgroup(false)}
        />
      )}
    </div>
  );
}
