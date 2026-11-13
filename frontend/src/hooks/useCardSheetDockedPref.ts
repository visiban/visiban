import { useCallback, useState } from "react";

// User-scoped preference (#1915): persists across board navigations, reloads
// and sessions, under the user:prefs:* namespace (not board-scoped). Same
// try/catch pattern as useCardLayoutPref; no User model field. Absent = false.
export const CARD_SHEET_DOCKED_KEY = "user:prefs:card-sheet-docked";

function load(): boolean {
  try {
    return localStorage.getItem(CARD_SHEET_DOCKED_KEY) === "true";
  } catch {
    return false;
  }
}

function save(value: boolean): void {
  try {
    localStorage.setItem(CARD_SHEET_DOCKED_KEY, String(value));
  } catch {
    // localStorage unavailable (private browsing, quota exceeded): fail silently
  }
}

/**
 * Whether the card detail sheet is pinned to the right edge instead of
 * anchored to the card's column. The initial value is read once per mount, so
 * a card swap (which remounts the sheet) re-reads what the user chose.
 */
export function useCardSheetDockedPref(): [boolean, (value: boolean) => void] {
  const [docked, setDockedState] = useState<boolean>(() => load());
  const setDocked = useCallback((value: boolean) => {
    setDockedState(value);
    save(value);
  }, []);
  return [docked, setDocked];
}
