import { useEffect, useState } from "react";
import { searchCards } from "../api/cards";
import type { Card } from "../types";

interface UseCardSearchResultsResult {
  results: Card[];
  isSearching: boolean;
  failed: boolean;
}

/**
 * Debounced server-side card search that returns the cards themselves (#449).
 *
 * This deliberately duplicates the debounce/AbortController machinery in
 * `useCardSearch` rather than wrapping it. That hook returns a `Set<number>`
 * of ids — enough to filter a board it already has in memory — and swallows
 * every error into "no filter, show everything". A picker needs the `Card`
 * objects (to render a title and a column) and has to *surface* a failure,
 * because silently showing an empty result list would read as "no such card"
 * and send the user looking for a card that is right there. Two different
 * return shapes and two opposite error policies; merging them would mean one
 * hook with a mode flag. Do not merge them.
 *
 * Below `minChars` no request is issued at all — a one-character query matches
 * most of a board and costs a round trip to say nothing.
 */
export function useCardSearchResults(
  boardId: number,
  query: string,
  debounceMs = 300,
  minChars = 2,
): UseCardSearchResultsResult {
  const [results, setResults] = useState<Card[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (query.trim().length < minChars) {
      setResults([]);
      setIsSearching(false);
      setFailed(false);
      return;
    }

    const controller = new AbortController();

    const timer = setTimeout(() => {
      setIsSearching(true);
      setFailed(false);

      searchCards(boardId, query, controller.signal)
        .then((cards) => {
          setResults(cards);
          setIsSearching(false);
        })
        .catch((err) => {
          // A superseded request is expected, not a failure — leave the
          // previous state alone so the newer request owns the outcome.
          if (err?.name === "CanceledError" || err?.name === "AbortError" || controller.signal.aborted) {
            return;
          }
          setResults([]);
          setIsSearching(false);
          setFailed(true);
        });
    }, debounceMs);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [boardId, query, debounceMs, minChars]);

  return { results, isSearching, failed };
}
