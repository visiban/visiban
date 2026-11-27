import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SetURLSearchParams } from "react-router-dom";
import { useLiveAnnouncer } from "./useLiveAnnouncer";
import type { Card, Column, CustomFieldDefinition, Swimlane, SwimlaneCustomFieldDefinition } from "../types";
import {
  laneSortOptions,
  parseLaneSortParams,
  sortLanes,
  writeLaneSortParams,
  type LaneSort,
  type LaneSortContext,
  type LaneSortOption,
} from "../utils/laneSort";

/** A fallback the Lanes control says out loud (#2698 empty and error states). */
export type LaneSortNotice =
  | { kind: "deleted"; field: string }
  | { kind: "then_deleted"; field: string }
  | { kind: "cant_use" };

interface Args {
  /** Every lane, in board order. */
  swimlanes: readonly Swimlane[];
  laneFieldDefs: readonly SwimlaneCustomFieldDefinition[];
  cardFieldDefs: readonly CustomFieldDefinition[];
  isAdmin: boolean;
  cards: readonly Card[];
  columns: readonly Column[];
  /** The cards the board shows; null when no card filter is on. */
  shownCardIds: ReadonlySet<number> | null;
  /** The board page's own `useSearchParams()` pair (one router subscription per page). */
  searchParams: URLSearchParams;
  setSearchParams: SetURLSearchParams;
}

export interface LaneSortState {
  /** The sort in effect, resolved against this board; null = board order. */
  sort: LaneSort | null;
  options: LaneSortOption[];
  /** Option keys no lane has a value for ("No values yet"). */
  emptyKeys: ReadonlySet<string>;
  /** Every lane in this viewer's order. Equals `swimlanes` when no sort is on. */
  ordered: Swimlane[];
  noValueIds: ReadonlySet<number>;
  noValuesYet: boolean;
  setSort: (next: LaneSort | null) => void;
  notice: LaneSortNotice | null;
  dismissNotice: () => void;
  ctx: LaneSortContext;
  /** Pin or unpin a lane (from the popover or the band) and announce it. */
  togglePin: (lane: Swimlane) => void;
  /** The polite announcement text for the Lanes control's live region. */
  message: string;
  announce: (text: string) => void;
}

/**
 * The per-viewer lane sort (#2698), carried in the board URL.
 *
 * Never writes to the server or to browser storage: a sort is a view, and
 * `Swimlane.position` changes only through manual reorder. The URL is
 * replaced, not pushed, and defaults are never written (#2318 conventions),
 * so a reload or a copied link opens the same sort and Back still leaves the
 * board. A key this board cannot resolve falls back to the board order and
 * says why, once.
 */
export function useLaneSort({ swimlanes, laneFieldDefs, cardFieldDefs, isAdmin, cards, columns, shownCardIds, searchParams, setSearchParams }: Args): LaneSortState {
  const requested = useMemo(() => parseLaneSortParams(searchParams), [searchParams]);
  const options = useMemo(() => laneSortOptions(laneFieldDefs, cardFieldDefs, isAdmin), [laneFieldDefs, cardFieldDefs, isAdmin]);
  const [notice, setNotice] = useState<LaneSortNotice | null>(null);

  // Last label seen per key, so a field deleted while the viewer is looking can be named.
  const labels = useRef(new Map<string, string>());
  for (const o of options) labels.current.set(o.key, o.label);

  const setSort = useCallback((next: LaneSort | null) => {
    setSearchParams((prev) => writeLaneSortParams(new URLSearchParams(prev), next), { replace: true });
  }, [setSearchParams]);

  const mainOk = requested ? options.some((o) => o.key === requested.key) : true;
  const thenOk = requested?.then ? options.some((o) => o.key === requested.then) : true;

  useEffect(() => {
    if (!requested) return;
    if (!mainOk) {
      const label = labels.current.get(requested.key);
      // A known field that vanished was deleted; a key this viewer never had
      // (admin-only for a member, or unknown to this board) "can't be used".
      setNotice(label ? { kind: "deleted", field: label } : { kind: "cant_use" });
      setSort(null);
    } else if (!thenOk && requested.then) {
      const label = labels.current.get(requested.then);
      if (label) setNotice({ kind: "then_deleted", field: label });
      setSort({ ...requested, then: null });
    }
  }, [requested, mainOk, thenOk, setSort]);

  const sort = useMemo<LaneSort | null>(() => {
    if (!requested || !mainOk) return null;
    const laneIds = new Set(swimlanes.map((l) => l.id));
    return { ...requested, then: thenOk ? requested.then : null, pins: requested.pins.filter((id) => laneIds.has(id)) };
  }, [requested, mainOk, thenOk, swimlanes]);

  const ctx = useMemo<LaneSortContext>(() => ({ cards, columns, shownCardIds }), [cards, columns, shownCardIds]);

  const result = useMemo(() => (sort ? sortLanes(swimlanes, sort, options, ctx) : null), [sort, swimlanes, options, ctx]);

  const emptyKeys = useMemo(() => {
    const out = new Set<string>();
    for (const o of options) {
      if (o.alwaysHasValue) continue;
      if (sortLanes(swimlanes, { key: o.key, reverse: false, then: null, emptyFirst: false, pins: [], keepSorted: true }, [o], ctx).noValuesYet) out.add(o.key);
    }
    return out;
  }, [options, swimlanes, ctx]);

  const { message, announce } = useLiveAnnouncer();
  const togglePin = useCallback((lane: Swimlane) => {
    if (!sort) return;
    const pinned = sort.pins.includes(lane.id);
    setSort({ ...sort, pins: pinned ? sort.pins.filter((id) => id !== lane.id) : [...sort.pins, lane.id] });
    announce(pinned ? `${lane.name} unpinned.` : `${lane.name} pinned to the top.`);
  }, [sort, setSort, announce]);

  // A notice about a sort that no longer applies goes away once a new sort is chosen.
  const dismissNotice = useCallback(() => setNotice(null), []);

  return {
    sort,
    options,
    emptyKeys,
    ordered: result ? result.ordered : [...swimlanes],
    noValueIds: result?.noValueIds ?? new Set(),
    noValuesYet: result?.noValuesYet ?? false,
    setSort,
    notice,
    dismissNotice,
    ctx,
    togglePin,
    message,
    announce,
  };
}
