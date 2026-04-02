import { useState } from "react";

// User-scoped preference: records the last 5 boards visited, persisted across sessions.
// Stored under the user:prefs:* namespace — not board-scoped.
const STORAGE_KEY = "user:prefs:recent-boards";
const MAX_RECENTS = 5;

export interface RecentBoardEntry {
  id: number;
  name: string;
  /** Direct parent group name (first entry only is displayed). */
  groupAncestors?: string[];
}

function load(): RecentBoardEntry[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
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

function save(entries: RecentBoardEntry[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
  } catch {
    // localStorage unavailable (e.g. private browsing, quota exceeded) — fail silently.
  }
}

export function useRecentBoardsPref(): {
  recentBoards: RecentBoardEntry[];
  recordVisit: (entry: RecentBoardEntry) => void;
} {
  const [recentBoards, setRecentBoards] = useState<RecentBoardEntry[]>(() => load());

  const recordVisit = (entry: RecentBoardEntry) => {
    setRecentBoards((prev) => {
      // Prepend the new entry, deduplicate by id, cap at MAX_RECENTS.
      const deduped = [entry, ...prev.filter((e) => e.id !== entry.id)].slice(0, MAX_RECENTS);
      save(deduped);
      return deduped;
    });
  };

  return { recentBoards, recordVisit };
}
