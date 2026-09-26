import type { GridOverlay } from "../types";

/**
 * The default overlay: contributes nothing, so the board renders exactly as it
 * did before #1147. It exists as a real registry entry rather than a `null`
 * special case so the picker, a board preset (#1146), and the persisted
 * preference can all speak the same id-keyed vocabulary — "no overlay" is a
 * choice with a name, not a missing value.
 */
export const noneOverlay: GridOverlay = {
  id: "none",
  label: "None",
  description: "No overlay — the board grid renders unchanged.",
  compute: () => new Map(),
};
