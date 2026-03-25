import { useState } from "react";

// User-scoped preference: persists across card opens, page refreshes, and sessions.
// Stored under the user:prefs:* namespace — not board-scoped.
const STORAGE_KEY = "user:prefs:show-full-history";

function load(): boolean {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === null) return false;
    return JSON.parse(raw) === true;
  } catch {
    return false;
  }
}

function save(value: boolean): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
  } catch {
    // localStorage unavailable (e.g. private browsing, quota exceeded) — fail silently
  }
}

export function useShowFullHistoryPref(): [boolean, (value: boolean) => void] {
  const [showAll, setShowAllState] = useState<boolean>(() => load());

  const setShowAll = (value: boolean) => {
    setShowAllState(value);
    save(value);
  };

  return [showAll, setShowAll];
}
