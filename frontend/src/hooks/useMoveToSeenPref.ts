import { useState } from "react";

// User-scoped preference: persists across card opens, page refreshes, and sessions.
// Stored under the user:prefs:* namespace — not board-scoped.
// Dismissed on first intentional click of the Move button (not on hover —
// hover is passive and transient; click means the user has used the feature).
const STORAGE_KEY = "user:prefs:move-to-seen";

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

export function useMoveToSeenPref(): [boolean, (value: boolean) => void] {
  const [seen, setSeenState] = useState<boolean>(() => load());

  const setSeen = (value: boolean) => {
    setSeenState(value);
    save(value);
  };

  return [seen, setSeen];
}
