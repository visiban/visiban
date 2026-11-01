import { useEffect, useState } from "react";

// Per-user preference: records the last 5 boards visited, persisted across sessions.
// The entry holds board and parent-group names, so it is keyed by user id
// ("user:prefs:recent-boards:<id>") and is also wiped on logout / session expiry
// (clearRecentBoardsPrefs). On a shared browser a second account must never see
// the first account's names, even after a crash or skipped logout (#1955).
const KEY_PREFIX = "user:prefs:recent-boards";
const MAX_RECENTS = 5;

export interface RecentBoardEntry {
  id: number;
  name: string;
  /** Direct parent group name (first entry only is displayed). */
  groupAncestors?: string[];
}

type UserId = number | null | undefined;

function keyFor(userId: number): string {
  return `${KEY_PREFIX}:${userId}`;
}

/**
 * Remove every recent-boards entry, for all users and the legacy unscoped key.
 * Called on logout and on auth:sessionExpired. Other user:prefs:* keys (theme,
 * sidebar collapsed, density, "seen" flags) hold no board or group names and
 * are deliberately left alone.
 */
export function clearRecentBoardsPrefs(): void {
  try {
    const doomed: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k !== null && (k === KEY_PREFIX || k.startsWith(`${KEY_PREFIX}:`))) doomed.push(k);
    }
    doomed.forEach((k) => localStorage.removeItem(k));
  } catch {
    // localStorage unavailable — nothing was persisted to clear.
  }
}

// The pre-#1955 unscoped key is shared by every account, so it can never be
// attributed to the current user. Drop it instead of migrating it.
function dropLegacyKey(): void {
  try {
    localStorage.removeItem(KEY_PREFIX);
  } catch {
    // localStorage unavailable — fail silently.
  }
}

function load(userId: UserId): RecentBoardEntry[] {
  if (userId == null) return [];
  dropLegacyKey();
  try {
    const raw = localStorage.getItem(keyFor(userId));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // Validate shape: each entry must have id (number) and name (string).
    return parsed.filter(
      (e): e is RecentBoardEntry =>
        typeof e === "object" &&
        e !== null &&
        typeof e.id === "number" &&
        typeof e.name === "string"
    );
  } catch {
    return [];
  }
}

function save(userId: UserId, entries: RecentBoardEntry[]): void {
  if (userId == null) return;
  try {
    localStorage.setItem(keyFor(userId), JSON.stringify(entries));
  } catch {
    // localStorage unavailable (e.g. private browsing, quota exceeded) — fail silently.
  }
}

export function useRecentBoardsPref(userId: UserId): {
  recentBoards: RecentBoardEntry[];
  recordVisit: (entry: RecentBoardEntry) => void;
  pruneByIds: (validIds: Set<number>) => void;
} {
  const [recentBoards, setRecentBoards] = useState<RecentBoardEntry[]>(() => load(userId));

  // Account switch within a mounted tree: reload so the previous user's list
  // is never shown to the next one.
  useEffect(() => {
    setRecentBoards(load(userId));
  }, [userId]);

  const recordVisit = (entry: RecentBoardEntry) => {
    setRecentBoards((prev) => {
      // Prepend the new entry, deduplicate by id, cap at MAX_RECENTS.
      const deduped = [entry, ...prev.filter((e) => e.id !== entry.id)].slice(0, MAX_RECENTS);
      save(userId, deduped);
      return deduped;
    });
  };

  // Drop entries whose board id is not in the accessible set — handles boards
  // that were deleted, had membership revoked, or came from a different instance
  // (stale localStorage surviving a DB reset).
  // save() is called before setRecentBoards so the write is synchronous and not
  // inside a React functional updater (which React 18 can call during render).
  const pruneByIds = (validIds: Set<number>) => {
    const current = load(userId);
    const filtered = current.filter((e) => validIds.has(e.id));
    if (filtered.length === current.length) return;
    save(userId, filtered);
    setRecentBoards(filtered);
  };

  return { recentBoards, recordVisit, pruneByIds };
}
