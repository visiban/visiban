import { useState } from "react";

// User-scoped preference: persists across board navigations, page refreshes, and sessions.
// Stored under the user:prefs:* namespace — not board-scoped.
// Default is "expanded" (full-width single-card-per-row layout).
const STORAGE_KEY = "user:prefs:card-layout";
// The lens previously had its own compact pref; the board's card-layout pref now
// drives the lens too. One-time read-through migration so a deliberate lens-compact
// choice carries over (the legacy key is otherwise silently ignored).
const LEGACY_LENS_KEY = "user:prefs:lens-density";

export type CardLayout = "expanded" | "compact";

function load(): CardLayout {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === "compact") return "compact";
    if (raw === null && localStorage.getItem(LEGACY_LENS_KEY) === "compact") return "compact";
    return "expanded";
  } catch {
    return "expanded";
  }
}

function save(value: CardLayout): void {
  try {
    localStorage.setItem(STORAGE_KEY, value);
  } catch {
    // localStorage unavailable (e.g. private browsing, quota exceeded) — fail silently
  }
}

export function useCardLayoutPref(): [CardLayout, (value: CardLayout) => void] {
  const [layout, setLayoutState] = useState<CardLayout>(() => load());

  const setLayout = (value: CardLayout) => {
    setLayoutState(value);
    save(value);
  };

  return [layout, setLayout];
}
