import { useState } from "react";

// User-scoped preference: persists across board navigations, page refreshes, and sessions.
// Stored under the user:prefs:* namespace — not board-scoped.
// Default is "expanded" (full-width single-card-per-row layout).
const STORAGE_KEY = "user:prefs:card-layout";

type CardLayout = "expanded" | "compact";

function load(): CardLayout {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === "compact") return "compact";
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
