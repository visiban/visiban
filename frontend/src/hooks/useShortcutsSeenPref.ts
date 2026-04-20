import { useState } from "react";

const STORAGE_KEY = "user:prefs:shortcuts-seen";

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
    // localStorage unavailable — fail silently
  }
}

export function useShortcutsSeenPref(): [boolean, () => void] {
  const [seen, setSeenState] = useState<boolean>(() => load());

  const markSeen = () => {
    setSeenState(true);
    save(true);
  };

  return [seen, markSeen];
}
