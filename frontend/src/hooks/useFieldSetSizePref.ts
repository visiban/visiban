import { useCallback, useState } from "react";
import type { FieldSetSize } from "../types";

/**
 * Per-viewer field set block sizes (#2570), saved per card-set pair in
 * localStorage. No server preference: a size is a personal view choice.
 *
 * Key `user:prefs:field-set-sizes:{userId}:{boardId}`; value
 * `{"{cardId}:{setUid|_other}": {"s": size, "o": lastOpen}}`. Keyed by uid, so
 * a rename changes nothing. On load, entries for set uids that no longer exist
 * are pruned and only the newest `MAX_ENTRIES` are kept (insertion order is
 * write order). Malformed JSON reads as empty.
 */
export const MAX_ENTRIES = 500;
const SIZES: FieldSetSize[] = ["collapsed", "summary", "expanded"];

export interface SizeEntry { s: FieldSetSize; o?: Exclude<FieldSetSize, "collapsed"> }
type Store = Record<string, SizeEntry>;

export function fieldSetSizeKey(userId: number | string, boardId: number): string {
  return `user:prefs:field-set-sizes:${userId}:${boardId}`;
}

function isEntry(v: unknown): v is SizeEntry {
  if (!v || typeof v !== "object") return false;
  const e = v as Record<string, unknown>;
  return SIZES.includes(e.s as FieldSetSize) && (e.o === undefined || (e.o !== "collapsed" && SIZES.includes(e.o as FieldSetSize)));
}

export function loadSizes(key: string, liveKeys: Set<string> | null): Store {
  let parsed: unknown;
  try {
    parsed = JSON.parse(localStorage.getItem(key) ?? "{}");
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const entries = Object.entries(parsed as Record<string, unknown>).filter(([k, v]) => {
    if (!isEntry(v)) return false;
    const setKey = k.slice(k.indexOf(":") + 1);
    return liveKeys === null || liveKeys.has(setKey);
  }) as [string, SizeEntry][];
  return Object.fromEntries(entries.slice(-MAX_ENTRIES));
}

function save(key: string, store: Store): void {
  try {
    localStorage.setItem(key, JSON.stringify(store));
  } catch {
    // localStorage unavailable (private browsing, quota) — the choice lasts this session only.
  }
}

export function useFieldSetSizePref(userId: number | string | null | undefined, boardId: number, liveSetKeys: string[]) {
  const key = fieldSetSizeKey(userId ?? "anon", boardId);
  const [store, setStore] = useState<Store>(() => {
    const pruned = loadSizes(key, new Set(liveSetKeys));
    save(key, pruned);
    return pruned;
  });

  const get = useCallback((cardId: number, setKey: string): SizeEntry | undefined => store[`${cardId}:${setKey}`], [store]);

  const set = useCallback((cardId: number, setKey: string, entry: SizeEntry) => {
    setStore((prev) => {
      const k = `${cardId}:${setKey}`;
      const { [k]: _old, ...rest } = prev;
      void _old;
      const next = Object.fromEntries(Object.entries({ ...rest, [k]: entry }).slice(-MAX_ENTRIES));
      save(key, next);
      return next;
    });
  }, [key]);

  /** Delete this card's overrides, so every block returns to the board default. */
  const resetCard = useCallback((cardId: number) => {
    setStore((prev) => {
      const next = Object.fromEntries(Object.entries(prev).filter(([k]) => !k.startsWith(`${cardId}:`)));
      save(key, next);
      return next;
    });
  }, [key]);

  return { get, set, resetCard };
}
