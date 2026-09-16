import { useState } from "react";
import type { CardDensity } from "../types";

// Per-user, per-board preference (#974): lets a user override the board
// admin's `card_density` default for their own view only. Board-scoped
// (like useViewPrefs) rather than a flat user:prefs:* key, because "follow
// board default" only has a coherent meaning relative to *this* board's
// admin setting — a global override would either bleed into every board a
// user visits, or need a second per-board mechanism anyway.
//
// Absence of the key (not a stored "null") is the canonical "follow board
// default" state, consistent with how useViewPrefs treats missing/stale
// values. Resetting to the board default removes the key rather than
// writing a literal string.
const VALID_DENSITIES: CardDensity[] = ["comfortable", "standard", "dense"];

function storageKey(boardId: number): string {
  return `board:${boardId}:card-density-override`;
}

function load(boardId: number): CardDensity | null {
  try {
    const raw = localStorage.getItem(storageKey(boardId));
    if (raw !== null && (VALID_DENSITIES as string[]).includes(raw)) return raw as CardDensity;
    // Missing, or a corrupted/stale value from a removed tier — both decay
    // to "follow board default" rather than throwing or rendering garbage.
    return null;
  } catch {
    return null;
  }
}

function save(boardId: number, value: CardDensity | null): void {
  try {
    if (value === null) {
      localStorage.removeItem(storageKey(boardId));
    } else {
      localStorage.setItem(storageKey(boardId), value);
    }
  } catch {
    // localStorage unavailable (e.g. private browsing, quota exceeded) — fail silently
  }
}

export function useCardDensityOverride(boardId: number): [CardDensity | null, (value: CardDensity | null) => void] {
  const [override, setOverrideState] = useState<CardDensity | null>(() => load(boardId));

  const setOverride = (value: CardDensity | null) => {
    setOverrideState(value);
    save(boardId, value);
  };

  return [override, setOverride];
}
