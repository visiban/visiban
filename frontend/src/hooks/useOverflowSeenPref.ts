import { useState } from "react";

// User-scoped preference: tracks whether the user has seen (clicked) the
// board toolbar overflow kebab (`⋮`), so the first-encounter discovery dot
// can be dismissed. Stored under the user:prefs:* namespace — not board-scoped.
// Independent from export-seen and shortcuts-seen; the kebab is a new surface
// and warrants its own first-encounter affordance, especially at md/sm where
// controls users recognised previously get folded into the overflow menu.
const STORAGE_KEY = "user:prefs:overflow-seen";

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
 * `seen` is false until the user intentionally clicks the overflow kebab for
 * the first time, at which point markSeen() sets it to true and persists it.
 * The `.` keyboard shortcut does NOT mark seen — the dot is a discovery
 * affordance for the button itself; a user who used the shortcut already
 * knows the menu exists.
 */
export function useOverflowSeenPref(): [boolean, () => void] {
  const [seen, setSeenState] = useState<boolean>(() => load());

  const markSeen = () => {
    setSeenState(true);
    save(true);
  };

  return [seen, markSeen];
}
