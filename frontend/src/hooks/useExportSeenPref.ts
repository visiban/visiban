import { useState } from "react";

// User-scoped preference: tracks whether the user has seen (clicked) the export
// button in the board header, so the first-encounter discovery dot can be dismissed.
// Stored under the user:prefs:* namespace — not board-scoped.
const STORAGE_KEY = "user:prefs:export-seen";

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

/**
 * Returns [seen, markSeen].
 * `seen` is false until the user clicks the export button for the first time,
 * at which point markSeen() sets it to true and persists it.
 */
export function useExportSeenPref(): [boolean, () => void] {
  const [seen, setSeenState] = useState<boolean>(() => load());

  const markSeen = () => {
    setSeenState(true);
    save(true);
  };

  return [seen, markSeen];
}
