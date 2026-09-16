import { useVisibilityResync } from "./useVisibilityResync";

/**
 * Re-fetches the full board state when the browser tab regains focus.
 *
 * WebSocket events that arrive while the tab is suspended (laptop sleep,
 * mobile background, etc.) are silently lost. This hook bridges the gap by
 * calling the existing `reload()` function — which hits GET /full/ — whenever
 * `document.visibilityState` transitions back to "visible".
 *
 * The resync is throttled so it fires at most once per `RESYNC_THROTTLE_MS`.
 * That throttle now lives in `useVisibilityResync`, shared with the
 * current-user resync in `useAuth` (#783); the behavior here is unchanged.
 *
 * Source of change: Gemini Pro external codebase review (2026-04-01).
 */
export function useBoardResync(reload: () => void): void {
  useVisibilityResync(reload);
}
