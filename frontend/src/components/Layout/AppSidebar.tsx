import { useState, useEffect, useCallback } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import type { User, Group, Board } from "../../types";
import { listGroups, listStarredGroups } from "../../api/groups";
import { listBoards, listStarredBoards } from "../../api/boards";

interface Props {
  user: User;
  starVersion?: number;
}

export default function AppSidebar({ user: _user, starVersion = 0 }: Props) {
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
  // Only top-level groups (no parent)
  const topLevelGroups = groups.filter((g) => g.parent === null);

  const sidebarWidth = collapsed ? "w-12" : "w-56";

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

        {/* Home — always visible, above the loading spinner */}
        {collapsed ? (
          <Link
            to="/"
            className={`flex items-center justify-center h-8 mx-1 my-0.5 rounded transition ${
              location.pathname === "/" ? "text-blue-400 bg-blue-600/20" : "text-slate-400 hover:text-white hover:bg-slate-800"
            }`}
            title="Home"
          >
            <svg className="w-4 h-4" viewBox="0 0 20 20" fill="currentColor">
              <path d="M10.707 2.293a1 1 0 00-1.414 0l-7 7A1 1 0 003 11h1v6a1 1 0 001 1h4v-4h2v4h4a1 1 0 001-1v-6h1a1 1 0 00.707-1.707l-7-7z" />
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
              <path d="M10.707 2.293a1 1 0 00-1.414 0l-7 7A1 1 0 003 11h1v6a1 1 0 001 1h4v-4h2v4h4a1 1 0 001-1v-6h1a1 1 0 00.707-1.707l-7-7z" />
            </svg>
            <span>Home</span>
          </Link>
        )}

        {!loading && (
          <>
            {/* ── Favorite Boards ── */}
            {starredBoards.length > 0 && (
              <>
                {collapsed ? (
                  <>
                    {starredBoards.map((board) => (
                      <Link
                        key={board.id}
                        to={`/boards/${board.id}`}
                        onClick={collapse}
                        className={`flex items-center justify-center h-8 mx-1 my-0.5 rounded transition ${
                          board.id === activeBoardId
                            ? "text-yellow-400 bg-blue-600/20"
                            : "text-yellow-500 hover:text-yellow-300 hover:bg-slate-800"
                        }`}
                        title={board.name}
                      >
                        <span className="text-sm leading-none">★</span>
                      </Link>
                    ))}
                  </>
                ) : (
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
              </>
            )}

            {/* ── Separator ── */}
            {(starredBoards.length > 0) && (starredGroups.length > 0 || topLevelGroups.length > 0 || personalBoards.length > 0) && (
              <div className="mx-4 my-1">
                <div className="h-px bg-slate-900" />
                <div className="h-px bg-slate-600/50" />
              </div>
            )}

            {/* ── Favorite Groups ── */}
            {starredGroups.length > 0 && (
              <>
                {collapsed ? (
                  <>
                    {starredGroups.map((group) => (
                      <Link
                        key={group.id}
                        to={`/groups/${group.id}`}
                        className="flex items-center justify-center h-8 mx-1 my-0.5 rounded text-yellow-500 hover:text-yellow-300 hover:bg-slate-800 transition"
                        title={group.name}
                      >
                        <span className="text-sm leading-none">★</span>
                      </Link>
                    ))}
                  </>
                ) : (
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
              </>
            )}

            {/* ── Separator ── */}
            {(starredBoards.length > 0 || starredGroups.length > 0) && (topLevelGroups.length > 0 || personalBoards.length > 0) && (
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

            {/* ── Personal boards (no group) ── */}
            {personalBoards.length > 0 && (
              <div>
                {collapsed ? (
                  <div
                    className="flex items-center justify-center h-8 mx-1 my-0.5 rounded text-slate-500"
                    title="Personal boards"
                  >
                    <svg className="w-4 h-4" viewBox="0 0 20 20" fill="currentColor">
                      <path fillRule="evenodd" d="M10 9a3 3 0 100-6 3 3 0 000 6zm-7 9a7 7 0 1114 0H3z" clipRule="evenodd" />
                    </svg>
                  </div>
                ) : (
                  <>
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
                  </>
                )}
              </div>
            )}
          </>
        )}
      </nav>

      {/* Footer: new board / new group links */}
      {!collapsed && (
        <div className="shrink-0 border-t border-slate-700 px-3 py-2 flex flex-col gap-1">
          <Link
            to="/"
            className="flex items-center gap-1.5 text-xs text-slate-400 hover:text-white transition"
          >
            <span className="text-base leading-none">+</span>
            <span>New board</span>
          </Link>
          <Link
            to="/"
            className="flex items-center gap-1.5 text-xs text-slate-400 hover:text-white transition"
          >
            <span className="text-base leading-none">+</span>
            <span>New group</span>
          </Link>
        </div>
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
