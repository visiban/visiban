import type { Group, Board } from "../types";

export interface SidebarTreeNode {
  group: Group;
  /** Boards that belong directly to this group (not to subgroups). */
  boards: Board[];
  children: SidebarTreeNode[];
}

/**
 * Build a recursive tree from a flat list of groups and boards.
 *
 * Groups with a parent that is not in the `groups` array are treated as
 * roots (handles the case where a user has access to a subgroup but not
 * its parent).  Boards whose group ID has no matching group are omitted.
 */
export function buildSidebarTree(groups: Group[], boards: Board[]): SidebarTreeNode[] {
  const ids = new Set(groups.map((g) => g.id));
  const map = new Map<number, SidebarTreeNode>();
  groups.forEach((g) => map.set(g.id, { group: g, boards: [], children: [] }));

  boards.forEach((b) => {
    if (b.group !== null && map.has(b.group)) {
      map.get(b.group)!.boards.push(b);
    }
  });

  const roots: SidebarTreeNode[] = [];
  groups.forEach((g) => {
    if (g.parent !== null && ids.has(g.parent)) {
      map.get(g.parent)!.children.push(map.get(g.id)!);
    } else {
      roots.push(map.get(g.id)!);
    }
  });
  return roots;
}
