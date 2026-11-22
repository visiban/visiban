import { createContext, useContext } from "react";

const EMPTY: ReadonlySet<number> = new Set();

/**
 * Ids of parent cards whose first `children_rollup` read is in flight (#2210).
 * BoardView provides it; a card outside a provider (tests, overlays) is never loading.
 */
// Cost, accepted: the Set's identity changes on every loading flip, so every CardItem
// re-renders (memo does not stop a context change). It is one flip pair per first-rollup
// read of a parent, not per frame; revisit with a per-card subscription if that grows.
export const RollupLoadingContext = createContext<ReadonlySet<number>>(EMPTY);

export function useRollupLoading(cardId: number): boolean {
  return useContext(RollupLoadingContext).has(cardId);
}
