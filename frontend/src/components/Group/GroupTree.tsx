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
    <div className="flex flex-col gap-1">
      {nodes.map((node) => (
        <GroupNode key={node.group.id} node={node} depth={0} />
      ))}
    </div>
  );
}

function GroupNode({ node, depth }: { node: TreeNode; depth: number }) {
  const navigate = useNavigate();
  const [expanded, setExpanded] = useState(true);
  const hasChildren = node.children.length > 0;
  const { group } = node;

  return (
    <div>
      <div
        className="flex items-center gap-2 rounded-xl px-3 py-2.5 hover:bg-gray-800 transition group cursor-pointer"
        style={{ paddingLeft: `${0.75 + depth * 1.5}rem` }}
        onClick={() => navigate(`/groups/${group.id}`)}
      >
        {/* Chevron — always reserve space so names align */}
        <button
          onClick={(e) => { e.stopPropagation(); setExpanded((v) => !v); }}
          className={`shrink-0 w-5 h-5 flex items-center justify-center rounded text-gray-500 hover:text-gray-300 transition-transform ${expanded ? "rotate-90" : ""} ${!hasChildren ? "invisible" : ""}`}
        >
          <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
          </svg>
        </button>

        {/* Icon */}
        <span className="shrink-0 text-gray-500 group-hover:text-gray-400 transition">
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M17 20h5v-2a4 4 0 00-5.356-3.712M9 20H4v-2a4 4 0 015.356-3.712M15 7a4 4 0 11-8 0 4 4 0 018 0zm6 3a3 3 0 11-6 0 3 3 0 016 0z" />
          </svg>
        </span>

        {/* Name + stats */}
        <span className="flex-1 min-w-0">
          <span className="text-white text-sm font-medium">{group.name}</span>
          <span className="ml-3 text-gray-500 text-xs">
            {group.board_count} board{group.board_count !== 1 ? "s" : ""}
            {" · "}
            {group.member_count} member{group.member_count !== 1 ? "s" : ""}
          </span>
        </span>

        {/* Arrow */}
        <svg className="w-4 h-4 text-gray-600 group-hover:text-gray-400 shrink-0 transition" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
        </svg>
      </div>

      {/* Children — indented with a left guide line */}
      {hasChildren && expanded && (
        <div
          className="ml-6 border-l border-gray-700/60"
          style={{ marginLeft: `${1.25 + depth * 1.5}rem` }}
        >
          {node.children.map((child) => (
            <GroupNode key={child.group.id} node={child} depth={depth + 1} />
          ))}
        </div>
      )}
    </div>
  );
}
