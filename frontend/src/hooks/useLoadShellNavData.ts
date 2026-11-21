import { useEffect, useState } from "react";
import { useLocation } from "react-router-dom";
import type { Board, Group, User } from "../types";
import { listGroups } from "../api/groups";
import { listBoards, listStarredBoards } from "../api/boards";
import { useRecentBoardsPref } from "./useRecentBoardsPref";
import type { ShellNavData } from "../contexts/ShellNavContext";

function boardIdFromPath(pathname: string): number | null {
  const match = pathname.match(/^\/boards\/(\d+)/);
  return match ? Number(match[1]) : null;
}

/**
 * Loads the shell's navigation data (#2473) and records board visits for the
 * Recent list. This moved here from the removed AppSidebar (#2473):
 * the drawer is mounted only while open, but visits must be recorded on every
 * board navigation, so the shell owns the recording.
 */
export function useLoadShellNavData(user: User, starVersion: number): ShellNavData {
  const { pathname } = useLocation();
  const [groups, setGroups] = useState<Group[]>([]);
  const [boards, setBoards] = useState<Board[]>([]);
  const [starredBoards, setStarredBoards] = useState<Board[]>([]);
  const [loading, setLoading] = useState(true);
  const { recentBoards, recordVisit, pruneByIds } = useRecentBoardsPref(user.id);

  useEffect(() => {
    Promise.all([listGroups(), listBoards()])
      .then(([g, b]) => {
        setGroups(g);
        setBoards(b);
        // Drop Recent entries whose board is no longer accessible (deleted,
        // membership revoked, or stale storage from a reset instance).
        pruneByIds(new Set(b.map((brd) => brd.id)));
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  // pruneByIds is recreated each render but only reads storage; run once on mount.
  // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-only load, see comment above
  }, []);

  useEffect(() => {
    listStarredBoards().then(setStarredBoards).catch(() => {});
  }, [starVersion]);

  // Record a visit whenever the route is a board this user can see. Re-runs
  // once the board list lands, so a deep link is recorded too.
  const activeBoardId = boardIdFromPath(pathname);
  useEffect(() => {
    if (activeBoardId === null) return;
    const board = boards.find((b) => b.id === activeBoardId);
    if (!board) return;
    const parentGroupName = board.group !== null
      ? groups.find((g) => g.id === board.group)?.name ?? board.group_name ?? undefined
      : undefined;
    recordVisit({ id: board.id, name: board.name, groupAncestors: parentGroupName ? [parentGroupName] : [] });
  // recordVisit is recreated each render; firing on it would loop.
  // eslint-disable-next-line react-hooks/exhaustive-deps -- recordVisit intentionally excluded, see comment above
  }, [activeBoardId, boards, groups]);

  return { loading, groups, boards, starredBoards, recentBoards };
}
