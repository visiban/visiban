import { useState, useEffect, useCallback } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import type { User, Group, Board } from "../../types";
import { listGroups, listStarredGroups } from "../../api/groups";
import { listBoards, listStarredBoards, createBoard } from "../../api/boards";
import CreateBoardModal from "../Board/CreateBoardModal";
import CreateGroupModal from "../Group/CreateGroupModal";
import CollapsedFlyout from "../Common/CollapsedFlyout";

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

  // Flyout anchors — null means closed; capturing at click time avoids stale rects.
  const [favoritesAnchor, setFavoritesAnchor] = useState<{ top: number; left: number } | null>(null);
  const [personalAnchor, setPersonalAnchor] = useState<{ top: number; left: number } | null>(null);

  useEffect(() => {
    Promise.all([listGroups(), listBoards()])
      .then(([g, b]) => {
        setGroups(g);
        setBoards(b);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

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
      setPersonalAnchor(null);
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
  const topLevelGroups = groups.filter((g) => g.parent === null);

  const hasFavorites = starredBoards.length > 0 || starredGroups.length > 0;
  const isActiveFavoriteBoard = activeBoardId !== null && starredBoards.some((b) => b.id === activeBoardId);
  const isActivePersonalBoard = activeBoardId !== null && personalBoards.some((b) => b.id === activeBoardId);

  const openFavorites = (e: React.MouseEvent<HTMLButtonElement>) => {
    if (favoritesAnchor) { setFavoritesAnchor(null); return; }
    const rect = e.currentTarget.getBoundingClientRect();
    setPersonalAnchor(null);
    setFavoritesAnchor({ top: rect.top, left: rect.right });
  };

  const openPersonal = (e: React.MouseEvent<HTMLButtonElement>) => {
    if (personalAnchor) { setPersonalAnchor(null); return; }
    const rect = e.currentTarget.getBoundingClientRect();
    setFavoritesAnchor(null);
    setPersonalAnchor({ top: rect.top, left: rect.right });
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
      className={`${sidebarWidth} shrink-0 bg-slate-900 border-r border-slate-700 hidden lg:flex flex-col h-full overflow-hidden transition-all duration-200`}
      style={{ minWidth: collapsed ? "48px" : "220px", maxWidth: collapsed ? "48px" : "220px" }}
    >
      {/* Collapse toggle */}
      <div className="flex items-center justify-end px-2 py-2 border-b border-slate-700 shrink-0">
        <button
          onClick={() => setCollapsed((v) => !v)}
          className="text-slate-400 hover:text-white transition p-1 rounded hover:bg-slate-800"
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
          <div className="px-3 py-2 text-slate-500 text-xs">
            {collapsed ? "…" : "Loading…"}
          </div>
        )}

        {/* Dashboard — always visible */}
        {collapsed ? (
          <Link
            to="/"
            className={`flex items-center justify-center h-8 mx-1 my-0.5 rounded transition ${
              location.pathname === "/" ? "text-blue-400 bg-blue-600/20" : "text-slate-400 hover:text-white hover:bg-slate-800"
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
              location.pathname === "/" ? "text-blue-400 bg-blue-600/20 font-medium" : "text-slate-300 hover:text-white hover:bg-slate-800"
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
            <a
              href="/admin"
              className="flex items-center justify-center h-8 mx-1 my-0.5 rounded transition text-slate-400 hover:text-white hover:bg-slate-800"
              title="Site Admin"
            >
              <svg className="w-4 h-4" viewBox="0 0 20 20" fill="currentColor">
                <path fillRule="evenodd" d="M11.49 3.17c-.38-1.56-2.6-1.56-2.98 0a1.532 1.532 0 01-2.286.948c-1.372-.836-2.942.734-2.106 2.106.54.886.061 2.042-.947 2.287-1.561.379-1.561 2.6 0 2.978a1.532 1.532 0 01.947 2.287c-.836 1.372.734 2.942 2.106 2.106a1.532 1.532 0 012.287.947c.379 1.561 2.6 1.561 2.978 0a1.533 1.533 0 012.287-.947c1.372.836 2.942-.734 2.106-2.106a1.533 1.533 0 01.947-2.287c1.561-.379 1.561-2.6 0-2.978a1.532 1.532 0 01-.947-2.287c.836-1.372-.734-2.942-2.106-2.106a1.532 1.532 0 01-2.287-.947zM10 13a3 3 0 100-6 3 3 0 000 6z" clipRule="evenodd" />
              </svg>
            </a>
          ) : (
            <a
              href="/admin"
              className="flex items-center gap-2 px-3 py-1.5 text-sm transition text-slate-300 hover:text-white hover:bg-slate-800"
            >
              <svg className="w-4 h-4 shrink-0" viewBox="0 0 20 20" fill="currentColor">
                <path fillRule="evenodd" d="M11.49 3.17c-.38-1.56-2.6-1.56-2.98 0a1.532 1.532 0 01-2.286.948c-1.372-.836-2.942.734-2.106 2.106.54.886.061 2.042-.947 2.287-1.561.379-1.561 2.6 0 2.978a1.532 1.532 0 01.947 2.287c-.836 1.372.734 2.942 2.106 2.106a1.532 1.532 0 012.287.947c.379 1.561 2.6 1.561 2.978 0a1.533 1.533 0 012.287-.947c1.372.836 2.942-.734 2.106-2.106a1.533 1.533 0 01.947-2.287c1.561-.379 1.561-2.6 0-2.978a1.532 1.532 0 01-.947-2.287c.836-1.372-.734-2.942-2.106-2.106a1.532 1.532 0 01-2.287-.947zM10 13a3 3 0 100-6 3 3 0 000 6z" clipRule="evenodd" />
              </svg>
              <span>Site Admin</span>
            </a>
          )
        )}

        {!loading && (
          <>
            {/* ── Separator: utility nav → content nav ── */}
            {collapsed && (hasFavorites || topLevelGroups.length > 0 || personalBoards.length > 0) && (
              <div className="mx-2 my-1.5">
                <div className="h-px bg-slate-900" />
                <div className="h-px bg-slate-600/50" />
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
                    ? "text-yellow-300 bg-slate-700"
                    : isActiveFavoriteBoard
                    ? "text-yellow-400 bg-blue-600/20"
                    : "text-yellow-500 hover:text-yellow-300 hover:bg-slate-800"
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
                <div className="px-3 py-1.5 text-xs font-semibold text-slate-500 uppercase tracking-wider">
                  Favorite Boards
                </div>
                {starredBoards.map((board) => (
                  <BoardItem
                    key={board.id}
                    board={board}
                    active={board.id === activeBoardId}
                    indent={1}
                    onNavigate={collapse}
                  />
                ))}
              </div>
            )}

            {/* ── Expanded separator ── */}
            {!collapsed && (starredBoards.length > 0) && (starredGroups.length > 0 || topLevelGroups.length > 0 || personalBoards.length > 0) && (
              <div className="mx-4 my-1">
                <div className="h-px bg-slate-900" />
                <div className="h-px bg-slate-600/50" />
              </div>
            )}

            {/* ── Expanded: Favorite Groups ── */}
            {!collapsed && starredGroups.length > 0 && (
              <div>
                <div className="px-3 py-1.5 text-xs font-semibold text-slate-500 uppercase tracking-wider">
                  Favorite Groups
                </div>
                {starredGroups.map((group) => (
                  <Link
                    key={group.id}
                    to={`/groups/${group.id}`}
                    onClick={collapse}
                    className="flex items-center gap-1.5 pl-5 pr-3 py-1.5 text-sm transition truncate text-slate-400 hover:text-white hover:bg-slate-800"
                    title={group.name}
                  >
                    <svg className="w-3.5 h-3.5 shrink-0 text-slate-600" viewBox="0 0 20 20" fill="currentColor">
                      <path d="M2 6a2 2 0 012-2h5l2 2h5a2 2 0 012 2v6a2 2 0 01-2 2H4a2 2 0 01-2-2V6z" />
                    </svg>
                    <span className="truncate">{group.name}</span>
                  </Link>
                ))}
              </div>
            )}

            {/* ── Expanded separator: favorites → groups/personal ── */}
            {!collapsed && (starredBoards.length > 0 || starredGroups.length > 0) && (topLevelGroups.length > 0 || personalBoards.length > 0) && (
              <div className="mx-4 my-1">
                <div className="h-px bg-slate-900" />
                <div className="h-px bg-slate-600/50" />
              </div>
            )}

            {/* ── Top-level groups ── */}
            {topLevelGroups.map((group) => {
              const groupBoards = boards.filter((b) => b.group === group.id);
              const isExpanded = expandedGroups.has(group.id);

              return (
                <div key={group.id}>
                  {collapsed ? (
                    <Link
                      to={`/groups/${group.id}`}
                      className="flex items-center justify-center h-8 mx-1 my-0.5 rounded text-slate-400 hover:text-white hover:bg-slate-800 transition"
                      title={group.name}
                    >
                      <svg className="w-4 h-4" viewBox="0 0 20 20" fill="currentColor">
                        <path d="M2 6a2 2 0 012-2h5l2 2h5a2 2 0 012 2v6a2 2 0 01-2 2H4a2 2 0 01-2-2V6z" />
                      </svg>
                    </Link>
                  ) : (
                    <>
                      <div className="flex items-center">
                        <button
                          onClick={() => toggleGroup(group.id)}
                          className="shrink-0 flex items-center justify-center w-6 h-8 pl-3 text-slate-500 hover:text-white transition text-xs"
                          aria-label={isExpanded ? "Collapse group" : "Expand group"}
                        >
                          {isExpanded ? "▾" : "▸"}
                        </button>
                        <button
                          onClick={() => navigateTo(`/groups/${group.id}`)}
                          className="flex-1 flex items-center gap-1.5 pr-3 py-1.5 text-left text-slate-300 hover:text-white hover:bg-slate-800 transition text-sm min-w-0 rounded"
                        >
                          <span className="truncate font-medium">{group.name}</span>
                        </button>
                      </div>
                      {isExpanded && (
                        <div>
                          {groupBoards.map((board) => (
                            <BoardItem
                              key={board.id}
                              board={board}
                              active={board.id === activeBoardId}
                              indent={2}
                              onNavigate={collapse}
                            />
                          ))}
                          {groupBoards.length === 0 && (
                            <div className="pl-9 pr-3 py-1 text-xs text-slate-600">
                              No boards
                            </div>
                          )}
                        </div>
                      )}
                    </>
                  )}
                </div>
              );
            })}

            {/* ── Separator: groups → personal boards ── */}
            {personalBoards.length > 0 && (topLevelGroups.length > 0 || starredBoards.length > 0 || starredGroups.length > 0) && (
              <div className="mx-4 my-1">
                <div className="h-px bg-slate-900" />
                <div className="h-px bg-slate-600/50" />
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
                    ? "text-slate-200 bg-slate-700"
                    : isActivePersonalBoard
                    ? "text-blue-400 bg-blue-600/20"
                    : "text-slate-400 hover:text-white hover:bg-slate-800"
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
                <div className="px-3 py-1.5 text-xs font-semibold text-slate-500 uppercase tracking-wider">
                  Personal
                </div>
                {personalBoards.map((board) => (
                  <BoardItem
                    key={board.id}
                    board={board}
                    active={board.id === activeBoardId}
                    indent={1}
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
        <div className="shrink-0 border-t border-slate-700 px-3 py-2 flex flex-col gap-1">
          <button
            onClick={() => setShowCreateBoard(true)}
            className="flex items-center gap-1.5 text-xs text-slate-400 hover:text-white transition text-left"
          >
            <span className="text-base leading-none">+</span>
            <span>New board</span>
          </button>
          <button
            onClick={() => setShowCreateGroup(true)}
            className="flex items-center gap-1.5 text-xs text-slate-400 hover:text-white transition text-left"
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
    </aside>
  );
}

function BoardItem({
  board,
  active,
  indent,
  onNavigate,
}: {
  board: Board;
  active: boolean;
  indent: 1 | 2;
  onNavigate: () => void;
}) {
  const paddingLeft = indent === 2 ? "pl-9" : "pl-5";
  return (
    <Link
      to={`/boards/${board.id}`}
      onClick={onNavigate}
      className={`flex items-center gap-1.5 ${paddingLeft} pr-3 py-1.5 text-sm transition truncate ${
        active
          ? "bg-blue-600/20 text-blue-400 font-medium"
          : "text-slate-400 hover:text-white hover:bg-slate-800"
      }`}
      title={board.name}
    >
      <span className="text-slate-600 text-xs shrink-0">📋</span>
      <span className="truncate">{board.name}</span>
    </Link>
  );
}
