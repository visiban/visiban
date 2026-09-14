import { useState } from "react";

// User-scoped preference: persists across board navigations, page refreshes, and sessions.
// Stored under the user:prefs:* namespace — not board-scoped.
// Default is "expanded" (full-width single-card-per-row layout).
const STORAGE_KEY = "user:prefs:card-layout";
// The lens previously had its own compact pref ("user:prefs:lens-density"); the
// board's card-layout pref now drives the lens too. That legacy value is
// deliberately NOT migrated: this hook has a single instance (BoardView) feeding
// BOTH surfaces, so honoring it would silently flip the NATIVE board into compact
// multi-per-row for a user who only ever set it on the lens — changing a surface
// they never configured. The lens shipped behind GIT_LENS_ENABLED (off by
// default), so the affected population is small and one click of the layout
// toggle restores their choice. Any stale key is simply ignored.

export type CardLayout = "expanded" | "compact";

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
