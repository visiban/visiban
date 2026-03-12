import { useState, useEffect } from "react";
import { Link, useLocation } from "react-router-dom";
import type { User, Group, Board } from "../../types";
import { listGroups } from "../../api/groups";
import { listBoards } from "../../api/boards";

interface Props {
  user: User;
}

export default function AppSidebar({ user: _user }: Props) {
  const location = useLocation();

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
    localStorage.setItem("sidebar-collapsed", String(collapsed));
  }, [collapsed]);

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

  const groupInitial = (name: string) => name.charAt(0).toUpperCase();

  const sidebarWidth = collapsed ? "w-12" : "w-56";

  return (
    <aside
      className={`${sidebarWidth} shrink-0 bg-slate-900 border-r border-slate-700 flex flex-col h-full overflow-hidden transition-all duration-200`}
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

        {!loading && (
          <>
            {/* Top-level groups */}
            {topLevelGroups.map((group) => {
              const groupBoards = boards.filter((b) => b.group === group.id);
              const isExpanded = expandedGroups.has(group.id);

              return (
                <div key={group.id}>
                  {collapsed ? (
                    <div
                      className="flex items-center justify-center h-8 mx-1 my-0.5 rounded cursor-pointer text-slate-400 hover:text-white hover:bg-slate-800 transition"
                      title={group.name}
                      onClick={() => toggleGroup(group.id)}
                    >
                      <span className="text-xs font-bold">
                        {groupInitial(group.name)}
                      </span>
                    </div>
                  ) : (
                    <>
                      <button
                        onClick={() => toggleGroup(group.id)}
                        className="w-full flex items-center gap-1.5 px-3 py-1.5 text-left text-slate-300 hover:text-white hover:bg-slate-800 transition text-sm"
                      >
                        <span className="text-slate-500 text-xs w-3 shrink-0">
                          {isExpanded ? "▾" : "▸"}
                        </span>
                        <span className="truncate font-medium">{group.name}</span>
                      </button>
                      {isExpanded && (
                        <div>
                          {groupBoards.map((board) => (
                            <BoardItem
                              key={board.id}
                              board={board}
                              active={board.id === activeBoardId}
                              indent={2}
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

            {/* Personal boards (no group) */}
            {personalBoards.length > 0 && (
              <div>
                {collapsed ? (
                  <div
                    className="flex items-center justify-center h-8 mx-1 my-0.5 rounded text-slate-500"
                    title="Personal boards"
                  >
                    <span className="text-xs font-bold">P</span>
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
                      />
                    ))}
                  </>
                )}
              </div>
            )}
          </>
        )}
      </nav>

      {/* Footer: new board link */}
      {!collapsed && (
        <div className="shrink-0 border-t border-slate-700 px-3 py-2">
          <Link
            to="/"
            className="flex items-center gap-1.5 text-xs text-slate-400 hover:text-white transition"
          >
            <span className="text-base leading-none">+</span>
            <span>New board</span>
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
}: {
  board: Board;
  active: boolean;
  indent: 1 | 2;
}) {
  const paddingLeft = indent === 2 ? "pl-9" : "pl-5";
  return (
    <Link
      to={`/boards/${board.id}`}
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
