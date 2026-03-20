import { useEffect, useState } from "react";
import { searchCards } from "../api/cards";

interface UseCardSearchResult {
  searchMatchIds: Set<number> | null;
  isSearching: boolean;
}

/**
 * Debounced server-side card search hook.
 *
 * Returns null searchMatchIds when query is empty (no filter applied) or on
 * error (silent fallback — show all cards). A non-null Set means the server
 * returned results and only those card IDs should pass the search filter.
 *
 * Stale in-flight requests are aborted via AbortController so the hook never
 * applies results from a superseded query.
 */
export function useCardSearch(
  boardId: number,
  query: string,
  debounceMs = 300,
): UseCardSearchResult {
  const [searchMatchIds, setSearchMatchIds] = useState<Set<number> | null>(null);
  const [isSearching, setIsSearching] = useState(false);

  useEffect(() => {
    // Empty query — clear any previous results immediately, no request needed.
    if (!query.trim()) {
      setSearchMatchIds(null);
      setIsSearching(false);
      return;
    }

    const controller = new AbortController();

    const timer = setTimeout(() => {
      setIsSearching(true);

      searchCards(boardId, query, controller.signal)
        .then((cards) => {
          setSearchMatchIds(new Set(cards.map((c) => c.id)));
          setIsSearching(false);
        })
        .catch((err) => {
          // Ignore abort errors from stale requests — they are expected and not errors.
          if (err?.name === "CanceledError" || err?.name === "AbortError" || controller.signal.aborted) {
            return;
          }
          // Silent fallback: treat any other error as no filter (show all cards).
          setSearchMatchIds(null);
          setIsSearching(false);
        });
    }, debounceMs);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [boardId, query, debounceMs]);

  return { searchMatchIds, isSearching };
}
