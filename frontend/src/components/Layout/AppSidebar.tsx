import { useState, useEffect, useRef, useCallback } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import type { User, Group, Board } from "../../types";
import { listGroups, listStarredGroups } from "../../api/groups";
import { listBoards, listStarredBoards, createBoard } from "../../api/boards";
import CreateBoardModal from "../Board/CreateBoardModal";
import CreateGroupModal from "../Group/CreateGroupModal";
import CollapsedFlyout from "../Common/CollapsedFlyout";
import { buildSidebarTree } from "../../utils/groupTree";
import type { SidebarTreeNode } from "../../utils/groupTree";
import { useRecentBoardsPref } from "../../hooks/useRecentBoardsPref";

interface Props {
  user: User;
  starVersion?: number;
}

export default function AppSidebar({ user, starVersion = 0 }: Props) {
  const location = useLocation();
  const navigate = useNavigate();

  const [collapsed, setCollapsed] = useState(() =>
    localStorage.getItem("sidebar-collapsed") === "true"
  );
  const [expandedGroups, setExpandedGroups] = useState<Set<number>>(() => {
    try {
      const saved = JSON.parse(
        localStorage.getItem("sidebar-groups-expanded") || "[]"
      );
      return new Set<number>(saved);
    } catch {
      return new Set<number>();
    }
  });

  const [groups, setGroups] = useState<Group[]>([]);
  const [boards, setBoards] = useState<Board[]>([]);
  const [starredBoards, setStarredBoards] = useState<Board[]>([]);
  const [starredGroups, setStarredGroups] = useState<Group[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreateBoard, setShowCreateBoard] = useState(false);
  const [showCreateGroup, setShowCreateGroup] = useState(false);

  const { recentBoards, recordVisit, pruneByIds } = useRecentBoardsPref();

  // Track whether the ancestor auto-expand has fired for the initial mount.
  // We only want this to run once so subsequent navigations don't force the
  // sidebar open — the user should be able to collapse groups freely after that.
  const ancestorExpandDoneRef = useRef(false);

  // Flyout anchors — null means closed; capturing at click time avoids stale rects.
  const [favoritesAnchor, setFavoritesAnchor] = useState<{ top: number; left: number } | null>(null);
  const [groupsAnchor, setGroupsAnchor] = useState<{ top: number; left: number } | null>(null);
  const [personalAnchor, setPersonalAnchor] = useState<{ top: number; left: number } | null>(null);
  const [recentAnchor, setRecentAnchor] = useState<{ top: number; left: number } | null>(null);

  useEffect(() => {
    Promise.all([listGroups(), listBoards()])
      .then(([g, b]) => {
        setGroups(g);
        setBoards(b);
        // Drop any Recent entries whose board id is no longer accessible —
        // deletions, revoked memberships, or a stale localStorage referencing
        // a prior instance (DB reset). Only runs once per mount after load.
        pruneByIds(new Set(b.map((brd) => brd.id)));
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  // pruneByIds is stable from the hook; listGroups/listBoards are module imports.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Auto-expand ancestors of the active board once — fires after the initial
  // data load so deep links open with the correct group path already visible.
  useEffect(() => {
    if (loading || ancestorExpandDoneRef.current) return;
    const match = location.pathname.match(/\/boards\/(\d+)/);
    if (!match) return;
    const boardId = Number(match[1]);
    const activeBoard = boards.find((b) => b.id === boardId);
    if (!activeBoard || activeBoard.group === null) return;

    // Walk up the group parent chain to collect all ancestor IDs.
    const groupById = new Map(groups.map((g) => [g.id, g]));
    const ancestorIds: number[] = [];
    let current = groupById.get(activeBoard.group);
    while (current) {
      ancestorIds.push(current.id);
      current = current.parent !== null ? groupById.get(current.parent) : undefined;
    }

    if (ancestorIds.length > 0) {
      setExpandedGroups((prev) => {
        const next = new Set([...prev, ...ancestorIds]);
        localStorage.setItem("sidebar-groups-expanded", JSON.stringify([...next]));
        return next;
      });
    }
    ancestorExpandDoneRef.current = true;
  // location.pathname is intentionally included so this fires once after the
  // first load that sees the correct pathname.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, boards, groups]);

  // Record board visits for the Recent section whenever the user navigates to a board.
  useEffect(() => {
    const match = location.pathname.match(/\/boards\/(\d+)/);
    if (!match) return;
    const boardId = Number(match[1]);
    const board = boards.find((b) => b.id === boardId);
    if (!board) return;
    const parentGroupName = board.group !== null
      ? groups.find((g) => g.id === board.group)?.name
      : undefined;
    recordVisit({
      id: board.id,
      name: board.name,
      groupAncestors: parentGroupName ? [parentGroupName] : [],
    });
  // boards/groups are not listed to avoid re-recording on every state update;
  // we only want to fire when the pathname changes.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.pathname]);

  useEffect(() => {
    listStarredBoards().then(setStarredBoards).catch(() => {});
    listStarredGroups().then(setStarredGroups).catch(() => {});
  }, [starVersion]);

  useEffect(() => {
    localStorage.setItem("sidebar-collapsed", String(collapsed));
  }, [collapsed]);

  // Close flyouts when the sidebar expands
  useEffect(() => {
    if (!collapsed) {
      setFavoritesAnchor(null);
      setGroupsAnchor(null);
      setPersonalAnchor(null);
      setRecentAnchor(null);
    }
  }, [collapsed]);

  const collapse = useCallback(() => setCollapsed(true), []);

  const navigateTo = useCallback((path: string) => {
    setCollapsed(true);
    navigate(path);
  }, [navigate]);

  const toggleGroup = (id: number) => {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      localStorage.setItem(
        "sidebar-groups-expanded",
        JSON.stringify([...next])
      );
      return next;
    });
  };

  const activeBoardId = (() => {
    const match = location.pathname.match(/\/boards\/(\d+)/);
    return match ? Number(match[1]) : null;
  })();

  const personalBoards = boards.filter((b) => b.group === null);
  const sidebarTree = buildSidebarTree(groups, boards);

  const hasFavorites = starredBoards.length > 0 || starredGroups.length > 0;
  const isActiveFavoriteBoard = activeBoardId !== null && starredBoards.some((b) => b.id === activeBoardId);
  const isActiveGroupBoard = activeBoardId !== null && boards.some((b) => b.id === activeBoardId && b.group !== null);
  const isActivePersonalBoard = activeBoardId !== null && personalBoards.some((b) => b.id === activeBoardId);
  const isActiveRecentBoard = activeBoardId !== null && recentBoards.some((b) => b.id === activeBoardId);

  const openFavorites = (e: React.MouseEvent<HTMLButtonElement>) => {
    if (favoritesAnchor) { setFavoritesAnchor(null); return; }
    const rect = e.currentTarget.getBoundingClientRect();
    setGroupsAnchor(null);
    setPersonalAnchor(null);
    setRecentAnchor(null);
    setFavoritesAnchor({ top: rect.top, left: rect.right });
  };

  const openGroups = (e: React.MouseEvent<HTMLButtonElement>) => {
    if (groupsAnchor) { setGroupsAnchor(null); return; }
    const rect = e.currentTarget.getBoundingClientRect();
    setFavoritesAnchor(null);
    setPersonalAnchor(null);
    setRecentAnchor(null);
    setGroupsAnchor({ top: rect.top, left: rect.right });
  };

  const openPersonal = (e: React.MouseEvent<HTMLButtonElement>) => {
    if (personalAnchor) { setPersonalAnchor(null); return; }
    const rect = e.currentTarget.getBoundingClientRect();
    setFavoritesAnchor(null);
    setGroupsAnchor(null);
    setRecentAnchor(null);
    setPersonalAnchor({ top: rect.top, left: rect.right });
  };

  const openRecent = (e: React.MouseEvent<HTMLButtonElement>) => {
    if (recentAnchor) { setRecentAnchor(null); return; }
    const rect = e.currentTarget.getBoundingClientRect();
    setFavoritesAnchor(null);
    setGroupsAnchor(null);
    setPersonalAnchor(null);
    setRecentAnchor({ top: rect.top, left: rect.right });
  };

  const sidebarWidth = collapsed ? "w-12" : "w-56";

  // Build favorites flyout sections
  const favoritesSections = [];
  if (starredBoards.length > 0) {
    favoritesSections.push({
      title: "Boards",
      items: starredBoards.map((b) => ({
        id: b.id,
        name: b.name,
        href: `/boards/${b.id}`,
        active: b.id === activeBoardId,
      })),
    });
  }
  if (starredGroups.length > 0) {
    favoritesSections.push({
      title: "Groups",
      items: starredGroups.map((g) => ({
        id: g.id,
        name: g.name,
        href: `/groups/${g.id}`,
        active: location.pathname === `/groups/${g.id}`,
      })),
    });
  }

  return (
    <aside
      className={`${sidebarWidth} shrink-0 bg-sunken border-r border-line hidden lg:flex flex-col h-full overflow-hidden transition-all duration-200`}
      style={{ minWidth: collapsed ? "48px" : "220px", maxWidth: collapsed ? "48px" : "220px" }}
    >
      {/* Collapse toggle */}
      <div className="flex items-center justify-end px-2 py-2 border-b border-line shrink-0">
        <button
          onClick={() => setCollapsed((v) => !v)}
          className="text-fg-tertiary hover:text-white transition p-1 rounded hover:bg-surface"
          title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
        >
          {collapsed ? (
            <svg className="w-4 h-4" viewBox="0 0 20 20" fill="currentColor">
              <path
                fillRule="evenodd"
                d="M7.293 14.707a1 1 0 010-1.414L10.586 10 7.293 6.707a1 1 0 011.414-1.414l4 4a1 1 0 010 1.414l-4 4a1 1 0 01-1.414 0z"
                clipRule="evenodd"
              />
            </svg>
          ) : (
            <svg className="w-4 h-4" viewBox="0 0 20 20" fill="currentColor">
              <path
                fillRule="evenodd"
                d="M12.707 5.293a1 1 0 010 1.414L9.414 10l3.293 3.293a1 1 0 01-1.414 1.414l-4-4a1 1 0 010-1.414l4-4a1 1 0 011.414 0z"
                clipRule="evenodd"
              />
            </svg>
          )}
        </button>
      </div>

      {/* Tree */}
      <nav className="flex-1 overflow-y-auto overflow-x-hidden py-2">
        {loading && (
          <div className="px-3 py-2 text-fg-muted text-xs">
            {collapsed ? "…" : "Loading…"}
          </div>
        )}

        {/* Dashboard — always visible */}
        {collapsed ? (
          <Link
            to="/"
            className={`flex items-center justify-center h-8 mx-1 my-0.5 rounded transition ${
              location.pathname === "/" ? "text-info bg-info/20" : "text-fg-tertiary hover:text-white hover:bg-surface"
            }`}
            title="Dashboard"
          >
            <svg className="w-4 h-4" viewBox="0 0 20 20" fill="currentColor">
              <path d="M5 3a2 2 0 00-2 2v2a2 2 0 002 2h2a2 2 0 002-2V5a2 2 0 00-2-2H5zM5 11a2 2 0 00-2 2v2a2 2 0 002 2h2a2 2 0 002-2v-2a2 2 0 00-2-2H5zM11 5a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2V5zM11 13a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2v-2z" />
            </svg>
          </Link>
        ) : (
          <Link
            to="/"
            onClick={collapse}
            className={`flex items-center gap-2 px-3 py-1.5 text-sm transition ${
              location.pathname === "/" ? "text-info bg-info/20 font-medium" : "text-fg-secondary hover:text-white hover:bg-surface"
            }`}
          >
            <svg className="w-4 h-4 shrink-0" viewBox="0 0 20 20" fill="currentColor">
              <path d="M5 3a2 2 0 00-2 2v2a2 2 0 002 2h2a2 2 0 002-2V5a2 2 0 00-2-2H5zM5 11a2 2 0 00-2 2v2a2 2 0 002 2h2a2 2 0 002-2v-2a2 2 0 00-2-2H5zM11 5a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2V5zM11 13a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2v-2z" />
            </svg>
            <span>Dashboard</span>
          </Link>
        )}

        {/* Site Admin — only rendered for site admins */}
        {user.is_site_admin && (
          collapsed ? (
            <Link
              to="/admin"
              className="flex items-center justify-center h-8 mx-1 my-0.5 rounded transition text-fg-tertiary hover:text-white hover:bg-surface"
              title="Site Admin"
            >
              <svg className="w-4 h-4" viewBox="0 0 20 20" fill="currentColor">
                <path fillRule="evenodd" d="M11.49 3.17c-.38-1.56-2.6-1.56-2.98 0a1.532 1.532 0 01-2.286.948c-1.372-.836-2.942.734-2.106 2.106.54.886.061 2.042-.947 2.287-1.561.379-1.561 2.6 0 2.978a1.532 1.532 0 01.947 2.287c-.836 1.372.734 2.942 2.106 2.106a1.532 1.532 0 012.287.947c.379 1.561 2.6 1.561 2.978 0a1.533 1.533 0 012.287-.947c1.372.836 2.942-.734 2.106-2.106a1.533 1.533 0 01.947-2.287c1.561-.379 1.561-2.6 0-2.978a1.532 1.532 0 01-.947-2.287c.836-1.372-.734-2.942-2.106-2.106a1.532 1.532 0 01-2.287-.947zM10 13a3 3 0 100-6 3 3 0 000 6z" clipRule="evenodd" />
              </svg>
            </Link>
          ) : (
            <Link
              to="/admin"
              className="flex items-center gap-2 px-3 py-1.5 text-sm transition text-fg-secondary hover:text-white hover:bg-surface"
            >
              <svg className="w-4 h-4 shrink-0" viewBox="0 0 20 20" fill="currentColor">
                <path fillRule="evenodd" d="M11.49 3.17c-.38-1.56-2.6-1.56-2.98 0a1.532 1.532 0 01-2.286.948c-1.372-.836-2.942.734-2.106 2.106.54.886.061 2.042-.947 2.287-1.561.379-1.561 2.6 0 2.978a1.532 1.532 0 01.947 2.287c-.836 1.372.734 2.942 2.106 2.106a1.532 1.532 0 012.287.947c.379 1.561 2.6 1.561 2.978 0a1.533 1.533 0 012.287-.947c1.372.836 2.942-.734 2.106-2.106a1.533 1.533 0 01.947-2.287c1.561-.379 1.561-2.6 0-2.978a1.532 1.532 0 01-.947-2.287c.836-1.372-.734-2.942-2.106-2.106a1.532 1.532 0 01-2.287-.947zM10 13a3 3 0 100-6 3 3 0 000 6z" clipRule="evenodd" />
              </svg>
              <span>Site Admin</span>
            </Link>
          )
        )}

        {!loading && (
          <>
            {/* ── Separator: utility nav → content nav ── */}
            {collapsed && (hasFavorites || recentBoards.length > 0 || sidebarTree.length > 0 || personalBoards.length > 0) && (
              <div className="mx-2 my-1.5">
                <div className="h-px bg-sunken" />
                <div className="h-px bg-surface-active/50" />
              </div>
            )}

            {/* ── Collapsed: Favorites flyout trigger ── */}
            {collapsed && hasFavorites && (
              <button
                onClick={openFavorites}
                onMouseDown={(e) => { if (favoritesAnchor) e.stopPropagation(); }}
                title="Favorites"
                aria-haspopup="true"
                aria-expanded={favoritesAnchor !== null}
                className={`flex items-center justify-center h-8 w-8 mx-1 my-0.5 rounded transition focus:outline-none focus:ring-2 focus:ring-blue-500 ${
                  favoritesAnchor
                    ? "text-yellow-300 bg-surface-hover"
                    : isActiveFavoriteBoard
                    ? "text-yellow-400 bg-info/20"
                    : "text-yellow-500 hover:text-yellow-300 hover:bg-surface"
                }`}
              >
                <svg className="w-4 h-4" viewBox="0 0 20 20" fill="currentColor">
                  <path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z" />
                </svg>
              </button>
            )}

            {/* ── Expanded: Favorite Boards ── */}
            {!collapsed && starredBoards.length > 0 && (
              <div>
                <div className="px-3 py-1.5 text-xs font-semibold text-fg-muted uppercase tracking-wider">
                  Favorite Boards
                </div>
                {starredBoards.map((board) => (
                  <BoardItem
                    key={board.id}
                    board={board}
                    active={board.id === activeBoardId}
                    depth={1}
                    onNavigate={collapse}
                  />
                ))}
              </div>
            )}

            {/* ── Expanded separator ── */}
            {!collapsed && (starredBoards.length > 0) && (starredGroups.length > 0 || sidebarTree.length > 0 || personalBoards.length > 0 || recentBoards.length > 0) && (
              <div className="mx-4 my-1">
                <div className="h-px bg-sunken" />
                <div className="h-px bg-surface-active/50" />
              </div>
            )}

            {/* ── Expanded: Favorite Groups ── */}
            {!collapsed && starredGroups.length > 0 && (
              <div>
                <div className="px-3 py-1.5 text-xs font-semibold text-fg-muted uppercase tracking-wider">
                  Favorite Groups
                </div>
                {starredGroups.map((group) => (
                  <Link
                    key={group.id}
                    to={`/groups/${group.id}`}
                    onClick={collapse}
                    className="flex items-center gap-1.5 pl-5 pr-3 py-1.5 text-sm transition truncate text-fg-tertiary hover:text-white hover:bg-surface"
                    title={group.name}
                  >
                    <svg className="w-3.5 h-3.5 shrink-0 text-fg-faint" viewBox="0 0 20 20" fill="currentColor">
                      <path d="M2 6a2 2 0 012-2h5l2 2h5a2 2 0 012 2v6a2 2 0 01-2 2H4a2 2 0 01-2-2V6z" />
                    </svg>
                    <span className="truncate">{group.name}</span>
                  </Link>
                ))}
              </div>
            )}

            {/* ── Expanded separator: favorites → recent ── */}
            {!collapsed && (starredBoards.length > 0 || starredGroups.length > 0) && recentBoards.length > 0 && (
              <div className="mx-4 my-1">
                <div className="h-px bg-sunken" />
                <div className="h-px bg-surface-active/50" />
              </div>
            )}

            {/* ── Expanded: Recent boards ── */}
            {!collapsed && recentBoards.length > 0 && (
              <div>
                <div className="px-3 py-1.5 text-xs font-semibold text-fg-muted uppercase tracking-wider">
                  Recent
                </div>
                {recentBoards.map((entry) => (
                  <RecentBoardItem
                    key={entry.id}
                    entry={entry}
                    active={entry.id === activeBoardId}
                    onNavigate={collapse}
                  />
                ))}
              </div>
            )}

            {/* ── Expanded separator: (favorites or recent) → groups/personal ── */}
            {!collapsed && (starredBoards.length > 0 || starredGroups.length > 0 || recentBoards.length > 0) && (sidebarTree.length > 0 || personalBoards.length > 0) && (
              <div className="mx-4 my-1">
                <div className="h-px bg-sunken" />
                <div className="h-px bg-surface-active/50" />
              </div>
            )}

            {/* ── Collapsed: Recent boards flyout trigger ── */}
            {collapsed && recentBoards.length > 0 && (
              <button
                onClick={openRecent}
                onMouseDown={(e) => { if (recentAnchor) e.stopPropagation(); }}
                title="Recent boards"
                aria-haspopup="true"
                aria-expanded={recentAnchor !== null}
                className={`flex items-center justify-center h-8 w-8 mx-1 my-0.5 rounded transition focus:outline-none focus:ring-2 focus:ring-blue-500 ${
                  recentAnchor
                    ? "text-fg bg-surface-hover"
                    : isActiveRecentBoard
                    ? "text-info bg-info/20"
                    : "text-fg-tertiary hover:text-white hover:bg-surface"
                }`}
              >
                {/* Clock icon */}
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
              </button>
            )}

            {/* ── Collapsed: Groups flyout trigger — single icon regardless of how many groups ── */}
            {collapsed && sidebarTree.length > 0 && (
              <button
                onClick={openGroups}
                onMouseDown={(e) => { if (groupsAnchor) e.stopPropagation(); }}
                title="Groups"
                aria-haspopup="true"
                aria-expanded={groupsAnchor !== null}
                className={`flex items-center justify-center h-8 w-8 mx-1 my-0.5 rounded transition focus:outline-none focus:ring-2 focus:ring-blue-500 ${
                  groupsAnchor
                    ? "text-fg bg-surface-hover"
                    : isActiveGroupBoard
                    ? "text-info bg-info/20"
                    : "text-fg-tertiary hover:text-white hover:bg-surface"
                }`}
              >
                <svg className="w-4 h-4" viewBox="0 0 20 20" fill="currentColor">
                  <path d="M2 6a2 2 0 012-2h5l2 2h5a2 2 0 012 2v6a2 2 0 01-2 2H4a2 2 0 01-2-2V6z" />
                </svg>
              </button>
            )}

            {/* ── Groups: expanded explorer tree ── */}
            {!collapsed && sidebarTree.map((node) => (
              <SidebarGroupNode
                key={node.group.id}
                node={node}
                depth={0}
                activeBoardId={activeBoardId}
                expandedGroups={expandedGroups}
                toggleGroup={toggleGroup}
                onNavigate={collapse}
                navigateTo={navigateTo}
              />
            ))}

            {/* ── Separator: groups → personal boards ── */}
            {personalBoards.length > 0 && (sidebarTree.length > 0 || starredBoards.length > 0 || starredGroups.length > 0 || recentBoards.length > 0) && (
              <div className="mx-4 my-1">
                <div className="h-px bg-sunken" />
                <div className="h-px bg-surface-active/50" />
              </div>
            )}

            {/* ── Collapsed: Personal boards flyout trigger ── */}
            {collapsed && personalBoards.length > 0 && (
              <button
                onClick={openPersonal}
                onMouseDown={(e) => { if (personalAnchor) e.stopPropagation(); }}
                title="Personal boards"
                aria-haspopup="true"
                aria-expanded={personalAnchor !== null}
                className={`flex items-center justify-center h-8 w-8 mx-1 my-0.5 rounded transition focus:outline-none focus:ring-2 focus:ring-blue-500 ${
                  personalAnchor
                    ? "text-fg bg-surface-hover"
                    : isActivePersonalBoard
                    ? "text-info bg-info/20"
                    : "text-fg-tertiary hover:text-white hover:bg-surface"
                }`}
              >
                {/* Clipboard / board icon */}
                <svg className="w-4 h-4" viewBox="0 0 20 20" fill="currentColor">
                  <path d="M9 2a1 1 0 000 2h2a1 1 0 100-2H9z" />
                  <path fillRule="evenodd" d="M4 5a2 2 0 012-2 3 3 0 003 3h2a3 3 0 003-3 2 2 0 012 2v11a2 2 0 01-2 2H6a2 2 0 01-2-2V5zm3 4a1 1 0 000 2h.01a1 1 0 100-2H7zm3 0a1 1 0 000 2h3a1 1 0 100-2h-3zm-3 4a1 1 0 100 2h.01a1 1 0 100-2H7zm3 0a1 1 0 100 2h3a1 1 0 100-2h-3z" clipRule="evenodd" />
                </svg>
              </button>
            )}

            {/* ── Expanded: Personal boards ── */}
            {!collapsed && personalBoards.length > 0 && (
              <div>
                <div className="px-3 py-1.5 text-xs font-semibold text-fg-muted uppercase tracking-wider">
                  Personal
                </div>
                {personalBoards.map((board) => (
                  <BoardItem
                    key={board.id}
                    board={board}
                    active={board.id === activeBoardId}
                    depth={1}
                    onNavigate={collapse}
                  />
                ))}
              </div>
            )}
          </>
        )}
      </nav>

      {/* Footer: new board / new group */}
      {!collapsed && (
        <div className="shrink-0 border-t border-line px-3 py-2 flex flex-col gap-1">
          <button
            onClick={() => setShowCreateBoard(true)}
            className="flex items-center gap-1.5 text-xs text-fg-tertiary hover:text-white transition text-left"
          >
            <span className="text-base leading-none">+</span>
            <span>New board</span>
          </button>
          <button
            onClick={() => setShowCreateGroup(true)}
            className="flex items-center gap-1.5 text-xs text-fg-tertiary hover:text-white transition text-left"
          >
            <span className="text-base leading-none">+</span>
            <span>New group</span>
          </button>
        </div>
      )}

      {showCreateBoard && (
        <CreateBoardModal
          onConfirm={async (name, template, swimlaneName) => {
            const board = await createBoard({ name, template, swimlane_name: swimlaneName });
            setShowCreateBoard(false);
            navigate(`/boards/${board.id}`);
          }}
          onCancel={() => setShowCreateBoard(false)}
          user={user}
        />
      )}

      {showCreateGroup && (
        <CreateGroupModal
          onCreated={(g) => setGroups((prev) => [g, ...prev])}
          onClose={() => setShowCreateGroup(false)}
        />
      )}

      {/* Favorites flyout portal */}
      {collapsed && favoritesAnchor && hasFavorites && (
        <CollapsedFlyout
          title="Favorites"
          sections={favoritesSections}
          anchor={favoritesAnchor}
          onClose={() => setFavoritesAnchor(null)}
          onNavigate={collapse}
        />
      )}

      {/* Groups flyout portal */}
      {collapsed && groupsAnchor && sidebarTree.length > 0 && (
        <CollapsedFlyout
          title="Groups"
          sections={[{
            title: "Groups",
            items: (() => {
              // Flatten sidebarTree depth-first so subgroups appear indented
              // under their parent. Visual depth is capped at 3 to preserve
              // readable text width in the 224px panel.
              const flatGroups: { node: SidebarTreeNode; depth: number }[] = [];
              function flattenGroups(nodes: SidebarTreeNode[], depth: number) {
                for (const n of nodes) {
                  flatGroups.push({ node: n, depth: Math.min(depth, 3) });
                  flattenGroups(n.children, depth + 1);
                }
              }
              flattenGroups(sidebarTree, 0);
              return flatGroups.map(({ node, depth }) => ({
                id: node.group.id,
                name: node.group.name,
                href: `/groups/${node.group.id}`,
                active: location.pathname === `/groups/${node.group.id}`,
                depth,
                icon: "group" as const,
              }));
            })(),
          }]}
          anchor={groupsAnchor}
          onClose={() => setGroupsAnchor(null)}
          onNavigate={collapse}
        />
      )}

      {/* Personal boards flyout portal */}
      {collapsed && personalAnchor && personalBoards.length > 0 && (
        <CollapsedFlyout
          title="Personal boards"
          sections={[{
            title: "Personal",
            items: personalBoards.map((b) => ({
              id: b.id,
              name: b.name,
              href: `/boards/${b.id}`,
              active: b.id === activeBoardId,
            })),
          }]}
          anchor={personalAnchor}
          onClose={() => setPersonalAnchor(null)}
          onNavigate={collapse}
        />
      )}

      {/* Recent boards flyout portal */}
      {collapsed && recentAnchor && recentBoards.length > 0 && (
        <CollapsedFlyout
          title="Recent boards"
          sections={[{
            title: "Recent",
            items: recentBoards.map((b) => ({
              id: b.id,
              name: b.name,
              href: `/boards/${b.id}`,
              active: b.id === activeBoardId,
            })),
          }]}
          anchor={recentAnchor}
          onClose={() => setRecentAnchor(null)}
          onNavigate={collapse}
        />
      )}
    </aside>
  );
}

function RecentBoardItem({
  entry,
  active,
  onNavigate,
}: {
  entry: { id: number; name: string; groupAncestors?: string[] };
  active: boolean;
  onNavigate: () => void;
}) {
  const parentName = entry.groupAncestors?.[0];
  return (
    <Link
      to={`/boards/${entry.id}`}
      onClick={onNavigate}
      className={`flex flex-col pr-3 py-1.5 text-sm transition truncate ${
        active ? "bg-info/20" : "hover:bg-surface"
      }`}
      title={entry.name}
    >
      <span
        className={`flex items-center gap-1.5 pl-5 truncate ${
          active ? "text-info font-medium" : "text-fg-tertiary hover:text-white"
        }`}
      >
        {/* Clock icon */}
        <svg className="w-3.5 h-3.5 shrink-0 text-fg-muted" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
        <span className="truncate">{entry.name}</span>
      </span>
      {parentName && (
        <span className="pl-[22px] pr-3 pb-0.5 text-xs text-fg-muted truncate leading-tight">
          {parentName}
        </span>
      )}
    </Link>
  );
}

function BoardItem({
  board,
  active,
  depth,
  onNavigate,
}: {
  board: Board;
  active: boolean;
  /** Tree depth — drives left padding: depth * 12 + 8 px */
  depth: number;
  onNavigate: () => void;
}) {
  return (
    <Link
      to={`/boards/${board.id}`}
      onClick={onNavigate}
      style={{ paddingLeft: depth * 12 + 8 }}
      className={`flex items-center gap-1.5 pr-3 py-1.5 text-sm transition truncate ${
        active
          ? "bg-info/20 text-info font-medium"
          : "text-fg-tertiary hover:text-white hover:bg-surface"
      }`}
      title={board.name}
    >
      <svg className="w-3.5 h-3.5 shrink-0 text-fg-muted" viewBox="0 0 20 20" fill="currentColor">
        <path d="M9 2a1 1 0 000 2h2a1 1 0 100-2H9z" />
        <path fillRule="evenodd" d="M4 5a2 2 0 012-2 3 3 0 003 3h2a3 3 0 003-3 2 2 0 012 2v11a2 2 0 01-2 2H6a2 2 0 01-2-2V5zm3 4a1 1 0 000 2h.01a1 1 0 100-2H7zm3 0a1 1 0 000 2h3a1 1 0 100-2h-3zm-3 4a1 1 0 100 2h.01a1 1 0 100-2H7zm3 0a1 1 0 100 2h3a1 1 0 100-2h-3z" clipRule="evenodd" />
      </svg>
      <span className="truncate">{board.name}</span>
    </Link>
  );
}

function SidebarGroupNode({
  node,
  depth,
  activeBoardId,
  expandedGroups,
  toggleGroup,
  onNavigate,
  navigateTo,
}: {
  node: SidebarTreeNode;
  depth: number;
  activeBoardId: number | null;
  expandedGroups: Set<number>;
  toggleGroup: (id: number) => void;
  onNavigate: () => void;
  navigateTo: (path: string) => void;
}) {
  const { group, boards: groupBoards, children } = node;
  const isExpanded = expandedGroups.has(group.id);
  const hasContent = groupBoards.length > 0 || children.length > 0;
  // Boards and subgroups indent one level deeper than the group row.
  const childDepth = depth + 1;

  return (
    <div>
      {/* Group row */}
      <div className="flex items-center" style={{ paddingLeft: depth * 12 + 2 }}>
        <button
          onClick={() => toggleGroup(group.id)}
          className={`shrink-0 flex items-center justify-center w-5 h-8 text-fg-muted hover:text-white transition text-xs ${
            !hasContent ? "opacity-0 pointer-events-none" : ""
          }`}
          aria-label={isExpanded ? "Collapse group" : "Expand group"}
        >
          <svg
            className={`w-2.5 h-2.5 transition-transform duration-150 ${isExpanded ? "rotate-90" : ""}`}
            fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
          </svg>
        </button>
        <button
          onClick={() => navigateTo(`/groups/${group.id}`)}
          className="flex-1 flex items-center gap-1.5 pr-3 py-1.5 text-left text-fg-secondary hover:text-white hover:bg-surface transition text-sm min-w-0 rounded"
        >
          <svg className="w-3.5 h-3.5 shrink-0 text-fg-muted" viewBox="0 0 20 20" fill="currentColor">
            <path d="M2 6a2 2 0 012-2h5l2 2h5a2 2 0 012 2v6a2 2 0 01-2 2H4a2 2 0 01-2-2V6z" />
          </svg>
          <span className="truncate font-medium">{group.name}</span>
        </button>
      </div>

      {/* Children — boards first, then subgroups */}
      {isExpanded && hasContent && (
        <div>
          {groupBoards.map((board) => (
            <BoardItem
              key={board.id}
              board={board}
              active={board.id === activeBoardId}
              depth={childDepth}
              onNavigate={onNavigate}
            />
          ))}
          {groupBoards.length === 0 && children.length === 0 && (
            <div className="py-1 text-xs text-fg-faint" style={{ paddingLeft: childDepth * 12 + 8 }}>
              No boards
            </div>
          )}
          {children.map((child) => (
            <SidebarGroupNode
              key={child.group.id}
              node={child}
              depth={childDepth}
              activeBoardId={activeBoardId}
              expandedGroups={expandedGroups}
              toggleGroup={toggleGroup}
              onNavigate={onNavigate}
              navigateTo={navigateTo}
            />
          ))}
        </div>
      )}
    </div>
  );
}
