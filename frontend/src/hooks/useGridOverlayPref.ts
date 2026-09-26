import { useCallback, useState } from "react";
import { NONE_OVERLAY_ID, resolveGridOverlayId } from "../gridOverlays/registry";

/**
 * Board-scoped choice of grid overlay (#1147).
 *
 * Board-scoped rather than user-scoped because "which overlay" is a property of
 * how a *particular* board is being read, and because #1146 (board presets) will
 * later select the same value by id — keeping the stored shape a bare overlay id
 * means the preset can write this key without a migration.
 *
 * Kept out of `useViewPrefs` deliberately: that hook's stored object is pruned
 * against live column/swimlane ids on every load, and an overlay id has nothing
 * to prune against.
 *
 * Precedence ladder, so #1146 does not invent a second resolution order — the same
 * shape `useCardDensityOverride` already uses for `Board.card_density`:
 *
 *   1. this per-user, per-board local choice, when set
 *   2. the board's own default (a future `Board.grid_overlay` column owned by #1146)
 *   3. `none`
 *
 * Step 2 does not exist yet, so today the ladder is (1) then (3). When #1146 adds the
 * server column, this hook keeps returning the local override and the caller resolves
 * `localChoice ?? board.grid_overlay ?? NONE_OVERLAY_ID` — never the other way round,
 * or an admin changing the board default would stomp a user's personal choice.
 */
function storageKey(boardId: number): string {
  return `board:${boardId}:grid-overlay`;
}

function load(boardId: number): string {
  try {
    // resolveGridOverlayId turns an unknown or stale id into "none" — a board
    // that renders un-overlaid beats a board that throws.
    return resolveGridOverlayId(localStorage.getItem(storageKey(boardId)));
  } catch {
    return NONE_OVERLAY_ID;
  }
}

function save(boardId: number, overlayId: string): void {
  try {
    localStorage.setItem(storageKey(boardId), overlayId);
  } catch {
    // localStorage unavailable (private browsing, quota exceeded) — fail silently
  }
}

export function useGridOverlayPref(boardId: number): [string, (overlayId: string | null) => void] {
  const [overlayId, setState] = useState<string>(() => load(boardId));

  const setOverlayId = useCallback(
    (next: string | null) => {
      const resolved = resolveGridOverlayId(next);
      setState(resolved);
      save(boardId, resolved);
    },
    [boardId],
  );

  return [overlayId, setOverlayId];
}
