import { useState } from "react";
import { useNavigate } from "react-router-dom";
import type { Group } from "../../types";

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
}

export default function GroupTree({ nodes }: GroupTreeProps) {
  return (
    <div className="flex flex-col">
      {nodes.map((node, i) => (
        <GroupNode key={node.group.id} node={node} depth={0} isLast={i === nodes.length - 1} />
      ))}
    </div>
  );
}

function GroupNode({ node, depth, isLast }: { node: TreeNode; depth: number; isLast: boolean }) {
  const navigate = useNavigate();
  const [expanded, setExpanded] = useState(true);
  const hasChildren = node.children.length > 0;
  const { group } = node;

  return (
    <div>
      {/* Row */}
      <div
        className="flex items-center gap-3 rounded-lg px-3 py-2.5 hover:bg-gray-700/50 transition cursor-pointer group"
        style={{ paddingLeft: `${0.75 + depth * 1.75}rem` }}
        onClick={() => navigate(`/groups/${group.id}`)}
      >
        {/* Chevron */}
        <button
          onClick={(e) => { e.stopPropagation(); if (hasChildren) setExpanded((v) => !v); }}
          className={`shrink-0 w-4 h-4 flex items-center justify-center text-gray-500 hover:text-gray-300 transition-transform duration-150 ${expanded && hasChildren ? "rotate-90" : ""} ${!hasChildren ? "opacity-0 pointer-events-none" : ""}`}
        >
          <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
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

        {/* Arrow */}
        <svg className="w-3.5 h-3.5 text-gray-600 group-hover:text-gray-400 shrink-0 transition" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
        </svg>
      </div>

      {/* Children with guide line */}
      {hasChildren && expanded && (
        <div className="relative" style={{ paddingLeft: `${1.5 + depth * 1.75}rem` }}>
          {/* Vertical guide line */}
          <div className={`absolute top-0 bottom-0 w-px bg-gray-700`} style={{ left: `${0.875 + depth * 1.75}rem` }} />
          {node.children.map((child, i) => (
            <GroupNode key={child.group.id} node={child} depth={depth + 1} isLast={i === node.children.length - 1} />
          ))}
        </div>
      )}
    </div>
  );
}
