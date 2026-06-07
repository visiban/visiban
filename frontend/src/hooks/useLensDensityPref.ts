import { useState } from "react";

// User-scoped preference: persists across board navigations, refreshes, and sessions.
// Stored under the user:prefs:* namespace — a reading habit, not a property of a
// shared lens link (collapse/focus live in the URL instead). Default "comfortable".
const STORAGE_KEY = "user:prefs:lens-density";

export type LensDensity = "comfortable" | "compact";

function load(): LensDensity {
  try {
    return localStorage.getItem(STORAGE_KEY) === "compact" ? "compact" : "comfortable";
  } catch {
    return "comfortable";
  }
}

function save(value: LensDensity): void {
  try {
    localStorage.setItem(STORAGE_KEY, value);
  } catch {
    // localStorage unavailable (private browsing, quota) — fail silently
  }
}

export function useLensDensityPref(): [LensDensity, (value: LensDensity) => void] {
  const [density, setDensityState] = useState<LensDensity>(() => load());

  const setDensity = (value: LensDensity) => {
    setDensityState(value);
    save(value);
  };

  return [density, setDensity];
}
