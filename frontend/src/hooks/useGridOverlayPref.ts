import { useCallback, useState } from "react";
import { resolveGridOverlayId } from "../gridOverlays/registry";

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
 *   2. the board's default preset's overlay (#1146, `Board.default_preset`)
 *   3. `none`
 *
 * #1146 shipped step 2 as a preset id rather than a `Board.grid_overlay` column, so
 * this hook returns the local choice as `null` when the key is absent and the caller
 * resolves `localChoice ?? boardDefaultPreset.overlay ?? NONE_OVERLAY_ID`
 * (`effectiveDisplay` in `boardPresets/registry.ts`) — never the other way round, or
 * an admin changing the board default would stomp a user's personal choice. A stored
 * `none` is a choice ("I turned the overlay off"), distinct from no key at all.
 */
function storageKey(boardId: number): string {
  return `board:${boardId}:grid-overlay`;
}

function load(boardId: number): string | null {
  try {
    const raw = localStorage.getItem(storageKey(boardId));
    // No key = no local choice. A stored id this build does not know is still a
    // choice, and resolveGridOverlayId turns it into "none" — a board that renders
    // un-overlaid beats a board that throws.
    return raw === null ? null : resolveGridOverlayId(raw);
  } catch {
    return null;
  }
}

function save(boardId: number, overlayId: string | null): void {
  try {
    if (overlayId === null) localStorage.removeItem(storageKey(boardId));
    else localStorage.setItem(storageKey(boardId), overlayId);
  } catch {
    // localStorage unavailable (private browsing, quota exceeded) — fail silently
  }
}

/**
 * Returns `[localChoice, setOverlayId, clearOverlayId]`. `localChoice` is `null` when
 * this browser has made no choice for the board; `setOverlayId(null)` stores "none"
 * (turning the overlay off is a choice), `clearOverlayId()` removes the key so the
 * board's default applies again (#1146).
 */
export function useGridOverlayPref(
  boardId: number,
): [string | null, (overlayId: string | null) => void, () => void] {
  const [overlayId, setState] = useState<string | null>(() => load(boardId));

  const setOverlayId = useCallback(
    (next: string | null) => {
      const resolved = resolveGridOverlayId(next);
      setState(resolved);
      save(boardId, resolved);
    },
    [boardId],
  );

  const clearOverlayId = useCallback(() => {
    setState(null);
    save(boardId, null);
  }, [boardId]);

  return [overlayId, setOverlayId, clearOverlayId];
}
