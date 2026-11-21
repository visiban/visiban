import { createContext, useContext } from "react";

const EMPTY: ReadonlySet<number> = new Set();

/**
 * Ids of parent cards whose first `children_rollup` read is in flight (#2210).
 * BoardView provides it; a card outside a provider (tests, overlays) is never loading.
 */
export const RollupLoadingContext = createContext<ReadonlySet<number>>(EMPTY);

export function useRollupLoading(cardId: number): boolean {
  return useContext(RollupLoadingContext).has(cardId);
}
